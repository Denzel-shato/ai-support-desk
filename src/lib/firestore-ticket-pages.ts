import "server-only";

import { FieldPath, type Firestore, type DocumentSnapshot } from "firebase-admin/firestore";
import { getAdminDb } from "./firebase-admin";
import {
  TICKETS_COLLECTION,
  withTimeout,
} from "./firestore-tickets";
import { indexEscalations, matchesEscalationFilters } from "./escalations";
import { isEscalated } from "./overview";
import { serializeTicket } from "./ticket-serialization";
import { decodeCursor, encodeCursor, InvalidCursorError, type CursorDirection } from "./ticket-cursor";
import type { ListQuery } from "./ticket-list-query";
import { indexTickets, matchesFilters } from "./tickets-list";
import type { SupportTicketRecord } from "./types";


const QUERY_TIMEOUT_MS = 15_000;
/** Documents read from Firestore in one round trip while scanning. */
const SCAN_BATCH = 100;
/**
 * Most documents one request may read while looking for matches. A page with
 * no filters reads about `limit + 1`; this only bites when filters or search
 * are selective, so one request can never turn into a whole-collection read.
 */
export const SCAN_BUDGET = 1000;

export interface TicketPage {
  tickets: SupportTicketRecord[];
  /** Opaque cursor for the next page, or null when there is nothing more to read. */
  nextCursor: string | null;
  hasMore: boolean;
  /**
   * True when this request stopped at its read budget before filling the page.
   * `nextCursor` still continues the scan, so nothing is skipped; the page is
   * just shorter than asked for.
   */
  scanLimited: boolean;
  /** First page only: how many documents exist in total (a count query, not a read of each). */
  total?: number;
  /** First page only: documents with no usable `createdAt`; they cannot be paged and are not listed. */
  unlisted?: number;
}

type Row = { snap: DocumentSnapshot; record: SupportTicketRecord };

/**
 * One page of tickets in a stable order: `createdAt`, then document ID, both in
 * the same direction (so Firestore needs no composite index). Pagination is by
 * cursor (`startAfter`), never by offset.
 *
 * Search / priority / category / status are evaluated here with the exact
 * predicates the dashboard uses (derived statuses and free-text search cannot
 * be Firestore filters), while scanning forward in order within SCAN_BUDGET.
 * The cursor always points at the last document actually consumed, so a
 * filtered page never skips a ticket.
 */
export async function listTicketsPage(
  query: ListQuery,
  deps: { db?: Firestore; nowMs?: number } = {},
): Promise<TicketPage> {
  const db = deps.db ?? getAdminDb();
  const now = new Date(deps.nowMs ?? Date.now());
  const dir: CursorDirection = query.filters.sort === "oldest" ? "asc" : "desc";
  const collection = db.collection(TICKETS_COLLECTION);

  let after: DocumentSnapshot | null = null;
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor, dir); // throws InvalidCursorError
    const snap = await withTimeout(collection.doc(cursor.id).get(), QUERY_TIMEOUT_MS);
    // A deleted document cannot anchor a keyset query; ask the client to start over.
    if (!snap.exists) throw new InvalidCursorError();
    after = snap;
  }

  const matches = (record: SupportTicketRecord): boolean => {
    if (query.view === "tickets") {
      return matchesFilters(indexTickets([record], now)[0], query.filters);
    }
    if (!isEscalated(record)) return false;
    return matchesEscalationFilters(indexEscalations([record], now)[0], query.filters);
  };

  const picked: Row[] = [];
  let scanned = 0;
  let exhausted = false;
  let lastScanned: DocumentSnapshot | null = null;
  let foundExtra = false;

  while (!foundExtra && !exhausted && scanned < SCAN_BUDGET) {
    let q = collection.orderBy("createdAt", dir).orderBy(FieldPath.documentId(), dir);
    if (after) q = q.startAfter(after);
    const size = Math.min(SCAN_BATCH, SCAN_BUDGET - scanned);
    const batch = await withTimeout(q.limit(size).get(), QUERY_TIMEOUT_MS);

    for (const snap of batch.docs) {
      scanned += 1;
      lastScanned = snap;
      after = snap;
      const record = serializeTicket(snap.id, (snap.data() ?? {}) as Record<string, unknown>);
      if (!matches(record)) continue;
      if (picked.length === query.limit) {
        foundExtra = true; // proves there is at least one more match
        break;
      }
      picked.push({ snap, record });
    }
    if (batch.docs.length < size) exhausted = true;
  }

  const scanLimited = !foundExtra && !exhausted;
  const hasMore = foundExtra || scanLimited;
  // Resume after the last ticket we returned; if we stopped on the budget, after the last one read.
  const resumeFrom = foundExtra ? picked[picked.length - 1]?.snap ?? null : lastScanned;
  const page: TicketPage = {
    tickets: picked.map((p) => p.record),
    nextCursor: hasMore && resumeFrom ? encodeCursor({ id: resumeFrom.id, dir }) : null,
    hasMore: hasMore && !!resumeFrom,
    scanLimited,
  };

  if (!query.cursor) {
    const [all, ordered] = await Promise.all([
      withTimeout(collection.count().get(), QUERY_TIMEOUT_MS),
      withTimeout(collection.orderBy("createdAt").count().get(), QUERY_TIMEOUT_MS),
    ]);
    page.total = all.data().count;
    page.unlisted = Math.max(0, all.data().count - ordered.data().count);
  }
  return page;
}

