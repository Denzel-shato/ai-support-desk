import "server-only";

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { AuthError } from "./auth/require-auth";
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

/**
 * Logs a server-side failure with a short request ID and answers with the same
 * ID, so a report from the browser can be matched to the server log. The log
 * gets the full error (stack included); the client gets only a safe message.
 */
export function serverError(
  status: number,
  code: string,
  message: string,
  logLabel: string,
  error: unknown,
  extra: Partial<ApiErrorBody["error"]> = {},
) {
  const requestId = randomUUID().slice(0, 8);
  const e = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  console.error(
    `[${logLabel}] ${code} (request ${requestId}): ${String(e?.name ?? "Error")} code=${String(e?.code ?? "-")} ${String(e?.message ?? "")}`,
    error,
  );
  return errorResponse(status, code, message, { ...extra, requestId });
}

/** 401/503 from requireAuth, or null when the error is something else. */
export function authErrorResponse(error: unknown) {
  if (!(error instanceof AuthError)) return null;
  return errorResponse(
    error.status,
    error.code,
    error.message,
    error.missing.length ? { missing: error.missing } : {},
  );
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
  const auth = authErrorResponse(error);
  if (auth) return auth;
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

  // The full error is logged on the server only; the browser gets a safe message.
  switch (grpcCode(error)) {
    case 7: // PERMISSION_DENIED
    case 16: // UNAUTHENTICATED
      return serverError(
        500,
        "firestore_permission_denied",
        "Firestore rejected the service account. Check that the credentials belong to project ai-support-desk-9c4ed and that the account can read Firestore.",
        logLabel,
        error,
      );
    case 5: // NOT_FOUND
      return serverError(
        500,
        "firestore_not_found",
        "The Firestore database was not found. Check that Firestore is enabled for the project.",
        logLabel,
        error,
      );
    case 14: // UNAVAILABLE
    case 4: // DEADLINE_EXCEEDED
      return serverError(
        503,
        "firestore_unavailable",
        "Firestore is temporarily unreachable. Try again in a moment.",
        logLabel,
        error,
      );
    default:
      return serverError(
        500,
        "firestore_error",
        "Something went wrong while reading from Firestore.",
        logLabel,
        error,
      );
  }
}

/** Set on a list response when a safety cap cut results off. */
export const TRUNCATED_HEADER = "X-Result-Truncated";

export { NO_STORE };
