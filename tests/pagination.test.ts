/* eslint-disable @typescript-eslint/no-explicit-any -- tests read untyped JSON bodies and stored documents */
// B7: dashboard pagination and aggregate statistics. These run the REAL request handlers and the REAL query-building
// code against an in-memory Firestore whose queries follow Firestore's semantics (see tests/fake-firestore-queries.ts):
// orderBy drops documents missing the field, mixed types sort by type, startAfter resumes strictly after a document,
// count() and select() exist. What this does NOT prove: real Firestore behaviour (indexes, latency, billing, the stored
// type of n8n's createdAt) or how the React components render.
import test from "node:test";
import assert from "node:assert/strict";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { hashPassword } from "@/lib/auth/password";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { SCAN_BUDGET } from "@/lib/firestore-ticket-pages";
import { createStatsCache, dayKeyFor, invalidateTicketStats, STATS_FIELDS, validTimeZone } from "@/lib/firestore-ticket-stats";
import { handleOverviewRequest, handleTicketListRequest } from "@/lib/ticket-list-api";
import { handleResolutionRequest } from "@/lib/ticket-resolution-api";
import { decodeCursor, encodeCursor } from "@/lib/ticket-cursor";
import { serializeTicket } from "@/lib/ticket-serialization";
import { deriveOverviewFromStats, statsFromTickets, deriveOverview } from "@/lib/overview";
import { escalationMetricsFromStats, buildEscalationMetrics, selectEscalated } from "@/lib/escalations";
import { indexTickets, matchesFilters, DEFAULT_FILTERS } from "@/lib/tickets-list";
import { FakeFirestore } from "./fake-firestore";
import { withQueries } from "./fake-firestore-queries";

const SECRET = "k".repeat(48);
const NOW = Date.parse("2026-11-19T09:42:00Z");
const COL = "support_tickets";
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

let hashPromise: Promise<string> | null = null;
const passwordHash = () => (hashPromise ??= hashPassword("correct horse battery"));
async function withAuth<T>(fn: (cookie: string) => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  const hash = await passwordHash();
  Object.assign(process.env, { AUTH_USERNAME: "admin", AUTH_PASSWORD_HASH: hash, AUTH_SESSION_SECRET: SECRET });
  try {
    return await fn(`${SESSION_COOKIE}=${await createSessionToken("admin", `${SECRET}\n${hash}`, Date.now())}`);
  } finally { process.env = saved; }
}

const PRIORITIES = ["Low", "Medium", "High", "Urgent"];
const CATEGORIES = ["billing_issue", "technical_support", "account_access"];

/** Ticket i is created i minutes after the base time; its document ID is unrelated to its age (as Firestore auto-IDs are). */
function ticketDoc(i: number, extra: Record<string, unknown> = {}) {
  const priority = PRIORITIES[i % 4];
  const escalated = priority === "High" || priority === "Urgent";
  return {
    customerName: `Customer ${i}`, customerEmail: `c${i}@example.com`, message: `Message ${i}`, summary: `Summary ${i}`,
    priority, category: CATEGORIES[i % 3], status: "pending_review", reviewStatus: "awaiting_review",
    createdAt: new Date(Date.parse("2026-10-01T00:00:00Z") + i * 60_000).toISOString(),
    ...(escalated ? { escalationStatus: "required", escalationRequired: true, escalatedAt: new Date(Date.parse("2026-10-01T00:00:00Z") + i * 60_000).toISOString() } : {}),
    ...extra,
  };
}
const idOf = (i: number) => `id${((i * 7919) % 100_003).toString(36).padStart(5, "0")}`;

function seed(n: number, mutate: (i: number, doc: Record<string, unknown>) => Record<string, unknown> | null = (_, d) => d) {
  const fake = withQueries(new FakeFirestore());
  for (let i = 0; i < n; i++) {
    const doc = mutate(i, ticketDoc(i));
    if (doc) fake.seed(`${COL}/${idOf(i)}`, doc);
  }
  return { fake, db: fake as unknown as Firestore };
}

const get = (cookie: string | null, url: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, { headers: { ...(cookie ? { cookie } : {}), ...headers } });

async function page(cookie: string, db: Firestore, qs: string, extra: Record<string, unknown> = {}) {
  const res = await handleTicketListRequest(get(cookie, `/api/tickets?${qs}`), { db, nowMs: NOW, ...extra });
  return { status: res.status, body: (await res.json()) as any };
}

/** Follows cursors until the list ends, with a guard against loops. */
async function collect(cookie: string, db: Firestore, qs: string) {
  const out: any[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const { status, body } = await page(cookie, db, cursor ? `${qs}&cursor=${encodeURIComponent(cursor)}` : qs);
    assert.equal(status, 200, JSON.stringify(body));
    out.push(...body.tickets);
    cursor = body.hasMore ? body.nextCursor : null;
    assert.ok(++pages < 400, "pagination did not terminate");
  } while (cursor);
  return { tickets: out, pages };
}

const ids = (xs: any[]) => xs.map((t) => t.id);
const noDupes = (xs: string[]) => assert.equal(new Set(xs).size, xs.length, "a ticket was returned twice");

/* ------------------------------ reliable retrieval ------------------------------ */

test("more than 1,000 tickets: the NEWEST appear first and every ticket is reachable exactly once", async () => {
  await withAuth(async (cookie) => {
    const N = 1250;
    const { db, fake } = seed(N);
    const first = await page(cookie, db, "limit=25");
    // The old code took the first 1,000 documents in ID order and sorted those, so the true newest could be missing.
    assert.equal(first.body.tickets[0].id, idOf(N - 1), "the newest ticket is on page one");
    assert.equal(first.body.total, N);
    assert.equal(first.body.unlisted, 0);

    const all = await collect(cookie, db, "limit=100");
    assert.equal(all.tickets.length, N);
    noDupes(ids(all.tickets));
    assert.deepEqual(ids(all.tickets), Array.from({ length: N }, (_, k) => idOf(N - 1 - k)), "strictly newest to oldest");
    assert.equal(all.pages, 13);

    const oldest = await collect(cookie, db, "limit=100&sort=oldest");
    assert.deepEqual(ids(oldest.tickets), Array.from({ length: N }, (_, k) => idOf(k)), "oldest first is the exact reverse");
    assert.ok(fake.queryLog.length > 0);
  });
});

test("query construction: every list read is ordered (createdAt, document ID, same direction), uses startAfter for later pages, and is bounded", async () => {
  await withAuth(async (cookie) => {
    const { db, fake } = seed(300);
    fake.queryLog.length = 0;
    await collect(cookie, db, "limit=50");
    const reads = fake.queryLog.filter((q) => q.kind === "get");
    assert.ok(reads.length >= 6);
    for (const q of reads) {
      assert.deepEqual(q.orderBy, ["createdAt desc", "__name__ desc"], "never an unordered read");
      assert.ok(q.limit !== null && q.limit <= 100, `unbounded query: limit ${q.limit}`);
      assert.equal(q.select, null);
    }
    assert.equal(reads[0].startAfter, null, "page one has no cursor");
    assert.ok(reads.slice(1).every((q) => q.startAfter), "later pages continue with startAfter (no offset)");
    // the one-off totals are count() aggregations, not reads of every document
    assert.equal(fake.queryLog.filter((q) => q.kind === "count").length, 2);
    // ascending uses ascending for BOTH fields (so no composite index is needed)
    fake.queryLog.length = 0;
    await page(cookie, db, "limit=10&sort=oldest");
    assert.deepEqual(fake.queryLog.find((q) => q.kind === "get")!.orderBy, ["createdAt asc", "__name__ asc"]);
  });
});

test("tickets with IDENTICAL timestamps keep a stable order and are neither skipped nor repeated across page boundaries", async () => {
  await withAuth(async (cookie) => {
    const SAME = "2026-11-01T10:00:00.000Z";
    const { db } = seed(260, (_, d) => ({ ...d, createdAt: SAME }));
    for (const sort of ["newest", "oldest"]) {
      const a = await collect(cookie, db, `limit=30&sort=${sort}`);
      const b = await collect(cookie, db, `limit=7&sort=${sort}`); // different page size, same order
      assert.equal(a.tickets.length, 260);
      noDupes(ids(a.tickets));
      assert.deepEqual(ids(a.tickets), ids(b.tickets), "order does not depend on page size");
      const sorted = [...ids(a.tickets)].sort();
      assert.deepEqual(ids(a.tickets), sort === "newest" ? sorted.reverse() : sorted, "ties broken by document ID, in the sort direction");
    }
  });
});

test("empty collection: empty page, zero total, no cursor", async () => {
  await withAuth(async (cookie) => {
    const { db } = seed(0);
    const { status, body } = await page(cookie, db, "limit=25");
    assert.equal(status, 200);
    assert.deepEqual(body, { tickets: [], nextCursor: null, hasMore: false, scanLimited: false, total: 0, unlisted: 0 });
  });
});

test("missing or malformed createdAt: never crashes, missing ones are reported as unlisted, malformed ones are listed with no date", async () => {
  await withAuth(async (cookie) => {
    const { db } = seed(40, (i, d) => {
      if (i % 10 === 0) { delete d.createdAt; return d; }            // 4 with no createdAt
      if (i % 10 === 1) return { ...d, createdAt: "not a date" };     // 4 malformed strings
      return d;
    });
    const first = await page(cookie, db, "limit=100");
    assert.equal(first.body.total, 40);
    assert.equal(first.body.unlisted, 4, "missing createdAt cannot be paged, so it is counted, not silently dropped");
    assert.equal(first.body.tickets.length, 36);
    const malformed = first.body.tickets.filter((t: any) => t.createdAt === null);
    assert.equal(malformed.length, 4, "a malformed value is listed, shown as having no date");
  });
});

test("Firestore Timestamp createdAt values order correctly too (not only ISO strings)", async () => {
  await withAuth(async (cookie) => {
    const { db } = seed(120, (i, d) => ({ ...d, createdAt: Timestamp.fromMillis(Date.parse("2026-10-01T00:00:00Z") + i * 60_000) }));
    const all = await collect(cookie, db, "limit=40");
    assert.deepEqual(ids(all.tickets), Array.from({ length: 120 }, (_, k) => idOf(119 - k)));
  });
});

test("MIXED createdAt types (ISO strings + Timestamps + missing): every ticket is reachable once, order is exact within a type, missing ones are counted", async () => {
  await withAuth(async (cookie) => {
    const N = 300;
    // i%3==0 -> Timestamp, i%3==1 -> ISO string, i%3==2 -> field missing entirely
    const { db } = seed(N, (i, d) => {
      if (i % 3 === 0) return { ...d, createdAt: Timestamp.fromMillis(Date.parse("2026-10-01T00:00:00Z") + i * 60_000) };
      if (i % 3 === 2) { delete d.createdAt; return d; }
      return d;
    });
    for (const sort of ["newest", "oldest"]) {
      const all = await collect(cookie, db, `limit=23&sort=${sort}`);
      noDupes(ids(all.tickets));
      assert.equal(all.tickets.length, 200, "Timestamp + string tickets are all listed");
      const first = await page(cookie, db, `limit=5&sort=${sort}`);
      assert.equal(first.body.total, N);
      assert.equal(first.body.unlisted, 100, "tickets with no createdAt are reported, not silently dropped");
      // Within each representation the order is exactly chronological. Firestore sorts ALL Timestamps before ALL strings,
      // so across the two types it is grouped by type, not by time: that is a property of the stored data (see docs/dashboard.md).
      const ts = all.tickets.filter((t: any) => Number(t.customerName.split(" ")[1]) % 3 === 0).map((t: any) => Date.parse(t.createdAt));
      const st = all.tickets.filter((t: any) => Number(t.customerName.split(" ")[1]) % 3 === 1).map((t: any) => Date.parse(t.createdAt));
      const sorted = (a: number[]) => [...a].sort((x, y) => (sort === "newest" ? y - x : x - y));
      assert.deepEqual(ts, sorted(ts));
      assert.deepEqual(st, sorted(st));
    }
    // stats do not depend on createdAt ordering at all: all 300 are counted, the 100 missing ones as undated
    const { body } = await overview(cookie, db);
    assert.equal(body.stats.total, N);
    assert.equal(body.stats.undated, 100);
  });
});

/* ------------------------------ filters, search, pagination together ------------------------------ */

test("filters + search + pagination agree with a brute-force evaluation of the same predicates over ALL tickets", async () => {
  await withAuth(async (cookie) => {
    const { db, fake } = seed(1100, (i, d) => (i % 9 === 0 ? { ...d, status: "resolved", resolvedAt: new Date(NOW).toISOString() } : d));
    const everything = [...fake.data.entries()].filter(([p]) => p.startsWith(`${COL}/`)).map(([p, v]) => serializeTicket(p.split("/")[1], v));
    const cases: [string, Partial<typeof DEFAULT_FILTERS>][] = [
      ["priority=urgent", { priority: "urgent" }],
      ["status=resolved", { status: "resolved" }],
      ["status=escalated&priority=high", { status: "escalated", priority: "high" }],
      ["status=awaiting_review", { status: "awaiting_review" }],
      ["search=customer%2077", { search: "customer 77" }],
      ["search=c42%40example&priority=high", { search: "c42@example", priority: "high" }],
      ["category=Technical%20support&status=resolved", { category: "Technical support", status: "resolved" }],
    ];
    for (const [qs, f] of cases) {
      const filters = { ...DEFAULT_FILTERS, ...f };
      const expected = indexTickets(everything, new Date(NOW)).filter((x) => matchesFilters(x, filters)).map((x) => x.row.id);
      const got = await collect(cookie, db, `limit=17&${qs}`);
      noDupes(ids(got.tickets));
      assert.deepEqual(new Set(ids(got.tickets)), new Set(expected), `filter "${qs}"`);
      assert.equal(got.tickets.length, expected.length, `filter "${qs}"`);
      // newest first within the filtered set
      const ms = got.tickets.map((t: any) => Date.parse(t.createdAt));
      assert.deepEqual(ms, [...ms].sort((a, b) => b - a));
    }
  });
});

test("a very selective filter stops at the read budget (scanLimited) and the cursor continues the scan: nothing is skipped", async () => {
  await withAuth(async (cookie) => {
    const N = 2300;
    const wanted = new Set([idOf(2290), idOf(1000), idOf(5)]); // far apart in time order
    const { db, fake } = seed(N, (i, d) => ({ ...d, summary: [2290, 1000, 5].includes(i) ? "needle-in-haystack" : d.summary }));
    fake.queryLog.length = 0;
    const first = await page(cookie, db, "limit=25&search=needle-in-haystack");
    const scannedDocs = fake.queryLog.filter((q) => q.kind === "get").reduce((n, q) => n + (q.limit ?? 0), 0);
    assert.ok(scannedDocs <= SCAN_BUDGET, `one request read at most ${SCAN_BUDGET} documents (asked for ${scannedDocs})`);
    assert.equal(first.body.scanLimited, true);
    assert.equal(first.body.hasMore, true);
    const all = await collect(cookie, db, "limit=25&search=needle-in-haystack");
    assert.deepEqual(new Set(ids(all.tickets)), wanted);
    assert.equal(all.tickets.length, 3);
  });
});

test("escalations view lists only escalated tickets; active/resolved and priority filters page correctly and history is kept", async () => {
  await withAuth(async (cookie) => {
    const { db } = seed(600, (i, d) => (i % 8 === 2 ? { ...d, status: "resolved", resolvedAt: new Date(NOW).toISOString() } : d));
    const all = await collect(cookie, db, "view=escalations&limit=20");
    assert.equal(all.tickets.length, 300, "High + Urgent = half of 600, resolved ones included as history");
    assert.ok(all.tickets.every((t: any) => t.escalationStatus === "required"));
    const active = await collect(cookie, db, "view=escalations&status=active&limit=20");
    const resolved = await collect(cookie, db, "view=escalations&status=resolved&limit=20");
    assert.equal(active.tickets.length + resolved.tickets.length, 300);
    assert.ok(resolved.tickets.length > 0 && resolved.tickets.every((t: any) => t.status === "resolved"));
    assert.ok(active.tickets.every((t: any) => t.status !== "resolved"), "a resolved escalation is not active");
    noDupes(ids(all.tickets));
    const urgent = await collect(cookie, db, "view=escalations&priority=urgent&limit=20");
    assert.equal(urgent.tickets.length, 150);
  });
});

/* ------------------------------ pagination under concurrent creation ------------------------------ */

test("tickets created while someone is paging do not cause duplicates or skips (newest-first and oldest-first)", async () => {
  await withAuth(async (cookie) => {
    const { db, fake } = seed(200);
    // newest first: read page 1, then 15 NEWER tickets arrive, then keep paging
    const p1 = await page(cookie, db, "limit=50");
    for (let k = 0; k < 15; k++) fake.seed(`${COL}/late${k}`, ticketDoc(1000 + k));
    const seen = [...ids(p1.body.tickets)];
    let cursor = p1.body.nextCursor;
    while (cursor) {
      const p = await page(cookie, db, `limit=50&cursor=${encodeURIComponent(cursor)}`);
      seen.push(...ids(p.body.tickets));
      cursor = p.body.hasMore ? p.body.nextCursor : null;
    }
    noDupes(seen);
    assert.deepEqual(seen, Array.from({ length: 200 }, (_, k) => idOf(199 - k)), "the original 200, in order, none lost or repeated");
    assert.ok(!seen.some((id) => id.startsWith("late")), "new tickets sit ahead of the cursor; a refresh (page one) shows them");
    const refreshed = await page(cookie, db, "limit=50");
    assert.equal(refreshed.body.tickets[0].id, "late14");
    assert.equal(refreshed.body.total, 215);

    // oldest first: the same new tickets land at the END and are picked up by later pages, still without repeats
    const q1 = await page(cookie, db, "limit=50&sort=oldest");
    const got = [...ids(q1.body.tickets)];
    fake.seed(`${COL}/late99`, ticketDoc(2000));
    let c2 = q1.body.nextCursor;
    while (c2) {
      const p = await page(cookie, db, `limit=50&sort=oldest&cursor=${encodeURIComponent(c2)}`);
      got.push(...ids(p.body.tickets));
      c2 = p.body.hasMore ? p.body.nextCursor : null;
    }
    noDupes(got);
    assert.equal(got.length, 216);
    assert.equal(got[got.length - 1], "late99");
  });
});

/* ------------------------------ cursor validation ------------------------------ */

test("invalid, tampered, foreign, wrong-direction and stale cursors are rejected with 400 and never reach a data query", async () => {
  await withAuth(async (cookie) => {
    const { db, fake } = seed(120);
    const good = (await page(cookie, db, "limit=10")).body.nextCursor as string;
    const [payload, sig] = good.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, d: "desc", i: idOf(3) })).toString("base64url");
    const bad: Record<string, string> = {
      garbage: "not-a-cursor",
      "no signature": payload,
      "empty signature": `${payload}.`,
      "extra part": `${good}.x`,
      "tampered payload (valid signature of another)": `${forged}.${sig}`,
      "tampered signature": `${payload}.${sig.slice(0, -2)}AA`,
      "unsigned crafted id": `${forged}.AAAA`,
      "huge": "a".repeat(5000),
      "json not an object": `${Buffer.from("[]").toString("base64url")}.${sig}`,
    };
    for (const [label, cursor] of Object.entries(bad)) {
      fake.queryLog.length = 0;
      const r = await page(cookie, db, `limit=10&cursor=${encodeURIComponent(cursor)}`);
      assert.equal(r.status, 400, label);
      assert.equal(r.body.error.code, "invalid_cursor", label);
      assert.equal(fake.queryLog.length, 0, `${label}: a rejected cursor must not touch Firestore`);
    }
    // a genuine cursor for the other direction
    const wrongDir = await page(cookie, db, `limit=10&sort=oldest&cursor=${encodeURIComponent(good)}`);
    assert.equal(wrongDir.status, 400);
    assert.equal(wrongDir.body.error.code, "invalid_cursor");
    // a genuine cursor whose document has since been deleted
    const stale = encodeCursor({ id: "deleted-doc", dir: "desc" });
    const gone = await page(cookie, db, `limit=10&cursor=${encodeURIComponent(stale)}`);
    assert.equal(gone.status, 400);
    assert.equal(gone.body.error.code, "invalid_cursor");
    // round trip stays valid
    assert.deepEqual(decodeCursor(good, "desc").dir, "desc");
  });
  // a cursor signed under a different secret (e.g. after the admin password changed) is rejected
  let foreign = "";
  await withAuth(async () => { foreign = encodeCursor({ id: idOf(5), dir: "desc" }); });
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { AUTH_USERNAME: "admin", AUTH_PASSWORD_HASH: await passwordHash(), AUTH_SESSION_SECRET: "z".repeat(48) });
    assert.throws(() => decodeCursor(foreign, "desc"), /not valid/);
  } finally { process.env = saved; }
});

test("query parameters are validated: unknown names, bad enums, bad limits, duplicates, oversize and control characters are 400 before any read", async () => {
  await withAuth(async (cookie) => {
    const { db, fake } = seed(10);
    const bads = [
      "orderBy=name", "where=a", "collection=users", "limit=0", "limit=101", "limit=-1", "limit=abc", "limit=1e3",
      "priority=critical", "status=done", "sort=random", "view=users", "view=escalations&priority=low", "view=escalations&status=escalated",
      "search=" + "x".repeat(201), "search=a%00b", "limit=5&limit=6", "sort=newest&sort=oldest",
    ];
    for (const qs of bads) {
      fake.queryLog.length = 0;
      const r = await page(cookie, db, qs);
      assert.equal(r.status, 400, qs);
      assert.equal(r.body.error.code, "invalid_query", qs);
      assert.equal(fake.queryLog.length, 0, `${qs}: no Firestore access`);
    }
    // a hostile-looking but legal search is just text, matched in memory, never a query
    const r = await page(cookie, db, `search=${encodeURIComponent("' OR 1=1 /*  support_tickets/x")}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.tickets.length, 0);
  });
});

/* ------------------------------ authentication and cross-site protection ------------------------------ */

test("both read routes require a session, refuse cross-site requests, and touch Firestore only after both checks", async () => {
  const { db, fake } = seed(5);
  const handlers: [string, (r: Request) => Promise<Response>][] = [
    ["/api/tickets?limit=5", (r) => handleTicketListRequest(r, { db, nowMs: NOW })],
    ["/api/overview?tz=UTC", (r) => handleOverviewRequest(r, { db, nowMs: NOW, cache: createStatsCache() })],
  ];
  // not configured -> 503, configured but no/invalid cookie -> 401
  for (const [url, h] of handlers) {
    const res = await h(get(null, url));
    assert.equal(res.status, 503);
  }
  await withAuth(async (cookie) => {
    for (const [url, h] of handlers) {
      assert.equal((await h(get(null, url))).status, 401, `${url} without cookie`);
      assert.equal((await h(get(`${SESSION_COOKIE}=garbage`, url))).status, 401, `${url} with a bad cookie`);
      const cross = await h(get(cookie, url, { "sec-fetch-site": "cross-site" }));
      assert.equal(cross.status, 403, `${url} cross-site`);
      assert.equal((await cross.json()).error.code, "forbidden_origin");
      const badOrigin = await h(get(cookie, url, { origin: "https://evil.example", host: "localhost" }));
      assert.equal(badOrigin.status, 403, `${url} foreign Origin`);
      assert.equal((await h(get(cookie, url, { "sec-fetch-site": "same-origin" }))).status, 200);
    }
  });
  // Every rejected request above happened before any Firestore access; only the two 200s read.
  assert.ok(fake.queryLog.length > 0);
});

/* ------------------------------ aggregate statistics ------------------------------ */

async function overview(cookie: string, db: Firestore, qs = `tz=${encodeURIComponent(LOCAL_TZ)}`, extra: Record<string, unknown> = {}) {
  const res = await handleOverviewRequest(get(cookie, `/api/overview?${qs}`), { db, nowMs: NOW, cache: createStatsCache(), ...extra });
  return { status: res.status, body: (await res.json()) as any };
}

test("stats cover the WHOLE collection (more than a page, more than 1,000, more than one scan batch) and equal an in-memory fold of every ticket", async () => {
  await withAuth(async (cookie) => {
    const N = 1730;
    const { db, fake } = seed(N, (i, d) => {
      if (i % 11 === 0) return { ...d, status: "resolved", resolvedAt: new Date(NOW).toISOString() };
      if (i % 13 === 0) { delete d.createdAt; return d; }
      return d;
    });
    fake.queryLog.length = 0;
    const { status, body } = await overview(cookie, db);
    assert.equal(status, 200);
    const everything = [...fake.data.entries()].filter(([p]) => p.startsWith(`${COL}/`)).map(([p, v]) => serializeTicket(p.split("/")[1], v));
    assert.equal(everything.length, N);
    assert.deepEqual(body.stats, statsFromTickets(everything, new Date(NOW)), "server aggregate === the same fold over every ticket");
    assert.equal(body.stats.total, N);
    assert.equal(body.partial, false);
    assert.equal(body.scanned, N);

    // how it read: document-ID order (so odd createdAt cannot hide a ticket), batches of at most 500, projected fields only
    const scans = fake.queryLog.filter((q) => q.kind === "get" && q.select);
    assert.equal(scans.length, Math.ceil(N / 500));
    for (const q of scans) {
      assert.deepEqual(q.orderBy, ["__name__ asc"]);
      assert.ok((q.limit ?? 0) <= 500);
      assert.deepEqual(q.select, [...STATS_FIELDS]);
    }
    // and the recent list is the true newest DATED tickets (undated ones cannot be ordered)
    const newest = everything.filter((t) => t.createdAt).sort((x, y) => Date.parse(y.createdAt!) - Date.parse(x.createdAt!)).slice(0, 7).map((t) => t.id);
    assert.deepEqual(ids(body.recent), newest);
  });
});

test("the Overview built from server stats equals the Overview built from the full array (cards, chart, priorities)", async () => {
  await withAuth(async (cookie) => {
    const { db, fake } = seed(400, (i, d) => (i % 7 === 0 ? { ...d, status: "resolved" } : d));
    const { body } = await overview(cookie, db);
    const everything = [...fake.data.entries()].filter(([p]) => p.startsWith(`${COL}/`)).map(([p, v]) => serializeTicket(p.split("/")[1], v))
      .sort((a, b) => Date.parse(b.createdAt!) - Date.parse(a.createdAt!));
    const fromServer = deriveOverviewFromStats(body.stats, body.recent, new Date(NOW));
    const fromArray = deriveOverview(everything, new Date(NOW));
    assert.deepEqual(fromServer, fromArray);
    assert.equal(fromServer.total, 400);
  });
});

test("resolved tickets are not open, active, urgent/high-active or awaiting review; history of escalation is kept separately", async () => {
  await withAuth(async (cookie) => {
    // 8 tickets: priorities cycle Low, Medium, High, Urgent twice; the two Urgent and one High are resolved
    const resolved = new Set([3, 7, 2]);
    const { db, fake } = seed(8, (i, d) => (resolved.has(i) ? { ...d, status: "resolved", resolvedAt: new Date(NOW).toISOString() } : d));
    const { body } = await overview(cookie, db);
    const s = body.stats;
    assert.equal(s.total, 8);
    assert.equal(s.resolved, 3);
    assert.equal(s.open, 5, "open excludes resolved");
    assert.equal(s.everEscalated, 4, "High and Urgent tickets were escalated (history)");
    assert.equal(s.activeEscalations, 1, "only the one unresolved escalation (ticket 6) is active");
    assert.equal(s.activeUrgent, 0);
    assert.equal(s.activeHigh, 1);
    // Low/Medium tickets never need approval (a legacy "awaiting_review" on them is not counted), so only High ticket 6 waits.
    assert.equal(s.awaitingReview, 1);
    const everything = [...fake.data.entries()].filter(([p]) => p.startsWith(`${COL}/`)).map(([p, v]) => serializeTicket(p.split("/")[1], v));
    assert.deepEqual(escalationMetricsFromStats(s), buildEscalationMetrics(8, selectEscalated(everything)), "Escalations cards from server stats === cards from the full array");
  });
});

test("empty collection and all-undated collection give honest zero/undated stats, not errors", async () => {
  await withAuth(async (cookie) => {
    const empty = await overview(cookie, seed(0).db);
    assert.equal(empty.status, 200);
    assert.equal(empty.body.stats.total, 0);
    assert.deepEqual(empty.body.recent, []);
    const undated = await overview(cookie, seed(12, (_, d) => { delete d.createdAt; return d; }).db);
    assert.equal(undated.body.stats.total, 12);
    assert.equal(undated.body.stats.undated, 12);
    assert.deepEqual(undated.body.stats.byDay, {});
    assert.equal(undated.body.recent.length, 0, "undated tickets cannot be ordered into 'recent'");
  });
});

test("the scan ceiling is enforced and reported as partial instead of silently under-counting", async () => {
  await withAuth(async (cookie) => {
    const { db } = seed(1300);
    const r = await overview(cookie, db, "tz=UTC", { ceiling: 1000 });
    assert.equal(r.body.partial, true);
    assert.equal(r.body.scanned, 1000);
    assert.equal(r.body.stats.total, 1000);
    const exact = await overview(cookie, db, "tz=UTC", { ceiling: 5000 });
    assert.equal(exact.body.partial, false);
    assert.equal(exact.body.stats.total, 1300);
  });
});

test("day buckets use the requested time zone (same instant, different calendar day) and match the browser's key format", () => {
  const ms = Date.parse("2026-11-19T23:30:00Z");
  assert.equal(dayKeyFor("UTC")(ms), "2026-10-19");        // month is 0-based like Date#getMonth
  assert.equal(dayKeyFor("Africa/Harare")(ms), "2026-10-20"); // UTC+2: already the 20th
  assert.equal(dayKeyFor("America/Los_Angeles")(ms), "2026-10-19");
  const local = new Date(ms);
  assert.equal(dayKeyFor(LOCAL_TZ)(ms), `${local.getFullYear()}-${local.getMonth()}-${local.getDate()}`, "identical to the browser's own dayKey");
  assert.equal(validTimeZone("Africa/Harare"), "Africa/Harare");
  for (const bad of ["", "Mars/Olympus", "UTC; DROP", "x".repeat(80), null, 5]) assert.equal(validTimeZone(bad as any), null);
});

test("overview parameters: bad time zone / unknown parameter / bad fresh are 400 without any Firestore access", async () => {
  await withAuth(async (cookie) => {
    const { db, fake } = seed(5);
    for (const qs of ["tz=Mars/Olympus", "tz=" + "x".repeat(100), "foo=1", "fresh=yes", "tz=UTC&tz=UTC"]) {
      fake.queryLog.length = 0;
      const r = await overview(cookie, db, qs);
      assert.equal(r.status, 400, qs);
      assert.equal(r.body.error.code, "invalid_query");
      assert.equal(fake.queryLog.length, 0);
    }
  });
});

test("the stats cache saves reads (shared in-flight scan, TTL), `fresh` bypasses it, and resolving a ticket invalidates it", async () => {
  await withAuth(async (cookie) => {
    const { db, fake } = seed(30);
    fake.seed(`${COL}/target`, ticketDoc(500, { status: "pending_review" }));
    const reads = () => fake.queryLog.filter((q) => q.kind === "get" && q.select).length;
    const cache = createStatsCache(60_000);
    const call = (qs = "tz=UTC") => overview(cookie, db, qs, { cache });

    fake.queryLog.length = 0;
    const [a, b] = await Promise.all([call(), call()]); // concurrent: one scan
    assert.equal(reads(), 1, "concurrent requests share a single scan");
    assert.equal(a.body.stats.resolved, 0);
    assert.equal(b.body.stats.total, 31);
    await call();
    assert.equal(reads(), 1, "within the TTL no new scan");
    await call("tz=UTC&fresh=1");
    assert.equal(reads(), 2, "fresh=1 recomputes");
    await call("tz=Africa/Harare");
    assert.equal(reads(), 3, "a different time zone is a different cache entry");

    // Resolving through the real B3 handler clears the process-wide cache the real route uses.
    const route = (qs = "tz=UTC") => handleOverviewRequest(get(cookie, `/api/overview?${qs}`), { db, nowMs: NOW });
    invalidateTicketStats();
    const before = await (await route()).json();
    assert.equal(before.stats.resolved, 0);
    const resolve = await handleResolutionRequest(
      new Request("http://localhost/api/tickets/target/resolution", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ action: "resolve" }) }),
      "target",
      { db, nowMs: NOW },
    );
    assert.equal(resolve.status, 200, await resolve.clone().text());
    const after = await (await route()).json();
    assert.equal(after.stats.resolved, 1, "the cached figures were dropped when the ticket was resolved");
    assert.equal(after.stats.open, 30);
  });
});

/* ------------------------------ error handling ------------------------------ */

test("Firestore failures on both read routes become safe JSON errors (no stack, no internals); missing credentials is a clear 503", async () => {
  await withAuth(async (cookie) => {
    const failing = (code: unknown, message: string) => {
      const { db } = seed(3);
      const boom = () => { throw Object.assign(new Error(message), { code }); };
      (db as any).collection = () => ({ orderBy: boom, count: boom, doc: boom, limit: boom, select: boom });
      return db;
    };
    const cases: [unknown, number, string][] = [[14, 503, "firestore_unavailable"], [7, 500, "firestore_permission_denied"], [5, 500, "firestore_not_found"], [undefined, 500, "firestore_error"]];
    for (const [code, status, expected] of cases) {
      const db = failing(code, "INTERNAL secret detail /srv/key.json");
      const origError = console.error;
      console.error = () => {};
      try {
        for (const res of [
          await handleTicketListRequest(get(cookie, "/api/tickets?limit=5"), { db, nowMs: NOW }),
          await handleOverviewRequest(get(cookie, "/api/overview?tz=UTC"), { db, nowMs: NOW, cache: createStatsCache() }),
        ]) {
          const text = await res.text();
          assert.equal(res.status, status, text);
          assert.equal(JSON.parse(text).error.code, expected);
          assert.ok(!/secret detail|key\.json|stack|at \w+ \(/.test(text), "no internals leak to the browser");
          assert.equal(res.headers.get("cache-control"), "no-store");
        }
      } finally { console.error = origError; }
    }
    // no injected db and no Firebase credentials in the test environment: the standard 503
    const res = await handleTicketListRequest(get(cookie, "/api/tickets"));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "firebase_not_configured");
  });
});

test("a failed scan is not cached: the next request retries instead of serving the error", async () => {
  await withAuth(async (cookie) => {
    const { db, fake } = seed(10);
    const cache = createStatsCache(60_000);
    const real = (db as any).collection;
    let fail = true;
    (db as any).collection = (p: string) => { if (fail) throw Object.assign(new Error("x"), { code: 14 }); return real(p); };
    const origError = console.error; console.error = () => {};
    try {
      assert.equal((await handleOverviewRequest(get(cookie, "/api/overview?tz=UTC"), { db, nowMs: NOW, cache })).status, 503);
      fail = false;
      const ok = await handleOverviewRequest(get(cookie, "/api/overview?tz=UTC"), { db, nowMs: NOW, cache });
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).stats.total, 10);
    } finally { console.error = origError; }
    assert.ok(fake.queryLog.length > 0);
  });
});
