import {
  AGENT_NOT_DELIVERED_MESSAGE,
  assertCanReconcile,
  cleanRecipient,
  effectiveStatus,
  needsReconciliation,
  normalizeResponseStatus,
  pickOriginalAiResponse,
  ResponseWorkflowError,
  UNCONFIRMED_MESSAGE,
  validateResponseText,
  type ReconcileOutcome,
  type ResponseStatus,
  type SendOptions,
  type WebhookOutcome,
} from "./response-workflow";
import { toIsoOrNull } from "./ticket-serialization";
import type { SupportTicketRecord } from "./types";

/**
 * Follow-up messages and the communication history.
 *
 * Storage: each follow-up is one document in the subcollection
 * `support_tickets/{ticketId}/messages` (document ID = message ID, which is
 * also the idempotency key). One document per message means two follow-ups
 * never contend for the same field, nothing sent is ever rewritten, and old
 * tickets need no migration.
 *
 * The AI response and the final (agent) response stay on the ticket
 * (`aiResponse`/`customerResponse`, `finalResponse`) and are shown in the
 * history as read-only entries built from those fields. Follow-ups never
 * touch those fields or `reviewStatus`/`responseStatus`.
 *
 * Delivery statuses and the unknown-outcome rules are the same as for the
 * initial response (see response-workflow.ts).
 *
 * Pure: no React, no Firebase, no clock (callers pass `nowMs`).
 */

export const MESSAGES_SUBCOLLECTION = "messages";
export const MAX_MESSAGES = 200;

type RawDoc = Record<string, unknown>;

/** Timestamp fields of a message document (stored as Firestore Timestamps). */
export const MESSAGE_TIMESTAMP_FIELDS = ["createdAt", "queuedAt", "sentAt"] as const;

export type MessageType = "ai_response" | "agent_response" | "follow_up";
export type MessageSource = "ai" | "agent";

/** A follow-up as returned by the API. Dates are ISO strings or null. */
export interface FollowUpMessage {
  id: string;
  content: string;
  status: ResponseStatus;
  createdAt: string | null;
  queuedAt: string | null;
  sentAt: string | null;
  error: string | null;
  /** How many times a send was attempted (1 = first try). */
  attempts: number;
}

const MESSAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Message IDs are client-generated UUIDs (the composer's idempotency key). */
export function isValidMessageId(id: unknown): id is string {
  return typeof id === "string" && MESSAGE_ID.test(id);
}

function errText(value: unknown, max = 300): string | null {
  if (typeof value !== "string") return null;
  const s = value.replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Turns a stored message document into the API shape. Tolerates odd data. */
export function toFollowUpMessage(
  id: string,
  raw: RawDoc,
  nowMs: number = Date.now(),
): FollowUpMessage {
  const queuedAt = toIsoOrNull(raw.queuedAt);
  return {
    id,
    content: typeof raw.content === "string" ? raw.content : "",
    // A "sending" claim that never recorded an answer reads as "unknown".
    status: effectiveStatus(normalizeResponseStatus(raw.status), queuedAt, nowMs) ?? "draft",
    attempts:
      typeof raw.attempts === "number" && raw.attempts > 0 ? Math.floor(raw.attempts) : 1,
    createdAt: toIsoOrNull(raw.createdAt),
    queuedAt,
    sentAt: toIsoOrNull(raw.sentAt),
    error: errText(raw.error),
  };
}

/* -------------------------------------------------------------------------- */
/*  Sending a follow-up                                                       */
/* -------------------------------------------------------------------------- */

export interface FollowUpClaim {
  /** "create": new message document. "update": retry of an existing one. */
  mode: "create" | "update";
  fields: Record<string, unknown>;
  /** Equals the message ID. n8n uses it to recognise a repeat. */
  idempotencyKey: string;
  recipient: string;
  customerName: string | null;
  /** The text to send: the stored text on a retry, never a new one. */
  content: string;
  attempt: number;
}

function messageStatus(raw: RawDoc, nowMs: number): ResponseStatus | null {
  return effectiveStatus(normalizeResponseStatus(raw.status), toIsoOrNull(raw.queuedAt), nowMs);
}

/**
 * Decides whether a follow-up may be sent. Uses only stored data: the
 * recipient comes from the ticket, and a retry re-sends the STORED text, so a
 * browser can't alter an existing message. Independent of the ticket's
 * reviewStatus/responseStatus: follow-ups don't need the initial response to
 * be approved or sent.
 */
export function decideFollowUpClaim(
  ticket: RawDoc,
  existing: RawDoc | null,
  messageId: string,
  text: unknown,
  nowMs: number,
  nowIso: string,
  options: SendOptions = {},
): FollowUpClaim {
  const recipient = cleanRecipient(ticket.customerEmail);
  if (!recipient) {
    throw new ResponseWorkflowError(
      422,
      "customer_email_invalid",
      "This ticket has no valid customer email address, so a message can't be sent.",
    );
  }
  const customerName =
    typeof ticket.customerName === "string" && ticket.customerName.trim()
      ? ticket.customerName.trim()
      : null;

  if (!existing) {
    const v = validateResponseText(text);
    if (!v.ok) throw new ResponseWorkflowError(422, v.code, v.message);
    return {
      mode: "create",
      idempotencyKey: messageId,
      recipient,
      customerName,
      content: v.text,
      fields: {
        type: "follow_up",
        source: "agent",
        content: v.text,
        status: "sending",
        attempts: 1,
        createdAt: nowIso,
        queuedAt: nowIso,
        sentAt: null,
        error: null,
      },
      attempt: 1,
    };
  }

  const status = messageStatus(existing, nowMs);
  if (status === "sent") {
    throw new ResponseWorkflowError(
      409,
      "already_sent",
      "This follow-up has already been sent. It can't be sent twice.",
    );
  }
  if (status === "sending") {
    throw new ResponseWorkflowError(
      409,
      "send_in_progress",
      "This follow-up is already being sent. Wait a moment, then check its status.",
    );
  }
  if (needsReconciliation(status) && !options.retryUnknown) {
    throw new ResponseWorkflowError(409, "delivery_unconfirmed", UNCONFIRMED_MESSAGE);
  }
  const stored = validateResponseText(existing.content);
  if (!stored.ok) {
    throw new ResponseWorkflowError(
      422,
      "no_message_content",
      "This follow-up has no stored text to send.",
    );
  }
  const attempt =
    (typeof existing.attempts === "number" && existing.attempts > 0
      ? Math.floor(existing.attempts)
      : 1) + 1;
  return {
    mode: "update",
    idempotencyKey: messageId,
    recipient,
    customerName,
    content: stored.text,
    attempt,
    fields: { status: "sending", queuedAt: nowIso, attempts: attempt, error: null },
  };
}

/**
 * Fields to write once n8n has answered, or null to write nothing. Only a
 * message still in its own "sending" claim is updated: one already "sent",
 * or reconciled by an agent meanwhile, is never changed.
 */
export function decideFollowUpRecord(
  existing: RawDoc | null,
  outcome: WebhookOutcome,
  nowIso: string,
): Record<string, unknown> | null {
  if (!existing) return null;
  if (normalizeResponseStatus(existing.status) !== "sending") return null;
  switch (outcome.kind) {
    case "accepted":
      return { status: "queued", error: null };
    case "sent":
      return { status: "sent", sentAt: outcome.sentAt ?? nowIso, error: null };
    case "unknown":
      return { status: "unknown", error: outcome.message };
    case "failed":
      return { status: "failed", error: outcome.message };
  }
}

/** An agent's statement about an unsettled follow-up (same rules as the ticket's). */
export function decideFollowUpReconcile(
  existing: RawDoc | null,
  outcome: ReconcileOutcome,
  nowMs: number,
  nowIso: string,
): Record<string, unknown> {
  if (!existing) {
    throw new ResponseWorkflowError(404, "message_not_found", "That message no longer exists.");
  }
  assertCanReconcile(messageStatus(existing, nowMs));
  return outcome === "delivered"
    ? { status: "sent", sentAt: nowIso, error: null, confirmedBy: "agent" }
    : { status: "failed", error: AGENT_NOT_DELIVERED_MESSAGE };
}

/* -------------------------------------------------------------------------- */
/*  History                                                                   */
/* -------------------------------------------------------------------------- */

export interface HistoryEntry {
  /** Message ID for follow-ups; "ai-response" / "agent-response" for the ticket's own. */
  id: string;
  type: MessageType;
  source: MessageSource;
  label: string;
  content: string;
  /** Delivery status; null = never emailed (the original AI response). */
  status: ResponseStatus | null;
  createdAt: string | null;
  sentAt: string | null;
  error: string | null;
}

function timeKey(e: HistoryEntry): number {
  const iso = e.sentAt ?? e.createdAt;
  return iso ? Date.parse(iso) : Number.POSITIVE_INFINITY;
}

/**
 * Builds the history from the ticket and its follow-ups. Nothing is stored for
 * the AI and agent responses: they are read from the ticket, so older tickets
 * work unchanged and nothing can drift out of sync.
 *
 *  1. The original AI response (read-only; emailed only if it is the text
 *     that was sent).
 *  2. The final agent response, when one was saved (High/Urgent).
 *  3. Follow-ups, oldest first.
 */
export function buildHistory(
  ticket: SupportTicketRecord,
  followUps: FollowUpMessage[],
  nowMs: number = Date.now(),
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];

  const original = pickOriginalAiResponse(ticket);
  if (original.text) {
    entries.push({
      id: "ai-response",
      type: "ai_response",
      source: "ai",
      label: "AI-generated response",
      content: original.text,
      status: null,
      createdAt: ticket.createdAt ?? null,
      sentAt: null,
      error: null,
    });
  }

  const final =
    typeof ticket.finalResponse === "string" ? ticket.finalResponse.trim() : "";
  if (final) {
    entries.push({
      id: "agent-response",
      type: "agent_response",
      source: "agent",
      label: "Agent response",
      content: final,
      status:
        effectiveStatus(
          normalizeResponseStatus(ticket.responseStatus),
          toIsoOrNull(ticket.responseQueuedAt),
          nowMs,
        ) ?? "draft",
      createdAt: null,
      sentAt: toIsoOrNull(ticket.responseSentAt),
      error: errText(ticket.responseError),
    });
  }

  for (const m of followUps) {
    entries.push({
      id: m.id,
      type: "follow_up",
      source: "agent",
      label: "Follow-up",
      content: m.content,
      status: m.status,
      createdAt: m.createdAt,
      sentAt: m.sentAt,
      error: m.error,
    });
  }

  // The AI response always leads; everything else is chronological.
  const ai = entries.filter((e) => e.type === "ai_response");
  const rest = entries
    .filter((e) => e.type !== "ai_response")
    .sort((a, b) => timeKey(a) - timeKey(b));
  return [...ai, ...rest];
}
