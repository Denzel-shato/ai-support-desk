import { connection } from "next/server";
import { NextResponse } from "next/server";
import { listSupportTickets } from "@/lib/firestore-tickets";
import { NO_STORE, ticketsErrorResponse } from "@/lib/ticket-api-errors";

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
    return ticketsErrorResponse(error, "api/tickets");
  }
}
