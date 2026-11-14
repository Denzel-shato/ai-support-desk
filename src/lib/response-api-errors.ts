import "server-only";

import { FirebaseConfigError } from "./firebase-admin";
import {
  InvalidTicketIdError,
  TicketNotFoundError,
  TicketsTimeoutError,
} from "./firestore-tickets";
import { ResponseWorkflowError } from "./response-workflow";
import { errorResponse, ticketsErrorResponse } from "./ticket-api-errors";

/**
 * Maps errors from the review and send routes to JSON responses. Workflow rule
 * violations carry their own status; config, id, not-found and timeout errors
 * reuse the ticket routes' mapping so every route reports them the same way.
 */
export function responseErrorResponse(error: unknown, logLabel: string) {
  if (error instanceof ResponseWorkflowError) {
    return errorResponse(
      error.status,
      error.code,
      error.message,
      error.missing.length ? { missing: error.missing } : {},
    );
  }
  if (
    error instanceof FirebaseConfigError ||
    error instanceof InvalidTicketIdError ||
    error instanceof TicketNotFoundError ||
    error instanceof TicketsTimeoutError
  ) {
    return ticketsErrorResponse(error, logLabel);
  }

  console.error(`[${logLabel}] Failed to update Firestore:`, error);

  const code = (error as { code?: unknown } | null)?.code;
  if (code === 7 || code === 16) {
    return errorResponse(
      500,
      "firestore_permission_denied",
      "Firestore rejected the update. Check that the service account can write to Firestore.",
    );
  }
  if (code === 14 || code === 4) {
    return errorResponse(
      503,
      "firestore_unavailable",
      "Firestore is temporarily unreachable. Try again in a moment.",
    );
  }
  return errorResponse(
    500,
    "firestore_error",
    "Something went wrong while saving to Firestore. Nothing was sent.",
  );
}
