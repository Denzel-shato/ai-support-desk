import "server-only";

import type { FollowUpClaim } from "./communications";
import {
  interpretWebhookResponse,
  ResponseWorkflowError,
  TIMEOUT_MESSAGE,
  UNKNOWN_MESSAGE,
  type SendClaim,
  type WebhookOutcome,
} from "./response-workflow";

/**
 * Calls the n8n "send response" webhook. Server only: the URL and secret never
 * reach the browser, are never logged and are never returned in a response.
 */

export const WEBHOOK_URL_ENV = "N8N_SEND_RESPONSE_WEBHOOK_URL";
export const WEBHOOK_SECRET_ENV = "N8N_SEND_RESPONSE_WEBHOOK_SECRET";
export const WEBHOOK_TIMEOUT_MS = 25_000;

export interface WebhookConfig {
  url: string;
  secret: string | null;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/** Reads and validates the webhook settings. Throws 503 when sending isn't set up. */
export function readWebhookConfig(
  env: Record<string, string | undefined> = process.env,
): WebhookConfig {
  const raw = env[WEBHOOK_URL_ENV]?.trim();
  if (!raw) {
    throw new ResponseWorkflowError(
      503,
      "send_not_configured",
      "Sending is not set up yet. Add the n8n webhook URL to the server environment and restart.",
      [WEBHOOK_URL_ENV],
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ResponseWorkflowError(
      503,
      "send_misconfigured",
      "The n8n webhook URL in the server environment is not a valid URL.",
      [WEBHOOK_URL_ENV],
    );
  }
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && isLoopback(url.hostname));
  if (!secure) {
    throw new ResponseWorkflowError(
      503,
      "send_misconfigured",
      "The n8n webhook URL must use https (http is only allowed for localhost).",
      [WEBHOOK_URL_ENV],
    );
  }

  const secret = env[WEBHOOK_SECRET_ENV]?.trim() || null;
  // In production the webhook must authenticate the dashboard, otherwise
  // anyone who learns the URL could make n8n send email.
  if (!secret && env.NODE_ENV === "production") {
    throw new ResponseWorkflowError(
      503,
      "send_misconfigured",
      "Sending requires a webhook secret in production. Add it to the server environment and to the n8n webhook's header authentication, then restart.",
      [WEBHOOK_SECRET_ENV],
    );
  }

  return { url: url.toString(), secret };
}

export interface WebhookPayload {
  ticketId: string;
  /** "initial_response" (approved High/Urgent reply) or "follow_up". */
  messageType: "initial_response" | "follow_up";
  /** Set for follow-ups: the message document ID. */
  messageId?: string;
  /**
   * Identifies THIS message and is identical on every retry of it. n8n should
   * record it and skip a repeat (see docs/n8n-send-response-workflow.md).
   */
  idempotencyKey: string;
  /** 1 for the first try, higher for retries of the same message. */
  attempt: number;
  customerName: string | null;
  customerEmail: string;
  subject: string;
  /** The email text for BOTH types: point the Gmail node at this field. */
  messageBody: string;
  /** Initial responses only (same text as messageBody; kept for compatibility). */
  finalResponse?: string;
  ticket?: SendClaim["context"];
  requestedAt: string;
  source: "ai-support-desk";
}

/** Everything in the payload comes from the stored ticket, never from the browser. */
export function buildWebhookPayload(
  ticketId: string,
  claim: SendClaim,
  requestedAt: string,
): WebhookPayload {
  return {
    ticketId,
    messageType: "initial_response",
    idempotencyKey: claim.idempotencyKey,
    attempt: claim.attempt,
    customerName: claim.customerName,
    customerEmail: claim.recipient,
    subject: "Re: Your support request",
    messageBody: claim.finalResponse,
    finalResponse: claim.finalResponse,
    ticket: claim.context,
    requestedAt,
    source: "ai-support-desk",
  };
}

/** Payload for a follow-up. Recipient and text come from Firestore. */
export function buildFollowUpPayload(
  ticketId: string,
  claim: FollowUpClaim,
  requestedAt: string,
): WebhookPayload {
  return {
    ticketId,
    messageType: "follow_up",
    messageId: claim.idempotencyKey,
    idempotencyKey: claim.idempotencyKey,
    attempt: claim.attempt,
    customerName: claim.customerName,
    customerEmail: claim.recipient,
    subject: "Re: Your support request",
    messageBody: claim.content,
    requestedAt,
    source: "ai-support-desk",
  };
}

/**
 * Network errors that happen BEFORE any request reached n8n (nothing was
 * sent, so the attempt is a clean failure). Anything else that throws, such as
 * a reset connection, could have happened after n8n started, so it's unknown.
 */
const NOT_DELIVERED_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ERR_INVALID_URL",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function errorCode(error: unknown): string | null {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" ? code : null;
}

/**
 * POSTs the payload (once: never retried here, because a retry after an
 * ambiguous result could send a second email) and classifies the answer.
 * Never throws for network or HTTP problems:
 *  - 2xx + { status: "sent" }          -> sent
 *  - 2xx without that                  -> accepted (queued, unconfirmed)
 *  - explicit failure / 4xx (not 408)  -> failed (known not delivered)
 *  - timeout, reset, 5xx, 408          -> unknown (may have been delivered)
 *  - could not connect at all          -> failed
 */
export async function callSendWebhook(
  config: WebhookConfig,
  payload: WebhookPayload,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<WebhookOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    // n8n can use this to recognise a repeat even before reading the body.
    "Idempotency-Key": payload.idempotencyKey,
  };
  if (config.secret) headers["X-Webhook-Secret"] = config.secret;

  let response: Response;
  try {
    response = await fetchImpl(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? WEBHOOK_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { kind: "unknown", message: TIMEOUT_MESSAGE };
    }
    const code = errorCode(error);
    if (code && NOT_DELIVERED_CODES.has(code)) {
      // The message is deliberately generic: error text can contain the URL.
      return {
        kind: "failed",
        message:
          "The email workflow could not be reached, so nothing was sent. Check that the n8n workflow is active, then retry.",
      };
    }
    return { kind: "unknown", message: UNKNOWN_MESSAGE };
  }

  let body: unknown = null;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null; // non-JSON reply: only the HTTP status is usable
  }
  return interpretWebhookResponse(response.status, body);
}
