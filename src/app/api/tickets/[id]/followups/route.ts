import { connection, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
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
import { retryShort } from "@/lib/retry";
import { readJsonBody } from "@/lib/request-guard";
import { responseErrorResponse } from "@/lib/response-api-errors";
import { ResponseWorkflowError, UNKNOWN_MESSAGE } from "@/lib/response-workflow";
import { errorResponse, NO_STORE } from "@/lib/ticket-api-errors";

export const maxDuration = 30;

/**
 * POST /api/tickets/[id]/followups
 * Body: { messageId: <uuid>, content?: string, retryUnknown?: boolean }
 *
 * Sends a follow-up to the customer. The browser generates `messageId` once per
 * draft: it is the message's ID and the idempotency key, so a double-click or a
 * retry can never produce a second email. `content` is used only for a NEW
 * message; a retry re-sends the stored text. The recipient always comes from
 * the stored ticket. Independent of the initial response's review state.
 * Order of checks: id, body, message ID, text, webhook config, Firestore.
 *
 * A message whose earlier attempt is unsettled (queued / unknown) is refused
 * (409 delivery_unconfirmed) unless `retryUnknown` is true: the agent chose to
 * resend after checking, accepting a possible duplicate.
 *
 * Answers: 200 sent, 202 queued (accepted, not confirmed), 502 failed (known
 * not delivered), 504 unknown (may have been delivered; NOT marked failed).
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

    const claim = await claimFollowUp(id, messageId, body?.content, undefined, undefined, {
      retryUnknown: body?.retryUnknown === true,
    }, session.sub);
    let outcome;
    try {
      const payload = buildFollowUpPayload(id, claim, new Date().toISOString());
      outcome = await callSendWebhook(config, payload);
    } catch (error) {
      await recordFollowUpOutcome(
        id,
        messageId,
        { kind: "unknown", message: UNKNOWN_MESSAGE },
        undefined,
        undefined,
        claim.attempt,
      ).catch(() => undefined);
      throw error;
    }

    let warning: string | undefined;
    try {
      await retryShort(() =>
        recordFollowUpOutcome(id, messageId, outcome, undefined, undefined, claim.attempt),
      );
    } catch (error) {
      console.error(
        `[api/tickets/[id]/followups] Could not record the outcome (${outcome.kind}) for ticket ${id}, message ${messageId}:`,
        error,
      );
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
    if (outcome.kind === "accepted") {
      return NextResponse.json(
        {
          result: "queued",
          message,
          note: "The email workflow accepted the request but did not confirm delivery. It stays queued; check its status before retrying.",
        },
        { status: 202, headers: NO_STORE },
      );
    }
    if (outcome.kind === "unknown") {
      return errorResponse(504, "delivery_unknown", outcome.message);
    }
    return errorResponse(502, "delivery_failed", outcome.message);
  } catch (error) {
    return responseErrorResponse(error, "api/tickets/[id]/followups");
  }
}
