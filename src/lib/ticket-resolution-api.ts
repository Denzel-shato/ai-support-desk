import "server-only";

import { NextResponse } from "next/server";
import type { Firestore } from "firebase-admin/firestore";
import { requireAuth } from "@/lib/auth/require-auth";
import { applyResolutionAction } from "@/lib/firestore-ticket-resolution";
import { invalidateTicketStats } from "@/lib/firestore-ticket-stats";
import { InvalidTicketIdError, isValidDocumentId } from "@/lib/firestore-tickets";
import { readJsonBody } from "@/lib/request-guard";
import { responseErrorResponse } from "@/lib/response-api-errors";
import { NO_STORE } from "@/lib/ticket-api-errors";
import { parseResolutionRequest } from "@/lib/ticket-resolution";

/**
 * The logic behind POST /api/tickets/[id]/resolution, kept apart from the
 * route file so tests can run the real handler against an in-memory Firestore.
 * The route calls it with no `deps`, which means the real database and clock.
 *
 * Order of checks (each one runs before anything is read or written):
 *  1. authentication: a signed-in dashboard user (401 / 503)
 *  2. ticket ID is a possible document ID (400)
 *  3. same-origin, JSON, size, and a valid `action` (403 / 415 / 413 / 400)
 *  4. Firestore transaction: ticket exists (404) and the transition is valid (409)
 */
export async function handleResolutionRequest(
  request: Request,
  id: string,
  deps: { db?: Firestore; nowMs?: number } = {},
): Promise<Response> {
  try {
    const session = await requireAuth(request);
    if (!isValidDocumentId(id)) throw new InvalidTicketIdError();

    const action = parseResolutionRequest(await readJsonBody(request));
    const ticket = await applyResolutionAction(id, action, session.sub, deps.db, deps.nowMs);
    invalidateTicketStats(); // the Overview counts changed: drop the cached aggregates
    return NextResponse.json({ ticket }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return responseErrorResponse(error, "api/tickets/[id]/resolution", {
      saveFailureMessage:
        "Something went wrong while saving to Firestore. The ticket was not changed and no email was sent.",
    });
  }
}
