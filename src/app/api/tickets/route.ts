import { connection } from "next/server";
import { NextResponse } from "next/server";
import { FirebaseConfigError } from "@/lib/firebase-admin";
import { listSupportTickets, TicketsTimeoutError } from "@/lib/firestore-tickets";
import type { ApiErrorBody } from "@/lib/types";

const NO_STORE = { "Cache-Control": "no-store" };

function errorResponse(
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
 * GET /api/tickets
 * Read-only. Returns every `support_tickets` document (newest first) as a
 * JSON array, or `{ error: { code, message } }` with a matching status.
 */
export async function GET() {
  // Opt out of build-time prerendering: this must run on every request.
  await connection();

  try {
    const tickets = await listSupportTickets();
    return NextResponse.json(tickets, { status: 200, headers: NO_STORE });
  } catch (error) {
    if (error instanceof FirebaseConfigError) {
      return errorResponse(503, "firebase_not_configured", error.message, {
        missing: error.missing,
      });
    }
    if (error instanceof TicketsTimeoutError) {
      return errorResponse(
        504,
        "firestore_timeout",
        "Firestore took too long to respond. Check your network connection and try again.",
      );
    }

    // Log the full error on the server only; never send it to the browser.
    console.error("[api/tickets] Failed to read support_tickets:", error);

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
}
