import { connection, NextResponse } from "next/server";
import { isValidMessageId } from "@/lib/communications";
import { requireAuth } from "@/lib/auth/require-auth";
import { reconcileFollowUp } from "@/lib/firestore-ticket-messages";
import { InvalidTicketIdError, isValidDocumentId } from "@/lib/firestore-tickets";
import { readJsonBody } from "@/lib/request-guard";
import { responseErrorResponse } from "@/lib/response-api-errors";
import { parseReconcileRequest, ResponseWorkflowError } from "@/lib/response-workflow";
import { NO_STORE } from "@/lib/ticket-api-errors";

/**
 * POST /api/tickets/[id]/followups/[messageId]/reconcile
 * Body: { outcome: "delivered" | "not_delivered" }
 * Same as the ticket-level reconcile route, for one follow-up message.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; messageId: string }> },
) {
  await connection();
  try {
    const session = await requireAuth(request);
    const { id, messageId } = await context.params;
    if (!isValidDocumentId(id)) throw new InvalidTicketIdError();
    if (!isValidMessageId(messageId)) {
      throw new ResponseWorkflowError(400, "invalid_message_id", "The message ID must be a UUID.");
    }
    const outcome = parseReconcileRequest(await readJsonBody(request));
    const message = await reconcileFollowUp(id, messageId, outcome, undefined, undefined, session.sub);
    return NextResponse.json({ message }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return responseErrorResponse(error, "api/tickets/[id]/followups/[messageId]/reconcile");
  }
}
