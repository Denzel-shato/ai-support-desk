import { approvalRequired } from "./overview";
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
 *  - `responseStatus` email delivery:
 *        draft    nothing has been sent
 *        sending  the dashboard claimed the send and is calling n8n right now
 *        queued   n8n accepted the request but has not confirmed delivery
 *        sent     n8n confirmed delivery ({ "status": "sent" })
 *        failed   it is known NOT to have been delivered (safe to try again)
 *        unknown  the outcome can't be established (timeout, dropped
 *                 connection, 5xx, a claim that never recorded an answer).
 *                 The email MAY have been delivered, so it is never retried
 *                 automatically: an agent checks, then confirms or resends.
 *
 * Nothing here can promise exactly-once delivery: Gmail and Firestore are
 * separate systems. What it guarantees is that the dashboard never sends the
 * same message twice without an explicit, informed decision, and that it
 * hands n8n a stable idempotency key so the workflow can de-duplicate too.
 *
 * `aiResponse` and `customerResponse` are never written. The agent's edit lives
 * in `finalResponse`.
 */

/* -------------------------------------------------------------------------- */
/*  Constants                                                                 */
/* -------------------------------------------------------------------------- */

export const MAX_RESPONSE_LENGTH = 10_000;

/**
 * A "sending" claim older than this never recorded an answer (the server
 * stopped between calling n8n and saving the result, or Firestore failed
 * afterwards). Its outcome is therefore UNKNOWN, not failed. The send route
 * gives n8n 25 s, so two minutes is well past any live attempt.
 */
export const STALE_SENDING_MS = 2 * 60_000;

/** Fields stored as Firestore Timestamps. The pure layer deals in ISO strings. */
export const TIMESTAMP_FIELDS = ["responseSentAt", "responseQueuedAt"] as const;

export type ReconcileOutcome = "delivered" | "not_delivered";
export const RECONCILE_OUTCOMES: readonly ReconcileOutcome[] = [
  "delivered",
  "not_delivered",
];

export const TIMEOUT_MESSAGE =
  "No confirmation came back from the email workflow in time. The email may or may not have been delivered, so check before sending again.";

export const UNKNOWN_MESSAGE =
  "The email workflow's answer didn't settle whether the email was delivered. It may or may not have been sent, so check before sending again.";

export const UNCONFIRMED_MESSAGE =
  "A previous attempt may already have been delivered. Check the customer's mail (or the n8n execution log), then mark it as delivered, or confirm that you want to send it again.";

/* -------------------------------------------------------------------------- */
/*  Types and errors                                                          */
/* -------------------------------------------------------------------------- */

export type ReviewStatus = "awaiting_review" | "approved" | "rejected";
export type ResponseStatus =
  | "draft"
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "unknown";
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

export { approvalRequired };

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
  return k === "draft" ||
    k === "queued" ||
    k === "sending" ||
    k === "sent" ||
    k === "failed" ||
    k === "unknown"
    ? k
    : null;
}

/**
 * The status to act on. A "sending" claim that is older than STALE_SENDING_MS
 * never recorded an answer, so its outcome is "unknown" (never "failed").
 * `claimedAt` is an ISO string (or null).
 */
export function effectiveStatus(
  status: ResponseStatus | null,
  claimedAt: string | null,
  nowMs: number,
): ResponseStatus | null {
  if (status !== "sending") return status;
  if (!claimedAt) return "unknown";
  const ms = Date.parse(claimedAt);
  return Number.isNaN(ms) || nowMs - ms >= STALE_SENDING_MS ? "unknown" : "sending";
}

/** Statuses where an email may have gone out and nothing has settled it. */
export function needsReconciliation(status: ResponseStatus | null): boolean {
  return status === "queued" || status === "unknown";
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
  /** Delivery status, with a stale "sending" shown as "unknown". */
  responseStatus: ResponseStatus | null;
  sentAt: string | null;
  sentAtLabel: string | null;
  error: string | null;
  /** A valid single customer email address, or null. */
  recipient: string | null;
  customerName: string | null;
  /** Sent, sending, queued or unknown: the text can't be edited or re-decided. */
  locked: boolean;
  /** An email may have gone out and nothing has settled it: reconcile first. */
  needsReconciliation: boolean;
}

export function buildResponseWorkspace(
  t: SupportTicketRecord,
  nowMs: number = Date.now(),
): ResponseWorkspaceView {
  const original = pickOriginalAiResponse(t);
  const savedFinal = clean(t.finalResponse);
  const responseStatus = effectiveStatus(
    normalizeResponseStatus(t.responseStatus),
    toIsoOrNull(t.responseQueuedAt),
    nowMs,
  );
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
    locked:
      responseStatus === "sent" ||
      responseStatus === "sending" ||
      responseStatus === "queued" ||
      responseStatus === "unknown",
    needsReconciliation: needsReconciliation(responseStatus),
  };
}

/**
 * Why the send button is unavailable, or null when sending is allowed.
 * Mirrors the server's checks so the interface explains instead of failing.
 * (When `needsReconciliation` is true the UI offers the reconcile actions
 * instead of a plain send.)
 */
export function sendBlockedReason(
  view: ResponseWorkspaceView,
  editorText: string,
): string | null {
  if (!view.approvalRequired) return NOT_REQUIRED_MESSAGE;
  if (view.responseStatus === "sent") {
    return "This response has already been sent.";
  }
  if (view.responseStatus === "sending") {
    return "This response is being sent right now.";
  }
  if (view.needsReconciliation) return UNCONFIRMED_MESSAGE;
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

function claimedAt(raw: RawDoc): string | null {
  return toIsoOrNull(raw.responseQueuedAt);
}

function currentStatus(raw: RawDoc, nowMs: number): ResponseStatus | null {
  return effectiveStatus(normalizeResponseStatus(raw.responseStatus), claimedAt(raw), nowMs);
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
 * Decisions are refused once an email may exist for the text: sent, being sent,
 * or with an unsettled outcome (queued / unknown). Changing the saved text
 * discards earlier delivery state (a failed attempt, its error and send key),
 * because that state was about different text.
 */
export function decideReviewUpdate(
  raw: RawDoc,
  action: ReviewAction,
  finalResponse: string | undefined,
  nowMs: number,
): Record<string, unknown> {
  assertApprovalApplies(raw);
  const status = currentStatus(raw, nowMs);
  if (status === "sent") {
    throw new ResponseWorkflowError(
      409,
      "response_already_sent",
      "This response has already been sent, so it can no longer be changed.",
    );
  }
  if (status === "sending") {
    throw new ResponseWorkflowError(
      409,
      "send_in_progress",
      "This response is being sent right now. Wait for that to finish before changing it.",
    );
  }
  if (needsReconciliation(status)) {
    throw new ResponseWorkflowError(
      409,
      "delivery_unconfirmed",
      "An earlier attempt to send this response may have been delivered. Mark it as delivered, or confirm it wasn't, before changing it.",
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
      fields.responseAttempts = 0;
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
  /** Stable for this text: identical on every retry, so n8n can recognise a repeat. */
  idempotencyKey: string;
  /** 1 for the first attempt, then 2, 3 ... */
  attempt: number;
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

export interface SendOptions {
  /**
   * The agent has seen that an earlier attempt's outcome is unknown and
   * accepts the risk of a duplicate email. Without it, such a ticket can't be
   * sent again.
   */
  retryUnknown?: boolean;
}

/**
 * Decides whether a send may start, using only what is stored on the ticket:
 * the recipient and the text come from Firestore, never from the browser.
 * Throws a ResponseWorkflowError describing why not.
 *
 *  sent                   refused: it can't be sent twice
 *  sending (fresh)        refused: another request holds the claim
 *  queued / unknown       refused unless `retryUnknown` (an email may exist)
 *  draft / failed         allowed (failed = known not delivered)
 */
export function decideSendClaim(
  raw: RawDoc,
  nowMs: number,
  nowIso: string,
  newKey: () => string,
  options: SendOptions = {},
): SendClaim {
  assertApprovalApplies(raw);
  const status = currentStatus(raw, nowMs);

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
  if (status === "sending") {
    throw new ResponseWorkflowError(
      409,
      "send_in_progress",
      "This response is already being sent. Wait a moment, then check its status.",
    );
  }
  if (needsReconciliation(status) && !options.retryUnknown) {
    throw new ResponseWorkflowError(409, "delivery_unconfirmed", UNCONFIRMED_MESSAGE);
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
  const previousAttempts =
    typeof raw.responseAttempts === "number" && raw.responseAttempts > 0
      ? Math.floor(raw.responseAttempts)
      : 0;
  const attempt = previousAttempts + 1;

  return {
    fields: {
      responseStatus: "sending",
      responseQueuedAt: nowIso,
      responseSendId: idempotencyKey,
      responseAttempts: attempt,
      responseError: null,
    },
    idempotencyKey,
    attempt,
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
  /** n8n said the email was sent. */
  | { kind: "sent"; sentAt: string | null; messageId: string | null }
  /** Known NOT delivered: n8n said so, or rejected the request outright. */
  | { kind: "failed"; message: string }
  /** Can't be established: a timeout, a dropped connection, a 5xx. */
  | { kind: "unknown"; message: string }
  /** A 2xx that doesn't say the email was sent: accepted, not confirmed. */
  | { kind: "accepted" };

/**
 * "Sent" requires n8n to say so explicitly: HTTP 2xx AND `{ "status": "sent" }`.
 * A bare 200 (n8n's default "Workflow was started" reply, or a Respond node
 * placed before the Gmail node) proves nothing, so it stays "accepted".
 *
 * An error status is only "failed" (safe to retry) when it shows the request
 * was refused before any email could be sent: 4xx other than 408. A 5xx or a
 * 408 can come from a workflow that sent the email and then errored (or from
 * a gateway in front of one), so it is "unknown". An explicit
 * `{ "status": "failed" }` or `{ "status": "unknown" }` from the workflow is
 * authoritative.
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

  if (bodyStatus === "failed") {
    return {
      kind: "failed",
      message: bodyError ?? "The email workflow reported that sending failed.",
    };
  }
  if (bodyStatus === "unknown") {
    // The workflow itself says it can't tell (e.g. it finds a send claim from
    // an earlier attempt that never finished). Authoritative, any HTTP status.
    return { kind: "unknown", message: bodyError ?? UNKNOWN_MESSAGE };
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    if (httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408) {
      return {
        kind: "failed",
        message:
          bodyError ??
          `The email workflow refused the request (HTTP ${httpStatus}), so nothing was sent.`,
      };
    }
    return {
      kind: "unknown",
      message:
        `The email workflow answered with an error (HTTP ${httpStatus}) that doesn't show whether the email was sent. ` +
        "It may or may not have been delivered, so check before sending again.",
    };
  }
  if (bodyStatus === "sent") {
    return {
      kind: "sent",
      sentAt: obj ? toIsoOrNull(obj.sentAt) : null,
      messageId: obj ? shortText(obj.messageId, 200) : null,
    };
  }
  return { kind: "accepted" };
}

/**
 * The fields to write once n8n has answered, or null to write nothing. The
 * record is only written while this attempt's claim is still "sending":
 *  - a newer attempt (different key, or the same key with a higher attempt
 *    number) is never overwritten;
 *  - a ticket already "sent" is never changed, so a late failure can't undo a
 *    delivery n8n recorded first;
 *  - a ticket an agent already reconciled is left as they set it.
 */
export function decideSendRecord(
  raw: RawDoc,
  idempotencyKey: string,
  outcome: WebhookOutcome,
  nowIso: string,
  attempt?: number,
): Record<string, unknown> | null {
  if (clean(raw.responseSendId) !== idempotencyKey) return null;
  if (normalizeResponseStatus(raw.responseStatus) !== "sending") return null;
  // A retry reuses the key, so the key alone can't tell attempt 1's late
  // answer from attempt 2's claim. The attempt number can.
  if (attempt !== undefined && raw.responseAttempts !== attempt) return null;

  switch (outcome.kind) {
    case "accepted":
      return { responseStatus: "queued", responseError: null };
    case "sent":
      return {
        responseStatus: "sent",
        responseSentAt: outcome.sentAt ?? nowIso,
        responseError: null,
      };
    case "unknown":
      return { responseStatus: "unknown", responseError: outcome.message };
    case "failed":
      return { responseStatus: "failed", responseError: outcome.message };
  }
}

/* -------------------------------------------------------------------------- */
/*  Reconciling an unsettled send                                             */
/* -------------------------------------------------------------------------- */

export function parseReconcileRequest(body: unknown): ReconcileOutcome {
  const obj = (typeof body === "object" && body !== null ? body : {}) as RawDoc;
  const outcome = RECONCILE_OUTCOMES.find((o) => o === obj.outcome);
  if (!outcome) {
    throw new ResponseWorkflowError(
      400,
      "invalid_outcome",
      'The outcome must be "delivered" or "not_delivered".',
    );
  }
  return outcome;
}

/** The unsettled states an agent may resolve by hand. */
export function assertCanReconcile(status: ResponseStatus | null): void {
  if (status === "sent") {
    throw new ResponseWorkflowError(
      409,
      "already_sent",
      "This is already recorded as sent.",
    );
  }
  if (status === "sending") {
    throw new ResponseWorkflowError(
      409,
      "send_in_progress",
      "It is still being sent. Wait for the result before recording an outcome.",
    );
  }
  if (!needsReconciliation(status)) {
    throw new ResponseWorkflowError(
      409,
      "nothing_to_reconcile",
      "There is no unsettled send to resolve.",
    );
  }
}

export const AGENT_NOT_DELIVERED_MESSAGE =
  "An agent confirmed this email was not delivered.";

/**
 * An agent checked (the customer's mail, the n8n execution log) and states what
 * happened. "delivered" records it as sent, flagged as agent-confirmed;
 * "not_delivered" records it as failed, which makes a normal resend possible.
 */
export function decideTicketReconcile(
  raw: RawDoc,
  outcome: ReconcileOutcome,
  nowMs: number,
  nowIso: string,
): Record<string, unknown> {
  assertApprovalApplies(raw);
  assertCanReconcile(currentStatus(raw, nowMs));
  return outcome === "delivered"
    ? {
        responseStatus: "sent",
        responseSentAt: nowIso,
        responseError: null,
        responseConfirmedBy: "agent",
      }
    : { responseStatus: "failed", responseError: AGENT_NOT_DELIVERED_MESSAGE };
}
