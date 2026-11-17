import { connection, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { listFollowUps } from "@/lib/firestore-ticket-messages";
import { responseErrorResponse } from "@/lib/response-api-errors";
import { NO_STORE } from "@/lib/ticket-api-errors";

/**
 * GET /api/tickets/[id]/messages
 * Read-only. Follow-up messages for a ticket, oldest first: `{ messages }`.
 * (The AI and agent responses are part of the ticket itself.)
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await connection();
  try {
    await requireAuth(request);
    const { id } = await context.params;
    const messages = await listFollowUps(id);
    return NextResponse.json({ messages }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return responseErrorResponse(error, "api/tickets/[id]/messages");
  }
}
