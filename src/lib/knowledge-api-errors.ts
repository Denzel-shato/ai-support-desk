import "server-only";

import { FirebaseConfigError } from "./firebase-admin";
import { TicketsTimeoutError } from "./firestore-tickets";
import { ResponseWorkflowError } from "./response-workflow";
import { errorResponse, ticketsErrorResponse } from "./ticket-api-errors";

/** Error mapping for the knowledge-base route (same shapes as the ticket routes). */
export function knowledgeErrorResponse(
  error: unknown,
  logLabel: string,
  options: { write?: boolean } = {},
) {
  // Request-guard failures (415, 413, 400 bad JSON, 403 origin).
  if (error instanceof ResponseWorkflowError) {
    return errorResponse(error.status, error.code, error.message);
  }
  if (error instanceof FirebaseConfigError || error instanceof TicketsTimeoutError) {
    return ticketsErrorResponse(error, logLabel);
  }
  console.error(
    `[${logLabel}] Failed to ${options.write ? "save to" : "read"} the knowledge base:`,
    error,
  );

  const code = (error as { code?: unknown } | null)?.code;
  if (code === 7 || code === 16) {
    return errorResponse(
      500,
      "firestore_permission_denied",
      options.write
        ? "Firestore rejected the save. Check that the service account can write to the knowledge_base collection."
        : "Firestore rejected the service account. Check that it can read the knowledge_base collection.",
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
    options.write
      ? "Something went wrong while saving the article. Nothing was saved."
      : "Something went wrong while reading the knowledge base from Firestore.",
  );
}
