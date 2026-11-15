import type { ApiErrorBody, SupportTicketRecord } from "@/lib/types";

/**
 * Browser-side client for GET /api/tickets. Pure fetching: no React and no
 * data shaping (that lives in lib/overview.ts).
 */

export type TicketsErrorCode =
  | "network_error"
  | "invalid_response"
  | "ticket_not_found"
  | "invalid_ticket_id"
  | "firebase_not_configured"
  | "firestore_timeout"
  | "firestore_permission_denied"
  | "firestore_not_found"
  | "firestore_unavailable"
  | "firestore_error"
  | "unknown_error";

export class TicketsApiError extends Error {
  readonly code: TicketsErrorCode | string;
  readonly status: number | null;
  /** Names (never values) of missing server environment variables. */
  readonly missing: string[];

  constructor(
    message: string,
    options: {
      code: TicketsErrorCode | string;
      status?: number | null;
      missing?: string[];
    },
  ) {
    super(message);
    this.name = "TicketsApiError";
    this.code = options.code;
    this.status = options.status ?? null;
    this.missing = options.missing ?? [];
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

export async function requestJson(
  url: string,
  signal?: AbortSignal,
): Promise<{ body: unknown; status: number }> {
  let response: Response;
  try {
    response = await fetch(url, { cache: "no-store", signal });
  } catch (error) {
    if (signal?.aborted) throw error; // let the caller ignore cancelled requests
    throw new TicketsApiError(
      "Couldn't reach the dashboard server. Check your connection and try again.",
      { code: "network_error" },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

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

export async function fetchTickets(
  signal?: AbortSignal,
): Promise<SupportTicketRecord[]> {
  const { body, status } = await requestJson("/api/tickets", signal);

  if (!Array.isArray(body)) {
    throw new TicketsApiError("The server returned data in an unexpected format.", {
      code: "invalid_response",
      status,
    });
  }

  return body as SupportTicketRecord[];
}

/** Fetches one ticket by Firestore document ID. 404s surface as `ticket_not_found`. */
export async function fetchTicket(
  id: string,
  signal?: AbortSignal,
): Promise<SupportTicketRecord> {
  const { body, status } = await requestJson(
    `/api/tickets/${encodeURIComponent(id)}`,
    signal,
  );

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new TicketsApiError("The server returned data in an unexpected format.", {
      code: "invalid_response",
      status,
    });
  }

  return body as SupportTicketRecord;
}
