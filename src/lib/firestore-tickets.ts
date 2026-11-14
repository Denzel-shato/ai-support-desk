import "server-only";

import { getAdminDb } from "./firebase-admin";
import { compareByCreatedAtDesc, serializeTicket } from "./ticket-serialization";
import type { SupportTicketRecord } from "./types";

export const TICKETS_COLLECTION = "support_tickets";

/** Safety cap for the demo. Revisit with pagination once volume grows. */
export const MAX_TICKETS = 1000;

const QUERY_TIMEOUT_MS = 15_000;

export class TicketsTimeoutError extends Error {
  constructor() {
    super("Firestore did not respond in time.");
    this.name = "TicketsTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
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
export async function listSupportTickets(): Promise<SupportTicketRecord[]> {
  const snapshot = await withTimeout(
    getAdminDb().collection(TICKETS_COLLECTION).limit(MAX_TICKETS).get(),
    QUERY_TIMEOUT_MS,
  );
  return snapshot.docs
    .map((doc) => serializeTicket(doc.id, doc.data()))
    .sort(compareByCreatedAtDesc);
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
function isValidDocumentId(id: string): boolean {
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
