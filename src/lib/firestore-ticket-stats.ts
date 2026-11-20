import "server-only";

import { FieldPath, type Firestore, type DocumentSnapshot } from "firebase-admin/firestore";
import { getAdminDb } from "./firebase-admin";
import { TICKETS_COLLECTION, withTimeout } from "./firestore-tickets";
import { addToStats, emptyStats, RECENT_TICKET_COUNT } from "./overview";
import { serializeTicket } from "./ticket-serialization";
import type { SupportTicketRecord, TicketStats } from "./types";

/**
 * Overview statistics over EVERY ticket, without holding them in memory.
 *
 * The collection is read in document-ID order (so a ticket with a missing or
 * odd `createdAt` can never be skipped, unlike `orderBy("createdAt")`) in
 * fixed-size batches. Each batch is folded into one small `TicketStats` with
 * `addToStats`, the same function the browser uses, then discarded. Only the
 * fields the status/priority/date rules read are fetched (`select`).
 *
 * Reads are not free, so the result is cached briefly per time zone and
 * concurrent requests share one scan. A hard ceiling stops a runaway
 * collection from turning into an unbounded read: past it the stats are
 * flagged `partial` rather than silently wrong.
 */

const QUERY_TIMEOUT_MS = 15_000;
const STATS_BATCH = 500;
/** Most documents one stats scan will read. */
export const STATS_SCAN_CEILING = 50_000;
export const STATS_CACHE_TTL_MS = 15_000;

/** Fields the shared predicates read. Anything else is not fetched. */
export const STATS_FIELDS = [
  "status",
  "escalationStatus",
  "priority",
  "kbStatus",
  "escalationRequired",
  "intakeIssue",
  "reviewStatus",
  "createdAt",
] as const;

export interface StatsResult {
  stats: TicketStats;
  /** The newest few tickets (full records) for the "recent" table. */
  recent: SupportTicketRecord[];
  /** Documents read by the scan. */
  scanned: number;
  /** True when the ceiling cut the scan short: the numbers are a lower bound. */
  partial: boolean;
  /** ISO time the numbers were computed (not "now" when served from the cache). */
  computedAt: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A usable IANA time zone, or null. The value comes from the browser, so it is validated. */
export function validTimeZone(tz: unknown): string | null {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** `Y-M0-D` (month is 0-based) in `tz`: the same key the browser charts use for local days. */
export function dayKeyFor(tz: string): (ms: number) => string {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric" });
    formatters.set(tz, f);
  }
  const fmt = f;
  return (ms) => {
    const parts = fmt.formatToParts(new Date(ms));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return `${get("year")}-${get("month") - 1}-${get("day")}`;
  };
}

export async function computeTicketStats(
  tz: string,
  deps: { db?: Firestore; nowMs?: number; ceiling?: number } = {},
): Promise<StatsResult> {
  const ceiling = deps.ceiling ?? STATS_SCAN_CEILING;
  const db = deps.db ?? getAdminDb();
  const nowMs = deps.nowMs ?? Date.now();
  const ctx = { nowMs, dayKeyOf: dayKeyFor(tz) };
  const collection = db.collection(TICKETS_COLLECTION);

  const stats = emptyStats();
  let scanned = 0;
  let partial = false;
  let after: DocumentSnapshot | null = null;

  while (true) {
    let q = collection
      .orderBy(FieldPath.documentId())
      .select(...STATS_FIELDS);
    if (after) q = q.startAfter(after);
    const size = Math.min(STATS_BATCH, ceiling - scanned);
    const batch = await withTimeout(q.limit(size).get(), QUERY_TIMEOUT_MS);
    for (const snap of batch.docs) {
      addToStats(stats, serializeTicket(snap.id, (snap.data() ?? {}) as Record<string, unknown>), ctx);
    }
    scanned += batch.docs.length;
    after = batch.docs[batch.docs.length - 1] ?? null;
    if (batch.docs.length < size) break;
    if (scanned >= ceiling) {
      partial = true;
      break;
    }
  }

  const recentSnap = await withTimeout(
    collection.orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc").limit(RECENT_TICKET_COUNT).get(),
    QUERY_TIMEOUT_MS,
  );
  const recent = recentSnap.docs.map((d) =>
    serializeTicket(d.id, (d.data() ?? {}) as Record<string, unknown>),
  );

  if (partial) {
    console.warn(`[ticket-stats] Stopped at ${ceiling} tickets; the Overview figures are a lower bound.`);
  }
  return { stats, recent, scanned, partial, computedAt: new Date(nowMs).toISOString() };
}

export interface StatsCache {
  get(tz: string, opts?: { fresh?: boolean; nowMs?: number }, compute?: () => Promise<StatsResult>): Promise<StatsResult>;
  invalidate(): void;
}

export function createStatsCache(ttlMs = STATS_CACHE_TTL_MS): StatsCache {
  const done = new Map<string, { at: number; value: StatsResult }>();
  const inflight = new Map<string, Promise<StatsResult>>();
  let generation = 0;
  return {
    async get(tz, opts = {}, compute) {
      const now = opts.nowMs ?? Date.now();
      const hit = done.get(tz);
      if (!opts.fresh && hit && now - hit.at < ttlMs) return hit.value;
      const running = inflight.get(tz);
      if (!opts.fresh && running) return running;
      const gen = generation;
      const p = (compute ?? (() => computeTicketStats(tz)))()
        .then((value) => {
          // A resolve/reopen that landed mid-scan makes this result stale: serve it once, never cache it.
          if (gen === generation) done.set(tz, { at: now, value });
          return value;
        })
        .finally(() => {
          if (inflight.get(tz) === p) inflight.delete(tz);
        });
      inflight.set(tz, p);
      return p;
    },
    invalidate() {
      generation += 1;
      done.clear();
      inflight.clear();
    },
  };
}

/** Process-wide cache used by the route. Per server instance, so it is a read-cost saver, not a source of truth. */
export const ticketStatsCache = createStatsCache();

/** Call after anything that changes a ticket's status (B3 resolve / reopen). */
export function invalidateTicketStats(): void {
  ticketStatsCache.invalidate();
}
