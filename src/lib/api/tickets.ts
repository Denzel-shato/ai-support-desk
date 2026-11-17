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
  /** Per-field validation messages from a rejected form submission. */
  readonly fields: Record<string, string>;

  constructor(
    message: string,
    options: {
      code: TicketsErrorCode | string;
      status?: number | null;
      missing?: string[];
      fields?: Record<string, string>;
    },
  ) {
    super(message);
    this.name = "TicketsApiError";
    this.code = options.code;
    this.status = options.status ?? null;
    this.missing = options.missing ?? [];
    this.fields = options.fields ?? {};
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

/**
 * A 401 means the session expired or was never there: send the browser to the
 * sign-in page (then back here) instead of showing a confusing error.
 */
export function redirectIfSignedOut(response: Response): void {
  if (response.status !== 401 || typeof window === "undefined") return;
  const here = window.location.pathname + window.location.search;
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload on purpose: clears client state and re-runs the sign-in gate
  window.location.href = `/login?next=${encodeURIComponent(here)}`;
}

export async function requestJson(
  url: string,
  signal?: AbortSignal,
): Promise<{ body: unknown; status: number; truncated: boolean }> {
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

  return {
    body,
    status: response.status,
    truncated: response.headers.get("X-Result-Truncated") === "true",
  };
}

export async function fetchTickets(
  signal?: AbortSignal,
): Promise<{ tickets: SupportTicketRecord[]; truncated: boolean }> {
  const { body, status, truncated } = await requestJson("/api/tickets", signal);

  if (!Array.isArray(body)) {
    throw new TicketsApiError("The server returned data in an unexpected format.", {
      code: "invalid_response",
      status,
    });
  }

  return { tickets: body as SupportTicketRecord[], truncated };
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
