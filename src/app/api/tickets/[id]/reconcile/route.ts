import { connection, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { reconcileResponse } from "@/lib/firestore-ticket-response";
import { InvalidTicketIdError, isValidDocumentId } from "@/lib/firestore-tickets";
import { readJsonBody } from "@/lib/request-guard";
import { responseErrorResponse } from "@/lib/response-api-errors";
import { parseReconcileRequest } from "@/lib/response-workflow";
import { NO_STORE } from "@/lib/ticket-api-errors";

/**
 * POST /api/tickets/[id]/reconcile
 * Body: { outcome: "delivered" | "not_delivered" }
 *
 * For a response whose send is unsettled (queued / unknown). An agent has
 * checked the customer's mail or the n8n execution log and says what
 * happened: "delivered" records it as sent (flagged agent-confirmed);
 * "not_delivered" records it as failed, which allows a normal resend. Nothing
 * is emailed by this route.
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
    const outcome = parseReconcileRequest(await readJsonBody(request));
    const ticket = await reconcileResponse(id, outcome, undefined, undefined, session.sub);
    return NextResponse.json({ ticket }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return responseErrorResponse(error, "api/tickets/[id]/reconcile");
  }
}
