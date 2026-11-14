import "server-only";

import {
  interpretWebhookResponse,
  ResponseWorkflowError,
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

  return { url: url.toString(), secret: env[WEBHOOK_SECRET_ENV]?.trim() || null };
}

export interface WebhookPayload {
  ticketId: string;
  idempotencyKey: string;
  customerName: string | null;
  customerEmail: string;
  subject: string;
  finalResponse: string;
  ticket: SendClaim["context"];
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
    idempotencyKey: claim.idempotencyKey,
    customerName: claim.customerName,
    customerEmail: claim.recipient,
    subject: "Re: Your support request",
    finalResponse: claim.finalResponse,
    ticket: claim.context,
    requestedAt,
    source: "ai-support-desk",
  };
}

/**
 * POSTs the payload and interprets the answer. Never throws for network or
 * HTTP problems: they become a "failed" or "timeout" outcome. A "sent" outcome
 * requires n8n to say so explicitly (see interpretWebhookResponse).
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
      return { kind: "timeout" };
    }
    // The message is deliberately generic: error text can contain the URL.
    return {
      kind: "failed",
      message:
        "The email workflow could not be reached. Check that the n8n workflow is active, then retry.",
    };
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
