import "server-only";

import { randomUUID } from "node:crypto";
import { Timestamp, type Firestore } from "firebase-admin/firestore";

import { getAdminDb } from "./firebase-admin";
import {
  InvalidTicketIdError,
  TICKETS_COLLECTION,
  TicketNotFoundError,
  isValidDocumentId,
  withTimeout,
} from "./firestore-tickets";
import {
  TIMESTAMP_FIELDS,
  decideReviewUpdate,
  decideSendClaim,
  decideSendRecord,
  decideTicketReconcile,
  type ReconcileOutcome,
  type ReviewAction,
  type SendClaim,
  type SendOptions,
  type WebhookOutcome,
} from "./response-workflow";
import { serializeTicket } from "./ticket-serialization";
import type { SupportTicketRecord } from "./types";

/**
 * Firestore writes for the response workflow.
 *
 * Every write goes through a transaction and `tx.update` with only the fields
 * the pure decision functions return, so `aiResponse`, `customerResponse` and
 * anything the n8n branches wrote are never touched. `db` is injectable so the
 * lifecycle can be exercised against an in-memory fake.
 */

const TX_TIMEOUT_MS = 15_000;

/** ISO strings -> Firestore Timestamps for the fields that are stored as such. */
function toStored(fields: Record<string, unknown>): Record<string, unknown> {
  const out = { ...fields };
  for (const name of TIMESTAMP_FIELDS) {
    const v = out[name];
    if (typeof v === "string") out[name] = Timestamp.fromDate(new Date(v));
  }
  return out;
}

function ticketRef(db: Firestore, id: string) {
  if (!isValidDocumentId(id)) throw new InvalidTicketIdError();
  return db.collection(TICKETS_COLLECTION).doc(id);
}

/** Reads the ticket straight from Firestore (no caching). */
export async function readTicketFresh(
  id: string,
  db: Firestore = getAdminDb(),
): Promise<SupportTicketRecord> {
  const snap = await withTimeout(ticketRef(db, id).get(), TX_TIMEOUT_MS);
  if (!snap.exists) throw new TicketNotFoundError(id);
  return serializeTicket(snap.id, snap.data() ?? {});
}

/** Approve, reject or reopen. Returns the ticket as stored afterwards. */
export async function applyReviewAction(
  id: string,
  action: ReviewAction,
  finalResponse: string | undefined,
  db: Firestore = getAdminDb(),
  nowMs: number = Date.now(),
): Promise<SupportTicketRecord> {
  const ref = ticketRef(db, id);
  await withTimeout(
    db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new TicketNotFoundError(id);
      const fields = decideReviewUpdate(
        snap.data() ?? {},
        action,
        finalResponse,
        nowMs,
      );
      tx.update(ref, toStored(fields));
    }),
    TX_TIMEOUT_MS,
  );
  return readTicketFresh(id, db);
}

/**
 * Atomically claims a send: validates the stored ticket and marks it
 * "sending". Two simultaneous requests can't both pass, because the second
 * transaction re-reads the ticket and finds it already "sending".
 */
export async function claimResponseSend(
  id: string,
  db: Firestore = getAdminDb(),
  nowMs: number = Date.now(),
  options: SendOptions = {},
): Promise<SendClaim> {
  const ref = ticketRef(db, id);
  return withTimeout(
    db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new TicketNotFoundError(id);
      const claim = decideSendClaim(
        snap.data() ?? {},
        nowMs,
        new Date(nowMs).toISOString(),
        randomUUID,
        options,
      );
      tx.update(ref, toStored(claim.fields));
      return claim;
    }),
    TX_TIMEOUT_MS,
  );
}

/**
 * Records what n8n answered. Writes nothing when the attempt is stale or the
 * ticket is no longer in this attempt's "sending" claim.
 */
export async function recordSendOutcome(
  id: string,
  idempotencyKey: string,
  outcome: WebhookOutcome,
  db: Firestore = getAdminDb(),
  nowMs: number = Date.now(),
): Promise<void> {
  const ref = ticketRef(db, id);
  await withTimeout(
    db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new TicketNotFoundError(id);
      const fields = decideSendRecord(
        snap.data() ?? {},
        idempotencyKey,
        outcome,
        new Date(nowMs).toISOString(),
      );
      if (fields) tx.update(ref, toStored(fields));
    }),
    TX_TIMEOUT_MS,
  );
}

/**
 * An agent states whether an unsettled (queued / unknown) send was delivered.
 * Transactional, so it can't race with a send that settles at the same moment.
 */
export async function reconcileResponse(
  id: string,
  outcome: ReconcileOutcome,
  db: Firestore = getAdminDb(),
  nowMs: number = Date.now(),
): Promise<SupportTicketRecord> {
  const ref = ticketRef(db, id);
  await withTimeout(
    db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new TicketNotFoundError(id);
      const fields = decideTicketReconcile(
        snap.data() ?? {},
        outcome,
        nowMs,
        new Date(nowMs).toISOString(),
      );
      tx.update(ref, toStored(fields));
    }),
    TX_TIMEOUT_MS,
  );
  return readTicketFresh(id, db);
}
