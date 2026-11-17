import { connection, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { applyReviewAction } from "@/lib/firestore-ticket-response";
import { InvalidTicketIdError, isValidDocumentId } from "@/lib/firestore-tickets";
import { readJsonBody } from "@/lib/request-guard";
import { responseErrorResponse } from "@/lib/response-api-errors";
import { parseReviewRequest } from "@/lib/response-workflow";
import { NO_STORE } from "@/lib/ticket-api-errors";

/**
 * POST /api/tickets/[id]/review
 * Body: { action: "approve" | "reject" | "reopen", finalResponse?: string }
 *
 * Saves the agent's decision (and edited text as `finalResponse`). It never
 * sends anything and never writes `aiResponse` or `customerResponse`.
 * Order of checks: id, body, action and text, then Firestore.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await connection();

  try {
    const session = await requireAuth(request);
    const { id } = await context.params;
    if (!isValidDocumentId(id)) throw new InvalidTicketIdError();

    const body = await readJsonBody(request);
    const { action, finalResponse } = parseReviewRequest(body);

    const ticket = await applyReviewAction(id, action, finalResponse, undefined, undefined, session.sub);
    return NextResponse.json({ ticket }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return responseErrorResponse(error, "api/tickets/[id]/review");
  }
}
