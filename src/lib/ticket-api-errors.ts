import "server-only";

import { NextResponse } from "next/server";
import { FirebaseConfigError } from "./firebase-admin";
import {
  InvalidTicketIdError,
  TicketNotFoundError,
  TicketsTimeoutError,
} from "./firestore-tickets";
import type { ApiErrorBody } from "./types";

const NO_STORE = { "Cache-Control": "no-store" };

export function errorResponse(
  status: number,
  code: string,
  message: string,
  extra: Partial<ApiErrorBody["error"]> = {},
) {
  const body: ApiErrorBody = { error: { code, message, ...extra } };
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** gRPC status code from a Firestore error, if it has one. */
function grpcCode(error: unknown): number | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : null;
}

/**
 * Maps any error thrown while reading tickets to a JSON error response.
 * Shared by GET /api/tickets and GET /api/tickets/[id] so both report
 * problems identically.
 */
export function ticketsErrorResponse(error: unknown, logLabel: string) {
  if (error instanceof FirebaseConfigError) {
    return errorResponse(503, "firebase_not_configured", error.message, {
      missing: error.missing,
    });
  }
  if (error instanceof InvalidTicketIdError) {
    return errorResponse(400, "invalid_ticket_id", error.message);
  }
  if (error instanceof TicketNotFoundError) {
    return errorResponse(
      404,
      "ticket_not_found",
      "No ticket exists with that ID. It may have been deleted, or the link may be wrong.",
    );
  }
  if (error instanceof TicketsTimeoutError) {
    return errorResponse(
      504,
      "firestore_timeout",
      "Firestore took too long to respond. Check your network connection and try again.",
    );
  }

  // Log the full error on the server only; never send it to the browser.
  console.error(`[${logLabel}] Failed to read from Firestore:`, error);

  switch (grpcCode(error)) {
    case 7: // PERMISSION_DENIED
    case 16: // UNAUTHENTICATED
      return errorResponse(
        500,
        "firestore_permission_denied",
        "Firestore rejected the service account. Check that the credentials belong to project ai-support-desk-9c4ed and that the account can read Firestore.",
      );
    case 5: // NOT_FOUND
      return errorResponse(
        500,
        "firestore_not_found",
        "The Firestore database was not found. Check that Firestore is enabled for the project.",
      );
    case 14: // UNAVAILABLE
    case 4: // DEADLINE_EXCEEDED
      return errorResponse(
        503,
        "firestore_unavailable",
        "Firestore is temporarily unreachable. Try again in a moment.",
      );
    default:
      return errorResponse(
        500,
        "firestore_error",
        "Something went wrong while reading tickets from Firestore.",
      );
  }
}

export { NO_STORE };
