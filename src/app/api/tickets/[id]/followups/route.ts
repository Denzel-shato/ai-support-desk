import { connection, NextResponse } from "next/server";
import { isValidMessageId } from "@/lib/communications";
import {
  claimFollowUp,
  readFollowUp,
  recordFollowUpOutcome,
} from "@/lib/firestore-ticket-messages";
import { InvalidTicketIdError, isValidDocumentId } from "@/lib/firestore-tickets";
import {
  buildFollowUpPayload,
  callSendWebhook,
  readWebhookConfig,
} from "@/lib/n8n-send-response";
import { readJsonBody } from "@/lib/request-guard";
import { responseErrorResponse } from "@/lib/response-api-errors";
import { ResponseWorkflowError, TIMEOUT_MESSAGE } from "@/lib/response-workflow";
import { errorResponse, NO_STORE } from "@/lib/ticket-api-errors";

export const maxDuration = 30;

/**
 * POST /api/tickets/[id]/followups
 * Body: { messageId: <uuid>, content?: string }
 *
 * Sends a follow-up to the customer. The browser generates `messageId` once per
 * draft: it is the message's ID and the idempotency key, so a double-click or a
 * retry can never produce a second email. `content` is used only for a NEW
 * message; a retry re-sends the stored text. The recipient always comes from
 * the stored ticket. Independent of the initial response's review state.
 * Order of checks: id, body, message ID, text, webhook config, Firestore.
 *
 * Answers: 200 sent, 202 queued (not confirmed), 502 failed, 504 timeout.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await connection();

  try {
    const { id } = await context.params;
    if (!isValidDocumentId(id)) throw new InvalidTicketIdError();

    const body = (await readJsonBody(request)) as Record<string, unknown> | null;
    const messageId = body?.messageId;
    if (!isValidMessageId(messageId)) {
      throw new ResponseWorkflowError(
        400,
        "invalid_message_id",
        "The message ID must be a UUID.",
      );
    }
    const config = readWebhookConfig();

    const claim = await claimFollowUp(id, messageId, body?.content);
    const payload = buildFollowUpPayload(id, claim, new Date().toISOString());
    const outcome = await callSendWebhook(config, payload);

    let warning: string | undefined;
    try {
      await recordFollowUpOutcome(id, messageId, outcome);
    } catch (error) {
      console.error("[api/tickets/[id]/followups] Could not record the outcome:", error);
      warning =
        outcome.kind === "sent"
          ? "The email was sent, but saving that failed. Refresh to check; do not send it again."
          : "The outcome could not be saved. Refresh to check the status.";
    }

    const message = await readFollowUp(id, messageId).catch(() => null);

    if (outcome.kind === "sent") {
      return NextResponse.json(
        { result: "sent", message, ...(warning ? { warning } : {}) },
        { status: 200, headers: NO_STORE },
      );
    }
    if (outcome.kind === "unconfirmed") {
      return NextResponse.json(
        {
          result: "queued",
          message,
          note: "The email workflow accepted the request but did not confirm delivery. It stays queued; check its status before retrying.",
        },
        { status: 202, headers: NO_STORE },
      );
    }
    if (outcome.kind === "timeout") {
      return errorResponse(504, "delivery_timeout", TIMEOUT_MESSAGE);
    }
    return errorResponse(502, "delivery_failed", outcome.message);
  } catch (error) {
    return responseErrorResponse(error, "api/tickets/[id]/followups");
  }
}
