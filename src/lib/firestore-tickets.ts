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
