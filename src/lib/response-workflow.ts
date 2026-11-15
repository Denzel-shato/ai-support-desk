import { normalizePriority } from "./overview";
import { formatDateTime } from "./ticket-detail";
import { toIsoOrNull } from "./ticket-serialization";
import type { SupportTicketRecord } from "./types";

/**
 * Rules for the AI response review and sending workflow.
 *
 * Pure: no React, no Firebase, no fetching, and no clock (callers pass `now`).
 * It is imported by both the server (API routes, Firestore writes) and the
 * browser (the response workspace), so the two always agree on what is allowed.
 *
 * Two separate fields describe a response:
 *  - `reviewStatus`   the agent's decision: awaiting_review | approved | rejected
 *  - `responseStatus` email delivery:       draft | queued | sent | failed
 *
 * `aiResponse` and `customerResponse` are never written. The agent's edit lives
 * in `finalResponse`.
 */

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

export const MAX_RESPONSE_LENGTH = 10_000;

/**
 * A send that has been "queued" for longer than this is treated as stuck
 * (for example the server stopped before it heard back from n8n), so the agent
 * can retry or change the response. Within this window a second send is refused.
 */
export const STALE_QUEUE_MS = 2 * 60_000;

/** Fields stored as Firestore Timestamps. The pure layer deals in ISO strings. */
export const TIMESTAMP_FIELDS = ["responseSentAt", "responseQueuedAt"] as const;

export const TIMEOUT_MESSAGE =
  "No confirmation came back from the email workflow in time. The email may or may not have been delivered, so check before sending again.";

/* -------------------------------------------------------------------------- */
/*  Types and errors                                                          */
/* -------------------------------------------------------------------------- */

export type ReviewStatus = "awaiting_review" | "approved" | "rejected";
export type ResponseStatus = "draft" | "queued" | "sent" | "failed";
export type ReviewAction = "approve" | "reject" | "reopen";

export const REVIEW_ACTIONS: readonly ReviewAction[] = [
  "approve",
  "reject",
  "reopen",
];

/** A rule was broken. `status` is the HTTP status the API answers with. */
export class ResponseWorkflowError extends Error {
  readonly status: number;
  readonly code: string;
  /** Names (never values) of missing environment variables. */
  readonly missing: string[];

  constructor(
    status: number,
    code: string,
    message: string,
    missing: string[] = [],
  ) {
    super(message);
    this.name = "ResponseWorkflowError";
    this.status = status;
    this.code = code;
    this.missing = missing;
  }
}

/** A Firestore document's data as stored (may contain Timestamps). */
type RawDoc = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/*  Priority policy                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Whether the AI response needs a human decision before it can be emailed.
 * Decided by PRIORITY only, never by the stored `reviewStatus` (the n8n
 * normal-handling branch writes "awaiting_review" for Low and Medium tickets
 * too). Low and Medium: no. High and Urgent: yes.
 * A missing or unrecognised priority requires approval: the safe default.
 */
export function approvalRequired(priority: unknown): boolean {
  const p = normalizePriority(priority);
  return p !== "low" && p !== "medium";
}

export const NOT_REQUIRED_MESSAGE =
  "Low and Medium tickets don't use approval. Use a follow-up message to write to the customer.";

function assertApprovalApplies(raw: RawDoc): void {
  if (!approvalRequired(raw.priority)) {
    throw new ResponseWorkflowError(409, "approval_not_required", NOT_REQUIRED_MESSAGE);
  }
}

/* -------------------------------------------------------------------------- */
/*  Normalisation and validation                                              */
/* -------------------------------------------------------------------------- */

function key(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function clean(value: unknown): string | null {
  const s = str(value)?.trim();
  return s ? s : null;
}

export function normalizeReviewStatus(value: unknown): ReviewStatus | null {
  const k = key(value);
  return k === "awaiting_review" || k === "approved" || k === "rejected"
    ? k
    : null;
}

export function normalizeResponseStatus(value: unknown): ResponseStatus | null {
  const k = key(value);
  return k === "draft" || k === "queued" || k === "sent" || k === "failed"
    ? k
    : null;
}

/** The form a response is compared and stored in: LF line endings, trimmed. */
export function normalizeResponseText(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

export type TextValidation =
  | { ok: true; text: string }
  | { ok: false; code: string; message: string };

export function validateResponseText(value: unknown): TextValidation {
  if (typeof value !== "string") {
    return {
      ok: false,
      code: "invalid_response",
      message: "The response must be text.",
    };
  }
  const text = normalizeResponseText(value);
  if (!text) {
    return {
      ok: false,
      code: "empty_response",
      message: "The response can't be empty.",
    };
  }
  if (text.length > MAX_RESPONSE_LENGTH) {
    return {
      ok: false,
      code: "response_too_long",
      message: `The response is too long. The limit is ${MAX_RESPONSE_LENGTH.toLocaleString("en-US")} characters.`,
    };
  }
  return { ok: true, text };
}

const EMAIL_PATTERN = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/;

/**
 * One plain email address, or null. Rejects lists ("a@x.com, b@y.com"),
 * display names and anything with line breaks, so the stored address can
 * never turn one email into several or inject headers.
 */
export function cleanRecipient(value: unknown): string | null {
  const v = str(value)?.trim();
  if (!v || v.length > 254 || /[\r\n]/.test(v)) return null;
  return EMAIL_PATTERN.test(v) ? v : null;
}

function shortText(value: unknown, max = 300): string | null {
  const s = str(value)?.replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/* -------------------------------------------------------------------------- */
/*  Which field is "the AI response"                                          */
/* -------------------------------------------------------------------------- */

export type ResponseSource = "customerResponse" | "aiResponse";

export interface OriginalAiResponse {
  text: string | null;
  source: ResponseSource | null;
  /** The other field, when it holds different text, so nothing is hidden. */
  other: { text: string; source: ResponseSource } | null;
}

function sameText(a: string, b: string): boolean {
  return a.replace(/\s+/g, " ").toLowerCase() === b.replace(/\s+/g, " ").toLowerCase();
}

/**
 * ASSUMPTION: `customerResponse` is the reply written for the customer, and
 * `aiResponse` is the model's output (which may be the same text, or fuller).
 * The editor starts from `customerResponse`, falling back to `aiResponse`.
 * If your workflow stores them the other way round, change only this function.
 * The ticket's other field is still shown (see `other`), never discarded.
 */
export function pickOriginalAiResponse(
  t: Pick<SupportTicketRecord, "customerResponse" | "aiResponse">,
): OriginalAiResponse {
  const customer = clean(t.customerResponse);
  const ai = clean(t.aiResponse);

  if (customer) {
    return {
      text: customer,
      source: "customerResponse",
      other: ai && !sameText(ai, customer) ? { text: ai, source: "aiResponse" } : null,
    };
  }
  if (ai) return { text: ai, source: "aiResponse", other: null };
  return { text: null, source: null, other: null };
}

/* -------------------------------------------------------------------------- */
/*  View model for the workspace                                              */
/* -------------------------------------------------------------------------- */

export interface ResponseWorkspaceView {
  /** False for Low/Medium: read-only AI response, no approve/reject/edit/send. */
  approvalRequired: boolean;
  original: OriginalAiResponse;
  /** The stored `finalResponse` (trimmed), or null. */
  savedFinal: string | null;
  /** Where the editor starts: the saved final response, else the original. */
  baseline: string;
  reviewStatus: ReviewStatus | null;
  responseStatus: ResponseStatus | null;
  sentAt: string | null;
  sentAtLabel: string | null;
  error: string | null;
  /** A valid single customer email address, or null. */
  recipient: string | null;
  customerName: string | null;
  /** Sent or queued: the text can't be edited and decisions can't change. */
  locked: boolean;
}

export function buildResponseWorkspace(
  t: SupportTicketRecord,
): ResponseWorkspaceView {
  const original = pickOriginalAiResponse(t);
  const savedFinal = clean(t.finalResponse);
  const responseStatus = normalizeResponseStatus(t.responseStatus);
  const sentAt = toIsoOrNull(t.responseSentAt);

  return {
    approvalRequired: approvalRequired(t.priority),
    original,
    savedFinal,
    baseline: savedFinal ?? original.text ?? "",
    reviewStatus: normalizeReviewStatus(t.reviewStatus),
    responseStatus,
    sentAt,
    sentAtLabel: formatDateTime(sentAt),
    error: shortText(t.responseError),
    recipient: cleanRecipient(t.customerEmail),
    customerName: clean(t.customerName),
    locked: responseStatus === "sent" || responseStatus === "queued",
  };
}

/**
 * Why the send button is unavailable, or null when sending is allowed.
 * Mirrors the server's checks so the interface explains instead of failing.
 */
export function sendBlockedReason(
  view: ResponseWorkspaceView,
  editorText: string,
): string | null {
  if (!view.approvalRequired) return NOT_REQUIRED_MESSAGE;
  if (view.responseStatus === "sent") {
    return "This response has already been sent.";
  }
  if (view.reviewStatus !== "approved") {
    return "Approve the response before sending it.";
  }
  if (!view.savedFinal) {
    return "There is no approved text to send. Approve the response again.";
  }
  if (normalizeResponseText(editorText) !== view.savedFinal) {
    return "You've edited the response since approving it. Approve again so the edited text is what gets sent.";
  }
  if (!view.recipient) {
    return "This ticket has no valid customer email address.";
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Review transitions                                                        */
/* -------------------------------------------------------------------------- */

function queueIsFresh(raw: RawDoc, nowMs: number): boolean {
  const iso = toIsoOrNull(raw.responseQueuedAt);
  if (!iso) return false; // queued with no usable time: treat as stuck
  return nowMs - Date.parse(iso) < STALE_QUEUE_MS;
}

/** Validates the body of a review request. Throws before any Firestore access. */
export function parseReviewRequest(body: unknown): {
  action: ReviewAction;
  finalResponse: string | undefined;
} {
  const obj = (typeof body === "object" && body !== null ? body : {}) as RawDoc;
  const action = REVIEW_ACTIONS.find((a) => a === obj.action);
  if (!action) {
    throw new ResponseWorkflowError(
      400,
      "invalid_action",
      "The action must be one of: approve, reject, reopen.",
    );
  }

  const provided = obj.finalResponse !== undefined && obj.finalResponse !== null;
  if (action === "approve" || (action === "reopen" && provided)) {
    const v = validateResponseText(obj.finalResponse);
    if (!v.ok) throw new ResponseWorkflowError(422, v.code, v.message);
    return { action, finalResponse: v.text };
  }
  return { action, finalResponse: undefined };
}

/**
 * The Firestore fields to change for a review action. Throws when the ticket's
 * delivery state forbids the change. Only the fields it returns are written, so
 * `aiResponse`, `customerResponse` and everything n8n wrote stay untouched.
 *
 *  approve  saves the text as `finalResponse` and sets reviewStatus "approved".
 *  reject   sets "rejected". Sending is then refused until it is approved again.
 *  reopen   sets "awaiting_review" (submit for review again); saves the text
 *           if one is supplied.
 *
 * Changing the saved text discards any earlier delivery state (failed attempt,
 * error, send key), because that state was about different text.
 */
export function decideReviewUpdate(
  raw: RawDoc,
  action: ReviewAction,
  finalResponse: string | undefined,
  nowMs: number,
): Record<string, unknown> {
  assertApprovalApplies(raw);
  const status = normalizeResponseStatus(raw.responseStatus);
  if (status === "sent") {
    throw new ResponseWorkflowError(
      409,
      "response_already_sent",
      "This response has already been sent, so it can no longer be changed.",
    );
  }
  if (status === "queued" && queueIsFresh(raw, nowMs)) {
    throw new ResponseWorkflowError(
      409,
      "send_in_progress",
      "This response is being sent right now. Wait for that to finish before changing it.",
    );
  }

  const fields: Record<string, unknown> = {
    reviewStatus:
      action === "approve"
        ? "approved"
        : action === "reject"
          ? "rejected"
          : "awaiting_review",
  };

  if (finalResponse !== undefined) {
    const v = validateResponseText(finalResponse);
    if (!v.ok) throw new ResponseWorkflowError(422, v.code, v.message);

    fields.finalResponse = v.text;
    const previous = normalizeResponseText(str(raw.finalResponse) ?? "");
    if (v.text !== previous) {
      fields.responseStatus = "draft";
      fields.responseError = null;
      fields.responseSendId = null;
      fields.responseQueuedAt = null;
    } else if (status === null) {
      fields.responseStatus = "draft";
    }
  }

  return fields;
}

/* -------------------------------------------------------------------------- */
/*  Sending                                                                   */
/* -------------------------------------------------------------------------- */

export interface SendClaim {
  /** Written to the ticket to claim the send (inside a transaction). */
  fields: Record<string, unknown>;
  idempotencyKey: string;
  recipient: string;
  customerName: string | null;
  finalResponse: string;
  context: {
    summary: string | null;
    category: string | null;
    priority: string | null;
    originalMessage: string | null;
    createdAt: string | null;
  };
}

/**
 * Decides whether a send may start, using only what is stored on the ticket:
 * the recipient and the text come from Firestore, never from the browser.
 * Throws a ResponseWorkflowError describing why not.
 */
export function decideSendClaim(
  raw: RawDoc,
  nowMs: number,
  nowIso: string,
  newKey: () => string,
): SendClaim {
  assertApprovalApplies(raw);
  const status = normalizeResponseStatus(raw.responseStatus);

  if (status === "sent") {
    throw new ResponseWorkflowError(
      409,
      "already_sent",
      "This response has already been sent. It can't be sent twice.",
    );
  }
  if (normalizeReviewStatus(raw.reviewStatus) !== "approved") {
    throw new ResponseWorkflowError(
      409,
      "not_approved",
      "Only an approved response can be sent. Approve it first.",
    );
  }
  if (status === "queued" && queueIsFresh(raw, nowMs)) {
    throw new ResponseWorkflowError(
      409,
      "send_in_progress",
      "This response is already being sent. Wait a moment, then check its status.",
    );
  }

  const text = validateResponseText(raw.finalResponse);
  if (!text.ok) {
    throw new ResponseWorkflowError(
      422,
      "no_final_response",
      "There is no approved response text to send. Approve the response again.",
    );
  }

  const recipient = cleanRecipient(raw.customerEmail);
  if (!recipient) {
    throw new ResponseWorkflowError(
      422,
      "customer_email_invalid",
      "This ticket has no valid customer email address, so the response can't be sent.",
    );
  }

  // Reuse the key across retries of the same text so n8n can recognise a repeat.
  const idempotencyKey = clean(raw.responseSendId) ?? newKey();

  return {
    fields: {
      responseStatus: "queued",
      responseQueuedAt: nowIso,
      responseSendId: idempotencyKey,
      responseError: null,
    },
    idempotencyKey,
    recipient,
    customerName: clean(raw.customerName),
    finalResponse: text.text,
    context: {
      summary: clean(raw.summary),
      category: clean(raw.category),
      priority: clean(raw.priority),
      originalMessage: clean(raw.message),
      createdAt: toIsoOrNull(raw.createdAt),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  What n8n answered                                                         */
/* -------------------------------------------------------------------------- */

export type WebhookOutcome =
  | { kind: "sent"; sentAt: string | null; messageId: string | null }
  | { kind: "failed"; message: string }
  | { kind: "timeout" }
  /** A 2xx reply that does not say the email was sent. Not treated as sent. */
  | { kind: "unconfirmed" };

/**
 * "Sent" requires n8n to say so explicitly: HTTP 2xx AND `{ "status": "sent" }`.
 * A bare 200 (n8n's default "Workflow was started" reply, or a Respond node
 * placed before the Gmail node) proves nothing, so it stays "unconfirmed".
 */
export function interpretWebhookResponse(
  httpStatus: number,
  body: unknown,
): WebhookOutcome {
  const unwrapped =
    Array.isArray(body) && body.length === 1 ? body[0] : body;
  const obj =
    typeof unwrapped === "object" && unwrapped !== null && !Array.isArray(unwrapped)
      ? (unwrapped as RawDoc)
      : null;
  const bodyStatus = obj ? key(obj.status) : "";
  const bodyError = obj ? shortText(obj.error) ?? shortText(obj.message) : null;

  if (httpStatus < 200 || httpStatus >= 300) {
    return {
      kind: "failed",
      message: bodyError ?? `The email workflow answered with an error (HTTP ${httpStatus}).`,
    };
  }
  if (bodyStatus === "failed") {
    return {
      kind: "failed",
      message: bodyError ?? "The email workflow reported that sending failed.",
    };
  }
  if (bodyStatus === "sent") {
    return {
      kind: "sent",
      sentAt: obj ? toIsoOrNull(obj.sentAt) : null,
      messageId: obj ? shortText(obj.messageId, 200) : null,
    };
  }
  return { kind: "unconfirmed" };
}

/**
 * The fields to write once n8n has answered, or null to write nothing.
 *  - A newer attempt (different key) is never overwritten.
 *  - A ticket already marked "sent" is never changed, so a late failure can't
 *    undo a delivery that n8n recorded first.
 *  - "unconfirmed" leaves the ticket "queued".
 */
export function decideSendRecord(
  raw: RawDoc,
  idempotencyKey: string,
  outcome: WebhookOutcome,
  nowIso: string,
): Record<string, unknown> | null {
  if (clean(raw.responseSendId) !== idempotencyKey) return null;
  if (normalizeResponseStatus(raw.responseStatus) === "sent") return null;

  switch (outcome.kind) {
    case "unconfirmed":
      return null;
    case "sent":
      return {
        responseStatus: "sent",
        responseSentAt: outcome.sentAt ?? nowIso,
        responseError: null,
      };
    case "timeout":
      return { responseStatus: "failed", responseError: TIMEOUT_MESSAGE };
    case "failed":
      return { responseStatus: "failed", responseError: outcome.message };
  }
}
