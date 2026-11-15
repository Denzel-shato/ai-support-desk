import "server-only";

import { FirebaseConfigError } from "./firebase-admin";
import { TicketsTimeoutError } from "./firestore-tickets";
import { errorResponse, ticketsErrorResponse } from "./ticket-api-errors";

/** Error mapping for the knowledge-base route (same shapes as the ticket routes). */
export function knowledgeErrorResponse(error: unknown, logLabel: string) {
  if (error instanceof FirebaseConfigError || error instanceof TicketsTimeoutError) {
    return ticketsErrorResponse(error, logLabel);
  }
  console.error(`[${logLabel}] Failed to read the knowledge base:`, error);

  const code = (error as { code?: unknown } | null)?.code;
  if (code === 7 || code === 16) {
    return errorResponse(
      500,
      "firestore_permission_denied",
      "Firestore rejected the service account. Check that it can read the knowledge_base collection.",
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
    "Something went wrong while reading the knowledge base from Firestore.",
  );
}
