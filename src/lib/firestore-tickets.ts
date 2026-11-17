import "server-only";

import type { Firestore } from "firebase-admin/firestore";
import { getAdminDb } from "./firebase-admin";
import { compareByCreatedAtDesc, serializeTicket } from "./ticket-serialization";
import type { SupportTicketRecord } from "./types";

export const TICKETS_COLLECTION = "support_tickets";

import { MAX_TICKETS } from "./limits";

export { MAX_TICKETS };

const QUERY_TIMEOUT_MS = 15_000;

export class TicketsTimeoutError extends Error {
  constructor() {
    super("Firestore did not respond in time.");
    this.name = "TicketsTimeoutError";
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TicketsTimeoutError()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Reads tickets from Firestore, newest first.
 *
 * We sort in memory instead of using `orderBy("createdAt")`, because a
 * Firestore orderBy silently drops documents where the field is missing,
 * and tickets written by different n8n branches may not all have it.
 */
export async function listSupportTickets(
  db: Firestore = getAdminDb(),
): Promise<{ tickets: SupportTicketRecord[]; truncated: boolean }> {
  // One extra document tells us whether the cap cut anything off.
  const snapshot = await withTimeout(
    db.collection(TICKETS_COLLECTION).limit(MAX_TICKETS + 1).get(),
    QUERY_TIMEOUT_MS,
  );
  const truncated = snapshot.docs.length > MAX_TICKETS;
  if (truncated) {
    console.warn(
      `[firestore-tickets] More than ${MAX_TICKETS} tickets exist; the dashboard shows only ${MAX_TICKETS}. Add pagination.`,
    );
  }
  const tickets = snapshot.docs
    .slice(0, MAX_TICKETS)
    .map((doc) => serializeTicket(doc.id, doc.data()))
    .sort(compareByCreatedAtDesc);
  return { tickets, truncated };
}

/** Thrown when no `support_tickets` document has the requested ID. */
export class TicketNotFoundError extends Error {
  constructor(readonly ticketId: string) {
    super("Ticket not found.");
    this.name = "TicketNotFoundError";
  }
}

/** Thrown when an ID could never be a valid Firestore document ID. */
export class InvalidTicketIdError extends Error {
  constructor() {
    super("That ticket ID is not valid.");
    this.name = "InvalidTicketIdError";
  }
}

/** Firestore document ID rules: no "/", not "." or "..", not "__.*__", max 1500 bytes. */
export function isValidDocumentId(id: string): boolean {
  return (
    id.length > 0 &&
    Buffer.byteLength(id, "utf8") <= 1500 &&
    !id.includes("/") &&
    id !== "." &&
    id !== ".." &&
    !/^__.*__$/.test(id)
  );
}

/** Reads one ticket by its Firestore document ID. */
export async function getSupportTicket(
  id: string,
): Promise<SupportTicketRecord> {
  if (!isValidDocumentId(id)) throw new InvalidTicketIdError();

  const snapshot = await withTimeout(
    getAdminDb().collection(TICKETS_COLLECTION).doc(id).get(),
    QUERY_TIMEOUT_MS,
  );
  if (!snapshot.exists) throw new TicketNotFoundError(id);
  return serializeTicket(snapshot.id, snapshot.data() ?? {});
}
