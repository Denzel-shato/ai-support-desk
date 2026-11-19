import "server-only";

import { Timestamp, type Firestore } from "firebase-admin/firestore";

import { getAdminDb } from "./firebase-admin";
import {
  InvalidTicketIdError,
  TICKETS_COLLECTION,
  TicketNotFoundError,
  isValidDocumentId,
  withTimeout,
} from "./firestore-tickets";
import { buildEvent, newEventRef } from "./response-events";
import { serializeTicket } from "./ticket-serialization";
import { decideResolution, type ResolutionAction } from "./ticket-resolution";
import type { SupportTicketRecord } from "./types";

/**
 * Firestore write for resolving / reopening a ticket.
 *
 * Same shape as the response workflow's writes: one transaction that re-reads
 * the ticket, lets the pure rules decide, then `tx.update`s ONLY the fields the
 * decision returns and appends one audit event. Nothing here sends an email or
 * talks to n8n. `db` is injectable so the rules can be exercised against an
 * in-memory fake.
 */

const TX_TIMEOUT_MS = 15_000;

/** Dates are ISO strings in the pure layer; Firestore stores Timestamps. */
const DATE_FIELDS = ["resolvedAt", "reopenedAt"] as const;

function toStored(fields: Record<string, unknown>): Record<string, unknown> {
  const out = { ...fields };
  for (const name of DATE_FIELDS) {
    const v = out[name];
    if (typeof v === "string") out[name] = Timestamp.fromDate(new Date(v));
  }
  return out;
}

/**
 * Resolves or reopens a ticket as `actor`. Two simultaneous requests can't
 * both succeed: the second transaction re-reads the ticket, finds the new
 * state and is refused (409). Returns the ticket as stored after the change.
 */
export async function applyResolutionAction(
  id: string,
  action: ResolutionAction,
  actor: string,
  db: Firestore = getAdminDb(),
  nowMs: number = Date.now(),
): Promise<SupportTicketRecord> {
  if (!isValidDocumentId(id)) throw new InvalidTicketIdError();
  const ref = db.collection(TICKETS_COLLECTION).doc(id);

  return withTimeout(
    db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new TicketNotFoundError(id);
      const raw = snap.data() ?? {};

      const { fields, event } = decideResolution(raw, action, nowMs, actor);
      const stored = toStored(fields);
      tx.update(ref, stored);
      tx.create(newEventRef(db, id), buildEvent(event.type, nowMs, actor, event.details));

      // The ticket as it will be stored once this commits. Building it here
      // (instead of re-reading afterwards) means a read that fails after the
      // commit can't make a successful change look like a failure.
      return serializeTicket(snap.id, { ...raw, ...stored });
    }),
    TX_TIMEOUT_MS,
  );
}
