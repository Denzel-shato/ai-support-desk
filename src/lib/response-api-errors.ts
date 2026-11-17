import "server-only";

import { FirebaseConfigError } from "./firebase-admin";
import {
  InvalidTicketIdError,
  TicketNotFoundError,
  TicketsTimeoutError,
} from "./firestore-tickets";
import { ResponseWorkflowError } from "./response-workflow";
import {
  authErrorResponse,
  errorResponse,
  serverError,
  ticketsErrorResponse,
} from "./ticket-api-errors";

/**
 * Maps errors from the review and send routes to JSON responses. Workflow rule
 * violations carry their own status; config, id, not-found and timeout errors
 * reuse the ticket routes' mapping so every route reports them the same way.
 */
export function responseErrorResponse(error: unknown, logLabel: string) {
  const auth = authErrorResponse(error);
  if (auth) return auth;
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

  const code = (error as { code?: unknown } | null)?.code;
  if (code === 7 || code === 16) {
    return serverError(
      500,
      "firestore_permission_denied",
      "Firestore rejected the update. Check that the service account can write to Firestore.",
      logLabel,
      error,
    );
  }
  if (code === 14 || code === 4) {
    return serverError(
      503,
      "firestore_unavailable",
      "Firestore is temporarily unreachable. Try again in a moment.",
      logLabel,
      error,
    );
  }
  return serverError(
    500,
    "firestore_error",
    "Something went wrong while saving to Firestore. Nothing was sent.",
    logLabel,
    error,
  );
}
