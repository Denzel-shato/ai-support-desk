import "server-only";

import { Timestamp, type Firestore } from "firebase-admin/firestore";

import {
  decideFollowUpClaim,
  decideFollowUpReconcile,
  decideFollowUpRecord,
  MAX_MESSAGES,
  MESSAGE_TIMESTAMP_FIELDS,
  MESSAGES_SUBCOLLECTION,
  toFollowUpMessage,
  type FollowUpClaim,
  type FollowUpMessage,
} from "./communications";
import { getAdminDb } from "./firebase-admin";
import {
  InvalidTicketIdError,
  TICKETS_COLLECTION,
  TicketNotFoundError,
  isValidDocumentId,
  withTimeout,
} from "./firestore-tickets";
import {
  ResponseWorkflowError,
  type ReconcileOutcome,
  type SendOptions,
  type WebhookOutcome,
} from "./response-workflow";

/**
 * Firestore access for follow-up messages (`support_tickets/{id}/messages`).
 * A follow-up never writes to the ticket document itself, so it can't disturb
 * aiResponse, customerResponse, finalResponse, reviewStatus or responseStatus.
 */

const TX_TIMEOUT_MS = 15_000;

function toStored(fields: Record<string, unknown>): Record<string, unknown> {
  const out = { ...fields };
  for (const name of MESSAGE_TIMESTAMP_FIELDS) {
    const v = out[name];
    if (typeof v === "string") out[name] = Timestamp.fromDate(new Date(v));
  }
  return out;
}

function refs(db: Firestore, ticketId: string, messageId?: string) {
  if (!isValidDocumentId(ticketId)) throw new InvalidTicketIdError();
  const ticket = db.collection(TICKETS_COLLECTION).doc(ticketId);
  const messages = ticket.collection(MESSAGES_SUBCOLLECTION);
  return { ticket, messages, message: messageId ? messages.doc(messageId) : null };
}

/** Follow-ups for a ticket, oldest first. Verifies the ticket exists. */
export async function listFollowUps(
  ticketId: string,
  db: Firestore = getAdminDb(),
  nowMs: number = Date.now(),
): Promise<FollowUpMessage[]> {
  const { ticket, messages } = refs(db, ticketId);
  const [ticketSnap, snap] = await withTimeout(
    Promise.all([ticket.get(), messages.limit(MAX_MESSAGES).get()]),
    TX_TIMEOUT_MS,
  );
  if (!ticketSnap.exists) throw new TicketNotFoundError(ticketId);
  return snap.docs
    .map((d) => toFollowUpMessage(d.id, d.data(), nowMs))
    .sort((a, b) => {
      const at = a.createdAt ? Date.parse(a.createdAt) : Infinity;
      const bt = b.createdAt ? Date.parse(b.createdAt) : Infinity;
      return at - bt || a.id.localeCompare(b.id);
    });
}

export async function readFollowUp(
  ticketId: string,
  messageId: string,
  db: Firestore = getAdminDb(),
): Promise<FollowUpMessage | null> {
  const { message } = refs(db, ticketId, messageId);
  const snap = await withTimeout(message!.get(), TX_TIMEOUT_MS);
  return snap.exists ? toFollowUpMessage(snap.id, snap.data() ?? {}) : null;
}

/**
 * Atomically claims a follow-up send: creates the message as "sending" (or
 * re-claims a failed one; an unsettled one only with `retryUnknown`). A
 * double-click carries the same message ID, so the second request finds the
 * document already there (`create` can't overwrite) and is refused.
 */
export async function claimFollowUp(
  ticketId: string,
  messageId: string,
  text: unknown,
  db: Firestore = getAdminDb(),
  nowMs: number = Date.now(),
  options: SendOptions = {},
): Promise<FollowUpClaim> {
  const { ticket, message } = refs(db, ticketId, messageId);
  return withTimeout(
    db.runTransaction(async (tx) => {
      const [ticketSnap, messageSnap] = await Promise.all([
        tx.get(ticket),
        tx.get(message!),
      ]);
      if (!ticketSnap.exists) throw new TicketNotFoundError(ticketId);
      const claim = decideFollowUpClaim(
        ticketSnap.data() ?? {},
        messageSnap.exists ? (messageSnap.data() ?? {}) : null,
        messageId,
        text,
        nowMs,
        new Date(nowMs).toISOString(),
        options,
      );
      if (claim.mode === "create") tx.create(message!, toStored(claim.fields));
      else tx.update(message!, toStored(claim.fields));
      return claim;
    }),
    TX_TIMEOUT_MS,
  );
}

/** Records what n8n answered for a follow-up. Never downgrades "sent". */
export async function recordFollowUpOutcome(
  ticketId: string,
  messageId: string,
  outcome: WebhookOutcome,
  db: Firestore = getAdminDb(),
  nowMs: number = Date.now(),
): Promise<void> {
  const { message } = refs(db, ticketId, messageId);
  await withTimeout(
    db.runTransaction(async (tx) => {
      const snap = await tx.get(message!);
      if (!snap.exists) {
        throw new ResponseWorkflowError(404, "message_not_found", "That message no longer exists.");
      }
      const fields = decideFollowUpRecord(
        snap.data() ?? {},
        outcome,
        new Date(nowMs).toISOString(),
      );
      if (fields) tx.update(message!, toStored(fields));
    }),
    TX_TIMEOUT_MS,
  );
}

/** An agent states whether an unsettled follow-up was delivered. */
export async function reconcileFollowUp(
  ticketId: string,
  messageId: string,
  outcome: ReconcileOutcome,
  db: Firestore = getAdminDb(),
  nowMs: number = Date.now(),
): Promise<FollowUpMessage> {
  const { message } = refs(db, ticketId, messageId);
  await withTimeout(
    db.runTransaction(async (tx) => {
      const snap = await tx.get(message!);
      const fields = decideFollowUpReconcile(
        snap.exists ? (snap.data() ?? {}) : null,
        outcome,
        nowMs,
        new Date(nowMs).toISOString(),
      );
      tx.update(message!, toStored(fields));
    }),
    TX_TIMEOUT_MS,
  );
  const fresh = await readFollowUp(ticketId, messageId, db);
  if (!fresh) {
    throw new ResponseWorkflowError(404, "message_not_found", "That message no longer exists.");
  }
  return fresh;
}
