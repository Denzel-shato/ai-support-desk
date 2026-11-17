import { connection } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { NextResponse } from "next/server";
import { getSupportTicket } from "@/lib/firestore-tickets";
import { NO_STORE, ticketsErrorResponse } from "@/lib/ticket-api-errors";

/**
 * GET /api/tickets/[id]
 * Read-only. Returns one `support_tickets` document (id = Firestore document
 * ID) as JSON, or `{ error: { code, message } }`: 400 for an impossible ID,
 * 404 when no such ticket exists, otherwise the same errors as the list route.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await connection();

  try {
    await requireAuth(request);
    const { id } = await context.params;
    const ticket = await getSupportTicket(id);
    return NextResponse.json(ticket, { status: 200, headers: NO_STORE });
  } catch (error) {
    return ticketsErrorResponse(error, "api/tickets/[id]");
  }
}
