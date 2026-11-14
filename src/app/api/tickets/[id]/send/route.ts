import { connection, NextResponse } from "next/server";
import {
  claimResponseSend,
  readTicketFresh,
  recordSendOutcome,
} from "@/lib/firestore-ticket-response";
import { InvalidTicketIdError, isValidDocumentId } from "@/lib/firestore-tickets";
import {
  buildWebhookPayload,
  callSendWebhook,
  readWebhookConfig,
} from "@/lib/n8n-send-response";
import { readJsonBody } from "@/lib/request-guard";
import { responseErrorResponse } from "@/lib/response-api-errors";
import { TIMEOUT_MESSAGE } from "@/lib/response-workflow";
import { errorResponse, NO_STORE } from "@/lib/ticket-api-errors";

// The webhook is given 25 s; leave room for the Firestore reads and writes.
export const maxDuration = 30;

/**
 * POST /api/tickets/[id]/send
 * The body is ignored on purpose: the text and the recipient are read from the
 * stored ticket, so nothing the browser sends can change who gets what.
 *
 *  1. Check the webhook is configured (before touching the ticket).
 *  2. Claim the send in a transaction: the ticket must be approved, not sent
 *     and not already being sent. Marks it "queued".
 *  3. POST to n8n. Only an explicit `{ "status": "sent" }` counts as delivered.
 *  4. Record the outcome, then answer.
 *
 * Answers: 200 sent, 202 queued (no confirmation yet), 502 failed, 504 timeout.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await connection();

  try {
    const { id } = await context.params;
    if (!isValidDocumentId(id)) throw new InvalidTicketIdError();

    await readJsonBody(request, { allowEmpty: true });
    const config = readWebhookConfig();

    const claim = await claimResponseSend(id);
    const payload = buildWebhookPayload(id, claim, new Date().toISOString());
    const outcome = await callSendWebhook(config, payload);

    let warning: string | undefined;
    try {
      await recordSendOutcome(id, claim.idempotencyKey, outcome);
    } catch (error) {
      console.error("[api/tickets/[id]/send] Could not record the outcome:", error);
      warning =
        outcome.kind === "sent"
          ? "The email was sent, but saving that to Firestore failed. Refresh to check the status; do not send again."
          : "The outcome could not be saved. Refresh to check the status.";
    }

    const ticket = await readTicketFresh(id).catch(() => null);

    if (outcome.kind === "sent") {
      return NextResponse.json(
        { result: "sent", ticket, ...(warning ? { warning } : {}) },
        { status: 200, headers: NO_STORE },
      );
    }
    if (outcome.kind === "unconfirmed") {
      return NextResponse.json(
        {
          result: "queued",
          message:
            "The email workflow accepted the request but did not confirm delivery. The response stays queued; check its status shortly before retrying.",
          ticket,
        },
        { status: 202, headers: NO_STORE },
      );
    }
    if (outcome.kind === "timeout") {
      return errorResponse(504, "delivery_timeout", TIMEOUT_MESSAGE);
    }
    return errorResponse(502, "delivery_failed", outcome.message);
  } catch (error) {
    return responseErrorResponse(error, "api/tickets/[id]/send");
  }
}
