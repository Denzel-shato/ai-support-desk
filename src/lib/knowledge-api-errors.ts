import "server-only";

import { FirebaseConfigError } from "./firebase-admin";
import {
  ArticleConflictError,
  DuplicateArticleError,
  InvalidArticleIdError,
  KnowledgeNotFoundError,
  RequestIdConflictError,
} from "./firestore-knowledge-base";
import { TicketsTimeoutError } from "./firestore-tickets";
import { ResponseWorkflowError } from "./response-workflow";
import {
  authErrorResponse,
  errorResponse,
  serverError,
  ticketsErrorResponse,
} from "./ticket-api-errors";

/** Error mapping for the knowledge-base route (same shapes as the ticket routes). */
export function knowledgeErrorResponse(
  error: unknown,
  logLabel: string,
  options: { write?: boolean } = {},
) {
  const auth = authErrorResponse(error);
  if (auth) return auth;
  if (error instanceof InvalidArticleIdError) {
    return errorResponse(400, "invalid_article_id", error.message);
  }
  if (error instanceof DuplicateArticleError) {
    return errorResponse(
      409,
      "duplicate_article",
      "An article with this title already exists in this category. Edit that one instead, or change the title or category.",
      { existingId: error.existingId },
    );
  }
  if (error instanceof ArticleConflictError) {
    return errorResponse(
      409,
      "article_modified",
      "This article was changed by someone else after you opened it. Close this dialog, refresh, and apply your edit to the latest version. Nothing was overwritten.",
    );
  }
  if (error instanceof RequestIdConflictError) {
    return errorResponse(
      409,
      "request_id_conflict",
      "That submission ID was already used for a different article. Reload the page and try again.",
    );
  }
  if (error instanceof KnowledgeNotFoundError) {
    return errorResponse(
      404,
      "article_not_found",
      "No article exists with that ID. It may have been removed outside the dashboard; refresh the list.",
    );
  }
  // Request-guard failures (415, 413, 400 bad JSON, 403 origin).
  if (error instanceof ResponseWorkflowError) {
    return errorResponse(error.status, error.code, error.message);
  }
  if (error instanceof FirebaseConfigError || error instanceof TicketsTimeoutError) {
    return ticketsErrorResponse(error, logLabel);
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 7 || code === 16) {
    return serverError(
      500,
      "firestore_permission_denied",
      options.write
        ? "Firestore rejected the save. Check that the service account can write to the knowledge_base collection."
        : "Firestore rejected the service account. Check that it can read the knowledge_base collection.",
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
    options.write
      ? "Something went wrong while saving the article. Nothing was saved."
      : "Something went wrong while reading the knowledge base from Firestore.",
    logLabel,
    error,
  );
}
