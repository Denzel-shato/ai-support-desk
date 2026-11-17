import "server-only";

import { randomUUID } from "node:crypto";
import { Timestamp, type Firestore } from "firebase-admin/firestore";

import { TICKETS_COLLECTION } from "./firestore-tickets";

/**
 * Append-only audit trail: `support_tickets/{id}/response_events/{uuid}`.
 * Events are created INSIDE the same transaction as the change they describe,
 * so a change and its record commit together or not at all. Nothing here is
 * ever updated or deleted, which keeps what earlier writes overwrote (an older
 * final text, an error message, who confirmed a delivery) recoverable.
 * The AI's own `aiResponse` / `customerResponse` are never touched.
 */

export const EVENTS_SUBCOLLECTION = "response_events";

export type ResponseEventType =
  | "review_approve"
  | "review_reject"
  | "review_reopen"
  | "response_edited"
  | "send_claimed"
  | "send_outcome"
  | "reconciled"
  | "followup_claimed"
  | "followup_outcome"
  | "followup_reconciled";

export function newEventRef(db: Firestore, ticketId: string) {
  return db
    .collection(TICKETS_COLLECTION)
    .doc(ticketId)
    .collection(EVENTS_SUBCOLLECTION)
    .doc(randomUUID());
}

/** Firestore rejects `undefined`, so drop it before writing. */
export function buildEvent(
  type: ResponseEventType,
  nowMs: number,
  actor: string | null,
  details: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type,
    at: Timestamp.fromMillis(nowMs),
    actor: actor ?? "system",
  };
  for (const [k, v] of Object.entries(details)) if (v !== undefined) out[k] = v;
  return out;
}
