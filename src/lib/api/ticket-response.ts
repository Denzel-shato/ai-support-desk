import { redirectIfSignedOut, TicketsApiError } from "@/lib/api/tickets";
import type { FollowUpMessage } from "@/lib/communications";
import type { ReconcileOutcome, ReviewAction } from "@/lib/response-workflow";
import type { ApiErrorBody, SupportTicketRecord } from "@/lib/types";

/**
 * Browser-side client for the review and send routes. It only ever sends the
 * action and the edited text: the server reads the recipient and the approved
 * text from Firestore, so nothing here can change who gets the email.
 */

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

async function post(
  url: string,
  payload: unknown,
): Promise<{ body: unknown; status: number }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch {
    throw new TicketsApiError(
      "Couldn't reach the dashboard server. Check your connection and try again.",
      { code: "network_error" },
    );
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  redirectIfSignedOut(response);
  if (!response.ok) {
    if (isApiErrorBody(body)) {
      throw new TicketsApiError(body.error.message, {
        code: body.error.code,
        status: response.status,
        missing: body.error.missing,
      });
    }
    throw new TicketsApiError(
      `The server returned an unexpected error (HTTP ${response.status}).`,
      { code: "unknown_error", status: response.status },
    );
  }
  return { body, status: response.status };
}

function ticketFrom(body: unknown): SupportTicketRecord | null {
  const t = (body as { ticket?: unknown } | null)?.ticket;
  return typeof t === "object" && t !== null ? (t as SupportTicketRecord) : null;
}

/** Approve, reject or reopen. Returns the updated ticket. */
export async function reviewResponse(
  id: string,
  action: ReviewAction,
  finalResponse?: string,
): Promise<SupportTicketRecord> {
  const { body, status } = await post(
    `/api/tickets/${encodeURIComponent(id)}/review`,
    finalResponse === undefined ? { action } : { action, finalResponse },
  );
  const ticket = ticketFrom(body);
  if (!ticket) {
    throw new TicketsApiError("The server returned data in an unexpected format.", {
      code: "invalid_response",
      status,
    });
  }
  return ticket;
}

export interface SendResult {
  /** "sent": delivery confirmed. "queued": accepted, not yet confirmed. */
  result: "sent" | "queued";
  ticket: SupportTicketRecord | null;
  message?: string;
  warning?: string;
}

/**
 * Asks the server to send the approved response. Throws on failure. Pass
 * `retryUnknown` only after the agent has seen that an earlier attempt's
 * outcome is unsettled and chose to resend anyway (a duplicate is possible).
 */
export async function sendResponse(
  id: string,
  options: { retryUnknown?: boolean } = {},
): Promise<SendResult> {
  const { body, status } = await post(
    `/api/tickets/${encodeURIComponent(id)}/send`,
    options.retryUnknown ? { retryUnknown: true } : {},
  );
  const obj = (body ?? {}) as Record<string, unknown>;
  if (obj.result !== "sent" && obj.result !== "queued") {
    throw new TicketsApiError("The server returned data in an unexpected format.", {
      code: "invalid_response",
      status,
    });
  }
  return {
    result: obj.result,
    ticket: ticketFrom(body),
    message: typeof obj.message === "string" ? obj.message : undefined,
    warning: typeof obj.warning === "string" ? obj.warning : undefined,
  };
}

/** An agent states whether an unsettled send was delivered. */
export async function reconcileSend(
  id: string,
  outcome: ReconcileOutcome,
): Promise<SupportTicketRecord> {
  const { body, status } = await post(
    `/api/tickets/${encodeURIComponent(id)}/reconcile`,
    { outcome },
  );
  const ticket = ticketFrom(body);
  if (!ticket) {
    throw new TicketsApiError("The server returned data in an unexpected format.", {
      code: "invalid_response",
      status,
    });
  }
  return ticket;
}

/* -------------------------------------------------------------------------- */
/*  Follow-ups and communication history                                      */
/* -------------------------------------------------------------------------- */

export async function fetchMessages(
  id: string,
  signal?: AbortSignal,
): Promise<FollowUpMessage[]> {
  let response: Response;
  try {
    response = await fetch(`/api/tickets/${encodeURIComponent(id)}/messages`, {
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new TicketsApiError(
      "Couldn't reach the dashboard server. Check your connection and try again.",
      { code: "network_error" },
    );
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  redirectIfSignedOut(response);
  if (!response.ok) {
    if (isApiErrorBody(body)) {
      throw new TicketsApiError(body.error.message, {
        code: body.error.code,
        status: response.status,
      });
    }
    throw new TicketsApiError(
      `The server returned an unexpected error (HTTP ${response.status}).`,
      { code: "unknown_error", status: response.status },
    );
  }
  const list = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(list)) {
    throw new TicketsApiError("The server returned data in an unexpected format.", {
      code: "invalid_response",
      status: response.status,
    });
  }
  return list as FollowUpMessage[];
}

export interface FollowUpResult {
  result: "sent" | "queued";
  warning?: string;
  note?: string;
}

/**
 * Sends a follow-up. `content` is only needed for a new message; retrying an
 * existing one (same `messageId`) re-sends the stored text on the server.
 */
export async function sendFollowUp(
  ticketId: string,
  messageId: string,
  content?: string,
  options: { retryUnknown?: boolean } = {},
): Promise<FollowUpResult> {
  const payload: Record<string, unknown> = { messageId };
  if (content !== undefined) payload.content = content;
  if (options.retryUnknown) payload.retryUnknown = true;
  const { body, status } = await post(
    `/api/tickets/${encodeURIComponent(ticketId)}/followups`,
    payload,
  );
  const obj = (body ?? {}) as Record<string, unknown>;
  if (obj.result !== "sent" && obj.result !== "queued") {
    throw new TicketsApiError("The server returned data in an unexpected format.", {
      code: "invalid_response",
      status,
    });
  }
  return {
    result: obj.result,
    warning: typeof obj.warning === "string" ? obj.warning : undefined,
    note: typeof obj.note === "string" ? obj.note : undefined,
  };
}

/** An agent states whether an unsettled follow-up was delivered. */
export async function reconcileFollowUpSend(
  ticketId: string,
  messageId: string,
  outcome: ReconcileOutcome,
): Promise<void> {
  await post(
    `/api/tickets/${encodeURIComponent(ticketId)}/followups/${encodeURIComponent(messageId)}/reconcile`,
    { outcome },
  );
}
