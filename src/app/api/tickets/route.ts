import { connection } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { NextResponse } from "next/server";
import { listSupportTickets } from "@/lib/firestore-tickets";
import { NO_STORE, TRUNCATED_HEADER, ticketsErrorResponse } from "@/lib/ticket-api-errors";

/**
 * GET /api/tickets
 * Read-only. Returns every `support_tickets` document (newest first) as a
 * JSON array, or `{ error: { code, message } }` with a matching status.
 */
export async function GET(request: Request) {
  // Opt out of build-time prerendering: this must run on every request.
  await connection();

  try {
    await requireAuth(request);
    const { tickets, truncated } = await listSupportTickets();
    return NextResponse.json(tickets, {
      status: 200,
      headers: truncated ? { ...NO_STORE, [TRUNCATED_HEADER]: "true" } : NO_STORE,
    });
  } catch (error) {
    return ticketsErrorResponse(error, "api/tickets");
  }
}
