/* eslint-disable @typescript-eslint/no-explicit-any -- tests read untyped stored documents and dynamic route modules */
// Explicit ticket resolution (and reopening). The backend tests run the REAL request handler (the one the route file
// calls) against an in-memory Firestore, so authentication, same-origin, validation, the transaction and the error
// mapping are all exercised together. What they do not prove: real Firestore transaction semantics (the fake
// serialises transactions, as Firestore's retry-on-conflict guarantees) or how the React components render.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { hashPassword } from "@/lib/auth/password";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { applyResolutionAction } from "@/lib/firestore-ticket-resolution";
import { TicketNotFoundError } from "@/lib/firestore-tickets";
import { handleResolutionRequest } from "@/lib/ticket-resolution-api";
import { buildResolutionView, decideResolution, parseResolutionRequest } from "@/lib/ticket-resolution";
import { ResponseWorkflowError } from "@/lib/response-workflow";
import { serializeTicket, toIsoOrNull } from "@/lib/ticket-serialization";
import { buildMetrics, deriveOverview, displayStatus, isActiveEscalation, isAwaitingReview, isEscalated, isOpen, isResolved } from "@/lib/overview";
import { applyFilters, DEFAULT_FILTERS, indexTickets } from "@/lib/tickets-list";
import {
  applyEscalationFilters,
  buildEscalationMetrics,
  DEFAULT_ESCALATION_FILTERS,
  indexEscalations,
  selectEscalated,
} from "@/lib/escalations";
import { buildTicketDetail } from "@/lib/ticket-detail";
import { changeResolution } from "@/lib/api/ticket-response";
import type { SupportTicketRecord } from "@/lib/types";
import { FakeFirestore } from "./fake-firestore";

const SECRET = "k".repeat(48);
const NOW = Date.parse("2026-11-19T09:42:00Z");
const TID = "ticket_1";
const T = `support_tickets/${TID}`;
const EV = `${T}/response_events/`;

/* ---------------------------------- harness ---------------------------------- */

let hashPromise: Promise<string> | null = null;
const passwordHash = () => (hashPromise ??= hashPassword("correct horse battery"));

async function withAuth<T>(fn: (cookie: string) => Promise<T>, extra: Record<string, string | undefined> = {}): Promise<T> {
  const saved = { ...process.env };
  const hash = await passwordHash();
  Object.assign(process.env, { AUTH_USERNAME: "admin", AUTH_PASSWORD_HASH: hash, AUTH_SESSION_SECRET: SECRET });
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try {
    const token = await createSessionToken("admin", `${SECRET}\n${hash}`, Date.now());
    return await fn(`${SESSION_COOKIE}=${token}`);
  } finally { process.env = saved; }
}

function req(body: unknown, headers: Record<string, string> = {}, raw?: string): Request {
  return new Request("http://localhost/api/tickets/x/resolution", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw ?? JSON.stringify(body),
  });
}

/** An escalated, approval-required ticket whose reply was already sent: history worth protecting. */
function seedTicket(overrides: Record<string, unknown> = {}) {
  const fake = new FakeFirestore();
  fake.seed(T, {
    customerName: "Ada", customerEmail: "ada@example.com", message: "App crashes", priority: "High", category: "Bug", summary: "Crash",
    customerResponse: "Original AI reply", aiResponse: "Original AI reply",
    status: "pending_review", createdAt: Timestamp.fromMillis(NOW - 86_400_000),
    escalationStatus: "required", escalationRequired: true, escalationReason: "High priority", escalatedAt: Timestamp.fromMillis(NOW - 86_000_000),
    reviewStatus: "approved", finalResponse: "Edited reply", responseStatus: "sent", responseSentAt: Timestamp.fromMillis(NOW - 3_600_000),
    responseSendId: "key-1", responseAttempts: 1, responseConfirmedBy: "agent",
    ...overrides,
  });
  fake.seed(`${EV}old1`, { type: "review_approve", actor: "admin", at: Timestamp.fromMillis(NOW - 7_000_000) });
  fake.seed(`${EV}old2`, { type: "send_outcome", actor: "system", at: Timestamp.fromMillis(NOW - 3_600_000), result: "sent" });
  fake.seed(`${T}/messages/m1`, { content: "Follow-up", status: "sent" });
  return { fake, db: fake as unknown as Firestore };
}

const events = (fake: FakeFirestore) =>
  [...fake.data.entries()].filter(([p]) => p.startsWith(EV)).map(([p, v]) => ({ path: p, ...v }) as any);
/** A stored Firestore Timestamp (a plain {_seconds,_nanoseconds} object once read back) as epoch ms. */
const ms = (v: unknown) => Date.parse(toIsoOrNull(v)!);
const writesSince = (fake: FakeFirestore, n: number) => fake.writes.slice(n);

/** Calls the real handler with a valid session. */
const resolveVia = (db: Firestore, body: unknown, nowMs = NOW, id = TID, headers: Record<string, string> = {}) =>
  withAuth((cookie) => handleResolutionRequest(req(body, { cookie, ...headers }), id, { db, nowMs }));
/** Several requests at the same moment, under ONE session setup (the environment is process-wide). */
const resolveConcurrently = (db: Firestore, calls: { body: unknown; nowMs: number }[]) =>
  withAuth((cookie) => Promise.all(calls.map((c) => handleResolutionRequest(req(c.body, { cookie }), TID, { db, nowMs: c.nowMs }))));
const errCode = async (res: Response) => (await res.json()).error?.code;

/* ------------------------------ successful resolution ------------------------------ */

test("resolving persists status, resolvedAt and resolvedBy, and answers with the updated ticket", async () => {
  const { fake, db } = seedTicket();
  const res = await resolveVia(db, { action: "resolve" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const { ticket } = await res.json();
  assert.equal(ticket.id, TID);
  assert.equal(ticket.status, "resolved");
  assert.equal(ticket.resolvedAt, new Date(NOW).toISOString());
  assert.equal(ticket.resolvedBy, "admin");

  const stored = fake.read(T)!;
  assert.equal(stored.status, "resolved");
  assert.equal(stored.resolvedBy, "admin");
  assert.equal(ms(stored.resolvedAt), NOW, "stored as a Firestore Timestamp");
  assert.equal(stored.statusBeforeResolution, "pending_review");
  assert.ok(isResolved(serializeTicket(TID, stored)));
});

test("the API never exposes the internal statusBeforeResolution bookkeeping", async () => {
  const { db } = seedTicket();
  const { ticket } = await (await resolveVia(db, { action: "resolve" })).json();
  assert.equal("statusBeforeResolution" in ticket, false);
  assert.equal(JSON.stringify(ticket).includes("pending_review"), false);
});

test("resolving writes exactly one audit event, in the same transaction as the change", async () => {
  const { fake, db } = seedTicket();
  const before = events(fake).length;
  await resolveVia(db, { action: "resolve" });
  const added = events(fake).filter((e) => e.type === "ticket_resolved");
  assert.equal(events(fake).length, before + 1);
  assert.equal(added.length, 1);
  assert.equal(added[0].actor, "admin");
  assert.equal(added[0].previousStatus, "pending_review");
  assert.equal(added[0].escalated, true);
  assert.equal(added[0].escalationStatus, "required");
  assert.equal(ms(added[0].at), NOW);
});

/* ------------------------- authentication and authorisation ------------------------- */

test("unauthenticated, forged, expired and non-admin requests are refused before anything is read or written", async () => {
  const { fake, db } = seedTicket();
  const baseline = fake.writes.length;
  const hash = await passwordHash();
  const key = `${SECRET}\n${hash}`;
  const cases: Record<string, string | null> = {
    "no cookie": null,
    "empty cookie": `${SESSION_COOKIE}=`,
    "garbage token": `${SESSION_COOKIE}=not.a.token`,
    "signed with another secret": `${SESSION_COOKIE}=${await createSessionToken("admin", "y".repeat(48), Date.now())}`,
    "valid signature, different user": `${SESSION_COOKIE}=${await createSessionToken("someone-else", key, Date.now())}`,
    expired: `${SESSION_COOKIE}=${await createSessionToken("admin", key, Date.now() - 10 * 3600_000)}`,
  };
  await withAuth(async () => {
    for (const [label, cookie] of Object.entries(cases)) {
      const res = await handleResolutionRequest(req({ action: "resolve" }, cookie ? { cookie } : {}), TID, { db, nowMs: NOW });
      assert.equal(res.status, 401, label);
      assert.equal(await errCode(res), "unauthenticated", label);
    }
  });
  assert.equal(writesSince(fake, baseline).length, 0);
  assert.equal(fake.read(T)!.status, "pending_review");
});

test("when sign-in isn't configured the route fails closed (503), never open", async () => {
  const { fake, db } = seedTicket();
  const baseline = fake.writes.length;
  const saved = { ...process.env };
  delete process.env.AUTH_USERNAME; delete process.env.AUTH_PASSWORD_HASH; delete process.env.AUTH_SESSION_SECRET;
  try {
    const res = await handleResolutionRequest(req({ action: "resolve" }), TID, { db, nowMs: NOW });
    assert.equal(res.status, 503);
    assert.equal(await errCode(res), "auth_not_configured");
  } finally { process.env = saved; }
  assert.equal(writesSince(fake, baseline).length, 0);
});

test("cross-site and non-JSON requests are refused even with a valid session", async () => {
  const { fake, db } = seedTicket();
  const baseline = fake.writes.length;
  for (const h of <Record<string, string>[]>[{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: "https://evil.example", host: "localhost" }]) {
    const res = await resolveVia(db, { action: "resolve" }, NOW, TID, h);
    assert.equal(res.status, 403, JSON.stringify(h));
    assert.equal(await errCode(res), "forbidden_origin");
  }
  const res = await withAuth((cookie) => handleResolutionRequest(req(undefined, { cookie, "content-type": "text/plain" }, "action=resolve"), TID, { db, nowMs: NOW }));
  assert.equal(res.status, 415);
  assert.equal(writesSince(fake, baseline).length, 0);
});

/* ------------------------------- request validation ------------------------------- */

test("invalid ticket IDs are refused with 400 before Firestore is touched", async () => {
  const { fake, db } = seedTicket();
  const baseline = fake.writes.length;
  for (const id of ["", "a/b", "..", ".", "__reserved__", "x".repeat(1501)]) {
    const res = await resolveVia(db, { action: "resolve" }, NOW, id);
    assert.equal(res.status, 400, JSON.stringify(id.slice(0, 20)));
    assert.equal(await errCode(res), "invalid_ticket_id");
  }
  assert.equal(writesSince(fake, baseline).length, 0);
});

test("a missing, unknown or malformed action is a 400 and writes nothing", async () => {
  const { fake, db } = seedTicket();
  const baseline = fake.writes.length;
  for (const body of [{}, { action: "close" }, { action: "RESOLVE" }, { action: "" }, { action: null }, { action: ["resolve"] }, { action: { x: 1 } }, [], "resolve", null, 5]) {
    const res = await resolveVia(db, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(await errCode(res), "invalid_action");
  }
  for (const raw of ["", "   ", "{not json"]) {
    const res = await withAuth((cookie) => handleResolutionRequest(req(undefined, { cookie }, raw), TID, { db, nowMs: NOW }));
    assert.equal(res.status, 400, JSON.stringify(raw));
    assert.equal(await errCode(res), "invalid_json");
  }
  assert.equal(writesSince(fake, baseline).length, 0);
  assert.equal(fake.read(T)!.status, "pending_review");
});

test("an oversized body is refused (413)", async () => {
  const { db } = seedTicket();
  const res = await withAuth((cookie) => handleResolutionRequest(req({ action: "resolve", pad: "x".repeat(70_000) }, { cookie }), TID, { db, nowMs: NOW }));
  assert.equal(res.status, 413);
});

test("parseResolutionRequest reads only `action`", () => {
  assert.equal(parseResolutionRequest({ action: "resolve", status: "x", resolvedBy: "evil" }), "resolve");
  assert.equal(parseResolutionRequest({ action: "reopen" }), "reopen");
  assert.throws(() => parseResolutionRequest(undefined), (e: unknown) => e instanceof ResponseWorkflowError && e.code === "invalid_action");
});

test("arbitrary request fields cannot overwrite ticket data: only the four resolution fields change", async () => {
  const { fake, db } = seedTicket();
  const before = structuredClone(fake.read(T)!);
  const res = await resolveVia(db, {
    action: "resolve", status: "pending_review", resolvedBy: "mallory", resolvedAt: "1999-01-01T00:00:00Z", id: "other_ticket",
    escalationStatus: "not_required", escalationReason: "wiped", reviewStatus: "rejected", finalResponse: "owned", responseStatus: "draft",
    aiResponse: "owned", customerResponse: "owned", customerEmail: "evil@example.com", priority: "Low", "responseAttempts": 0, "__proto__": { admin: true },
  });
  assert.equal(res.status, 200);
  const after = fake.read(T)!;
  const changed = Object.keys({ ...before, ...after }).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
  assert.deepEqual(changed, ["resolvedAt", "resolvedBy", "status", "statusBeforeResolution"]);
  assert.equal(after.resolvedBy, "admin", "resolvedBy comes from the session, never the body");
  assert.equal(ms(after.resolvedAt), NOW, "resolvedAt comes from the server clock, never the body");
  assert.equal(fake.read("support_tickets/other_ticket"), undefined);
});

/* ------------------------------ missing ticket ------------------------------ */

test("a ticket that doesn't exist is a 404, and nothing is created for it", async () => {
  const { fake, db } = seedTicket();
  const baseline = fake.writes.length;
  const res = await resolveVia(db, { action: "resolve" }, NOW, "no_such_ticket");
  assert.equal(res.status, 404);
  assert.equal(await errCode(res), "ticket_not_found");
  assert.equal(fake.read("support_tickets/no_such_ticket"), undefined);
  assert.equal(writesSince(fake, baseline).length, 0);
  await assert.rejects(applyResolutionAction("no_such_ticket", "reopen", "admin", db, NOW), TicketNotFoundError);
});

/* --------------------- repeated resolution and invalid transitions --------------------- */

test("resolving twice is refused (409) and the original resolution is untouched", async () => {
  const { fake, db } = seedTicket();
  await resolveVia(db, { action: "resolve" }, NOW);
  const first = structuredClone(fake.read(T)!);
  const evCount = events(fake).length;
  const baseline = fake.writes.length;

  const res = await resolveVia(db, { action: "resolve" }, NOW + 60_000);
  assert.equal(res.status, 409);
  assert.equal(await errCode(res), "already_resolved");
  assert.deepEqual(fake.read(T), first, "resolvedAt / resolvedBy / statusBeforeResolution were not overwritten");
  assert.equal(events(fake).length, evCount, "no second event");
  assert.equal(writesSince(fake, baseline).length, 0);
});

test("a ticket already closed outside the dashboard (legacy status) can't be 'resolved' again", async () => {
  for (const status of ["resolved", "Resolved", "closed", "done", "completed", "auto_resolved"]) {
    const { fake, db } = seedTicket({ status });
    const baseline = fake.writes.length;
    const res = await resolveVia(db, { action: "resolve" });
    assert.equal(res.status, 409, status);
    assert.equal(await errCode(res), "already_resolved");
    assert.equal(writesSince(fake, baseline).length, 0);
  }
});

test("reopening a ticket that isn't resolved is refused (409) and writes nothing", async () => {
  const { fake, db } = seedTicket();
  const baseline = fake.writes.length;
  const res = await resolveVia(db, { action: "reopen" });
  assert.equal(res.status, 409);
  assert.equal(await errCode(res), "not_resolved");
  assert.equal(writesSince(fake, baseline).length, 0);
});

test("two simultaneous resolve requests: exactly one succeeds, one event, one resolvedAt", async () => {
  const { fake, db } = seedTicket();
  const [a, b] = await resolveConcurrently(db, [{ body: { action: "resolve" }, nowMs: NOW }, { body: { action: "resolve" }, nowMs: NOW + 5 }]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(events(fake).filter((e) => e.type === "ticket_resolved").length, 1);
  assert.equal(ms(fake.read(T)!.resolvedAt), NOW);
});

test("two simultaneous reopen requests: exactly one succeeds and one reopen event is recorded", async () => {
  const { fake, db } = seedTicket();
  await resolveVia(db, { action: "resolve" }, NOW);
  const [r1, r2] = await resolveConcurrently(db, [{ body: { action: "reopen" }, nowMs: NOW + 10 }, { body: { action: "reopen" }, nowMs: NOW + 11 }]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.equal(events(fake).filter((e) => e.type === "ticket_reopened").length, 1);
  assert.equal(isResolved(serializeTicket(TID, fake.read(T)!)), false);
});

test("an email that is mid-send, or whose delivery is unconfirmed, must be settled before resolving", async () => {
  const cases: [string, Record<string, unknown>, number, string][] = [
    ["fresh sending claim", { responseStatus: "sending", responseQueuedAt: Timestamp.fromMillis(NOW - 5_000) }, 409, "send_in_progress"],
    ["stale sending claim reads as unknown", { responseStatus: "sending", responseQueuedAt: Timestamp.fromMillis(NOW - 10 * 60_000) }, 409, "delivery_unconfirmed"],
    ["sending with no claim time reads as unknown", { responseStatus: "sending" }, 409, "delivery_unconfirmed"],
    ["queued", { responseStatus: "queued" }, 409, "delivery_unconfirmed"],
    ["unknown", { responseStatus: "unknown" }, 409, "delivery_unconfirmed"],
    ["sent is fine", { responseStatus: "sent" }, 200, ""],
    ["failed (known not delivered) is fine", { responseStatus: "failed" }, 200, ""],
    ["draft is fine", { responseStatus: "draft" }, 200, ""],
    ["no response record at all is fine", { responseStatus: undefined, reviewStatus: "awaiting_review", finalResponse: undefined }, 200, ""],
  ];
  for (const [label, overrides, status, code] of cases) {
    const { fake, db } = seedTicket(overrides);
    const baseline = fake.writes.length;
    const res = await resolveVia(db, { action: "resolve" });
    assert.equal(res.status, status, label);
    if (code) {
      assert.equal(await errCode(res), code, label);
      assert.equal(writesSince(fake, baseline).length, 0, label);
      assert.equal(fake.read(T)!.status, "pending_review", label);
    }
  }
});

test("Low/Medium tickets (no approval workflow) can be resolved too", async () => {
  const { db, fake } = seedTicket({ priority: "Low", escalationStatus: "not_required", escalationRequired: false, responseStatus: undefined, reviewStatus: "awaiting_review", finalResponse: undefined });
  assert.equal((await resolveVia(db, { action: "resolve" })).status, 200);
  assert.equal(fake.read(T)!.status, "resolved");
});

/* ----------------------- Firestore failures ----------------------- */

function failingDb(error: unknown, fake: FakeFirestore): Firestore {
  const db: any = Object.create(fake);
  db.runTransaction = async () => { throw error; };
  return db as Firestore;
}

test("Firestore failures give a clear error, leave the ticket unchanged and never leak internals", async () => {
  const cases: [unknown, number, string][] = [
    [Object.assign(new Error("14 UNAVAILABLE: connect ECONNREFUSED 10.0.0.1:443 /srv/secrets/key.json"), { code: 14 }), 503, "firestore_unavailable"],
    [Object.assign(new Error("4 DEADLINE_EXCEEDED"), { code: 4 }), 503, "firestore_unavailable"],
    [Object.assign(new Error("7 PERMISSION_DENIED: client_email=svc@project.iam"), { code: 7 }), 500, "firestore_permission_denied"],
    [Object.assign(new Error("16 UNAUTHENTICATED"), { code: 16 }), 500, "firestore_permission_denied"],
    [new Error("boom: stack at /app/src/lib/secret.ts:12"), 500, "firestore_error"],
  ];
  const quiet = console.error; console.error = () => {};
  try {
    for (const [error, status, code] of cases) {
      const { fake } = seedTicket();
      const before = structuredClone(fake.read(T)!);
      const res = await resolveVia(failingDb(error, fake), { action: "resolve" });
      assert.equal(res.status, status);
      const body = await res.json();
      assert.equal(body.error.code, code);
      assert.doesNotMatch(JSON.stringify(body), /ECONNREFUSED|secrets|client_email|stack at|\.ts:\d+/);
      assert.deepEqual(fake.read(T), before, "ticket unchanged");
      if (code === "firestore_error") assert.match(body.error.message, /no email was sent/i);
      assert.ok(body.error.requestId, "5xx carries a request id matching the server log");
    }
  } finally { console.error = quiet; }
});

test("Firestore not configured is a 503 with the missing variable names only", async () => {
  const saved = { ...process.env };
  for (const k of ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"]) delete process.env[k];
  try {
    const res = await withAuth((cookie) => handleResolutionRequest(req({ action: "resolve" }, { cookie }), TID));
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, "firebase_not_configured");
    assert.deepEqual(body.error.missing, ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"]);
  } finally { process.env = saved; }
});

test("the change and its audit event are written together, in one transaction, and nothing else is written", async () => {
  const { fake, db } = seedTicket();
  let transactions = 0;
  const realTx = fake.runTransaction.bind(fake);
  (fake as any).runTransaction = (fn: any) => { transactions++; return realTx(fn); };
  const baseline = fake.writes.length;
  await resolveVia(db, { action: "resolve" });
  assert.equal(transactions, 1);
  const w = writesSince(fake, baseline);
  assert.deepEqual(w.map((x) => x.op).sort(), ["create", "update"], "exactly one ticket update and one event create");
  assert.ok(w.some((x) => x.op === "update" && x.path === T));
  assert.ok(w.some((x) => x.op === "create" && x.path.startsWith(EV)));
});

/* ----------------- preservation of escalation, response and audit history ----------------- */

const PRESERVED = [
  "customerName", "customerEmail", "message", "priority", "category", "summary", "customerResponse", "aiResponse", "createdAt",
  "escalationStatus", "escalationRequired", "escalationReason", "escalatedAt", "reviewStatus", "finalResponse",
  "responseStatus", "responseSentAt", "responseSendId", "responseAttempts", "responseConfirmedBy",
];

test("resolving, reopening and re-resolving never alter escalation, review, response or earlier audit records", async () => {
  const { fake, db } = seedTicket();
  const before = structuredClone(fake.read(T)!);
  const oldEvents = events(fake).map((e) => structuredClone(e));
  const message = structuredClone(fake.read(`${T}/messages/m1`)!);

  for (const [action, at] of [["resolve", NOW], ["reopen", NOW + 1000], ["resolve", NOW + 2000]] as const) {
    assert.equal((await resolveVia(db, { action }, at)).status, 200);
    const now = fake.read(T)!;
    for (const k of PRESERVED) assert.deepEqual(now[k], before[k], `${k} changed after ${action}`);
  }
  for (const old of oldEvents) assert.deepEqual(events(fake).find((e) => e.path === old.path), old, "an earlier event was modified");
  assert.deepEqual(fake.read(`${T}/messages/m1`), message, "the follow-up message history is untouched");
  assert.equal(fake.writes.filter((w) => w.op === "update" && w.path !== T).length, 0, "only the ticket document is ever updated");
  assert.equal(fake.writes.filter((w) => w.op === "set").length, 0);
});

test("the dashboard still shows a resolved ticket as escalated in history, but not as an active escalation", async () => {
  const { fake, db } = seedTicket({ responseStatus: undefined });
  const { ticket } = await (await resolveVia(db, { action: "resolve" })).json();
  assert.equal(ticket.escalationStatus, "required");
  assert.equal(ticket.escalationReason, "High priority");
  assert.ok(ticket.escalatedAt);
  const stored = serializeTicket(TID, fake.read(T)!);
  assert.equal(isEscalated(stored), true);
  assert.equal(isActiveEscalation(stored), false);
  const detail = buildTicketDetail(stored);
  assert.equal(detail.escalated, true);
  assert.equal(detail.escalationActive, false);
  assert.equal(detail.resolved, true);
  assert.equal(detail.status, "resolved");
});

/* ------------------------------------ reopening ------------------------------------ */

test("reopening restores the previous status, clears the current resolution and records who and when", async () => {
  const { fake, db } = seedTicket();
  await resolveVia(db, { action: "resolve" }, NOW);
  const res = await resolveVia(db, { action: "reopen" }, NOW + 3_600_000, TID);
  assert.equal(res.status, 200);
  const { ticket } = await res.json();
  assert.equal(ticket.status, "pending_review");
  assert.equal(ticket.resolvedAt, null);
  assert.equal(ticket.resolvedBy, null);
  assert.equal(ticket.reopenedAt, new Date(NOW + 3_600_000).toISOString());
  assert.equal(ticket.reopenedBy, "admin");
  assert.equal(isResolved(ticket), false);
  assert.equal(fake.read(T)!.statusBeforeResolution, null);
});

test("reopening keeps the original resolution event and adds its own; nothing is silently erased", async () => {
  const { fake, db } = seedTicket();
  await resolveVia(db, { action: "resolve" }, NOW);
  const resolvedEvent = structuredClone(events(fake).find((e) => e.type === "ticket_resolved"));
  await resolveVia(db, { action: "reopen" }, NOW + 1000);

  assert.deepEqual(events(fake).find((e) => e.path === resolvedEvent.path), resolvedEvent, "the resolve event is unchanged");
  const reopened = events(fake).filter((e) => e.type === "ticket_reopened");
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].actor, "admin");
  assert.equal(reopened[0].previousStatus, "resolved");
  assert.equal(reopened[0].restoredStatus, "pending_review");
  assert.equal(reopened[0].previousResolvedBy, "admin");
  assert.equal(reopened[0].previousResolvedAt, new Date(NOW).toISOString(), "the reopen event records what it reversed");
  assert.equal(ms(reopened[0].at), NOW + 1000);
});

test("resolve -> reopen -> resolve: two resolve events, one reopen, latest resolution current, last reopening remembered", async () => {
  const { fake, db } = seedTicket();
  await resolveVia(db, { action: "resolve" }, NOW);
  await resolveVia(db, { action: "reopen" }, NOW + 1000);
  const { ticket } = await (await resolveVia(db, { action: "resolve" }, NOW + 2000)).json();
  assert.equal(ticket.status, "resolved");
  assert.equal(ticket.resolvedAt, new Date(NOW + 2000).toISOString());
  assert.equal(ticket.reopenedAt, new Date(NOW + 1000).toISOString());
  const types = events(fake).map((e) => e.type);
  assert.equal(types.filter((t) => t === "ticket_resolved").length, 2);
  assert.equal(types.filter((t) => t === "ticket_reopened").length, 1);
  // The second resolution restored from the real earlier status, not from "resolved".
  assert.equal(fake.read(T)!.statusBeforeResolution, "pending_review");
});

test("reopening a ticket that was closed outside the dashboard (no remembered status) falls back to 'open', and is audited", async () => {
  for (const [status, remembered] of [["resolved", undefined], ["closed", undefined], ["resolved", "resolved"], ["resolved", "closed"], ["resolved", "  "], ["resolved", 7]] as const) {
    const { fake, db } = seedTicket({ status, ...(remembered === undefined ? {} : { statusBeforeResolution: remembered }), responseStatus: undefined });
    const res = await resolveVia(db, { action: "reopen" });
    assert.equal(res.status, 200, `${status}/${remembered}`);
    assert.equal(fake.read(T)!.status, "open", "never 'restored' into a finished status");
    const ev = events(fake).find((e) => e.type === "ticket_reopened");
    assert.equal(ev.previousStatus, status);
    assert.equal(ev.previousResolvedAt, null);
  }
});

test("repeated reopen is refused (409); reopening doesn't touch the email or escalation records", async () => {
  const { fake, db } = seedTicket();
  await resolveVia(db, { action: "resolve" }, NOW);
  await resolveVia(db, { action: "reopen" }, NOW + 1);
  const snapshot = structuredClone(fake.read(T)!);
  const res = await resolveVia(db, { action: "reopen" }, NOW + 2);
  assert.equal(res.status, 409);
  assert.equal(await errCode(res), "not_resolved");
  assert.deepEqual(fake.read(T), snapshot);
});

/* ----------------------------- no email, no n8n, no send changes ----------------------------- */

test("resolving and reopening make no network call (no email, no n8n)", async () => {
  const { fake, db } = seedTicket();
  const eventsBefore = events(fake).length;
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("network must not be used"); }) as typeof fetch;
  try {
    await resolveVia(db, { action: "resolve" }, NOW);
    await resolveVia(db, { action: "reopen" }, NOW + 1);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls, 0);
  assert.equal([...fake.data.keys()].some((p) => p.startsWith("n8n_send_log")), false, "no send claim or record was created");
  const added = events(fake).slice(eventsBefore).map((e) => e.type);
  assert.equal(events(fake).length, eventsBefore + 2);
  assert.deepEqual(events(fake).filter((e) => !e.path.endsWith("old1") && !e.path.endsWith("old2")).map((e) => e.type).sort(), ["ticket_reopened", "ticket_resolved"], `only resolution events were added (${added.join(",")})`);
});

test("the resolution code does not import or reference the send workflow, the n8n webhook or any workflow file", () => {
  const files = [
    "src/lib/ticket-resolution.ts", "src/lib/firestore-ticket-resolution.ts", "src/lib/ticket-resolution-api.ts",
    "src/app/api/tickets/[id]/resolution/route.ts", "src/hooks/use-resolution.ts", "src/components/tickets/resolution-panel.tsx",
  ];
  for (const f of files) {
    const src = readFileSync(join(process.cwd(), f), "utf8");
    assert.doesNotMatch(src, /n8n-send-response|callSendWebhook|readWebhookConfig|buildWebhookPayload|claimResponseSend|recordSendOutcome|decideSendClaim|N8N_|\bfetch\(/, f);
    assert.doesNotMatch(src, /n8n\/|\.json["']/, f);
  }
});

test("the confirmation step exists: the first click only asks, and the UI says no email will be sent", () => {
  const hook = readFileSync(join(process.cwd(), "src/hooks/use-resolution.ts"), "utf8");
  const panel = readFileSync(join(process.cwd(), "src/components/tickets/resolution-panel.tsx"), "utf8");
  assert.match(panel, /onClick=\{\(\) => r\.ask\("resolve"\)\}/, "the main button asks");
  assert.doesNotMatch(panel, /onClick=\{\(\) => r\.confirm|onClick=\{r\.ask/, "no button resolves in one click");
  assert.match(panel, /Yes, mark as resolved/);
  assert.match(panel, /No email will be sent/);
  assert.match(hook, /if \(!confirming \|\| busy\) return;/, "confirm does nothing unless a confirmation is pending");
});

/* ---------------------------------- browser client ---------------------------------- */

test("the browser client sends only the action, and surfaces the server's message on failure", async () => {
  const realFetch = globalThis.fetch;
  const sent: { url: string; body: string; method: string }[] = [];
  let next: Response = new Response(JSON.stringify({ ticket: { id: "t 1", status: "resolved" } }), { status: 200 });
  globalThis.fetch = (async (url: any, init: any) => { sent.push({ url: String(url), body: init.body, method: init.method }); return next; }) as typeof fetch;
  try {
    const ok = await changeResolution("t 1", "resolve");
    assert.equal(ok.status, "resolved");
    assert.equal(sent[0].url, "/api/tickets/t%201/resolution");
    assert.equal(sent[0].method, "POST");
    assert.deepEqual(JSON.parse(sent[0].body), { action: "resolve" });

    next = new Response(JSON.stringify({ error: { code: "already_resolved", message: "This ticket is already resolved." } }), { status: 409 });
    await assert.rejects(changeResolution("t1", "resolve"), (e: any) => e.status === 409 && e.code === "already_resolved" && e.message === "This ticket is already resolved.");

    next = new Response(JSON.stringify({ nope: true }), { status: 200 });
    await assert.rejects(changeResolution("t1", "reopen"), (e: any) => e.code === "invalid_response");

    next = new Response("<html>bad gateway</html>", { status: 502 });
    await assert.rejects(changeResolution("t1", "resolve"), (e: any) => e.code === "unknown_error" && e.status === 502);

    globalThis.fetch = (async () => { throw new TypeError("offline"); }) as typeof fetch;
    await assert.rejects(changeResolution("t1", "resolve"), (e: any) => e.code === "network_error");
  } finally { globalThis.fetch = realFetch; }
});

/* --------------------------- pure rules and the page's view model --------------------------- */

test("decideResolution refuses invalid transitions without producing any fields", () => {
  const open = { status: "pending_review" };
  const done = { status: "resolved", statusBeforeResolution: "pending_review" };
  assert.throws(() => decideResolution(done, "resolve", NOW, "admin"), (e: unknown) => e instanceof ResponseWorkflowError && e.code === "already_resolved");
  assert.throws(() => decideResolution(open, "reopen", NOW, "admin"), (e: unknown) => e instanceof ResponseWorkflowError && e.code === "not_resolved");
  assert.throws(() => decideResolution({}, "reopen", NOW, "admin"), (e: unknown) => e instanceof ResponseWorkflowError && e.code === "not_resolved");
  assert.throws(() => decideResolution(open, "resolve", NOW, ""), /signed-in user/);
  assert.throws(() => decideResolution(open, "resolve", NOW, "   "), /signed-in user/);
  // A ticket with no stored status at all can still be resolved (and reopens to "open").
  const d = decideResolution({}, "resolve", NOW, "admin");
  assert.equal(d.fields.statusBeforeResolution, null);
  assert.deepEqual(Object.keys(d.fields).sort(), ["resolvedAt", "resolvedBy", "status", "statusBeforeResolution"]);
});

test("buildResolutionView reports what the page may offer", () => {
  const base: SupportTicketRecord = { id: "a", status: "pending_review", escalationStatus: "required" };
  const open = buildResolutionView(base, NOW);
  assert.deepEqual([open.resolved, open.canResolve, open.canReopen, open.wasEscalated, open.activeEscalation], [false, true, false, true, true]);

  const done = buildResolutionView({ ...base, status: "resolved", resolvedAt: "2026-11-19T09:00:00.000Z", resolvedBy: "admin" }, NOW);
  assert.deepEqual([done.resolved, done.canResolve, done.canReopen, done.wasEscalated, done.activeEscalation], [true, false, true, true, false]);
  assert.equal(done.resolvedBy, "admin");

  const sending = buildResolutionView({ ...base, responseStatus: "sending", responseQueuedAt: new Date(NOW - 1000).toISOString() }, NOW);
  assert.equal(sending.canResolve, false);
  assert.match(sending.resolveBlockedReason!, /being sent/);
  const unsettled = buildResolutionView({ ...base, responseStatus: "queued" }, NOW);
  assert.equal(unsettled.canResolve, false);
  assert.match(unsettled.resolveBlockedReason!, /delivered/);
  // A sending claim goes stale into "unknown" with time, exactly as on the server.
  assert.match(buildResolutionView({ ...base, responseStatus: "sending", responseQueuedAt: new Date(NOW - 600_000).toISOString() }, NOW).resolveBlockedReason!, /delivered/);
});

/* ---------- dashboard consistency: status, filters, counts, escalations ---------- */

const rec = (o: Partial<SupportTicketRecord> & { id: string }): SupportTicketRecord => ({
  status: "pending_review", priority: "low", category: "billing_issue", createdAt: "2026-11-18T09:00:00.000Z", ...o,
});
const SET: SupportTicketRecord[] = [
  rec({ id: "esc_active_urgent", priority: "urgent", escalationStatus: "required", escalationRequired: true, escalatedAt: "2026-11-18T10:00:00.000Z", reviewStatus: "awaiting_review", category: "bug" }),
  rec({ id: "esc_active_high", priority: "high", escalationStatus: "required", escalationRequired: true, escalatedAt: "2026-11-18T11:00:00.000Z", reviewStatus: "awaiting_review" }),
  rec({ id: "esc_resolved_urgent", priority: "urgent", escalationStatus: "required", escalationRequired: true, escalatedAt: "2026-11-17T10:00:00.000Z", reviewStatus: "approved", status: "resolved", resolvedAt: "2026-11-18T12:00:00.000Z", resolvedBy: "admin" }),
  rec({ id: "esc_resolved_high", priority: "high", escalationStatus: "required", escalationRequired: true, escalatedAt: "2026-11-17T09:00:00.000Z", reviewStatus: "awaiting_review", status: "resolved", resolvedAt: "2026-11-18T12:05:00.000Z", resolvedBy: "admin" }),
  rec({ id: "await_active", priority: "high", reviewStatus: "awaiting_review" }),
  rec({ id: "await_resolved", priority: "high", reviewStatus: "awaiting_review", status: "resolved", resolvedAt: "2026-11-18T12:10:00.000Z", resolvedBy: "admin" }),
  rec({ id: "plain_open", status: "open" }),
  rec({ id: "plain_new", status: "new" }),
  rec({ id: "plain_resolved", status: "resolved", resolvedAt: "2026-11-18T12:20:00.000Z", resolvedBy: "admin" }),
];
const NOW_D = new Date("2026-11-19T09:42:00Z");

test("status: resolved takes precedence over escalated and awaiting review; unresolved tickets are unchanged", () => {
  const status = Object.fromEntries(SET.map((t) => [t.id, displayStatus(t)]));
  assert.deepEqual(status, {
    esc_active_urgent: "escalated", esc_active_high: "escalated", esc_resolved_urgent: "resolved", esc_resolved_high: "resolved",
    await_active: "awaiting_review", await_resolved: "resolved", plain_open: "open", plain_new: "new", plain_resolved: "resolved",
  });
  assert.equal(isAwaitingReview(SET[5]), false, "a resolved ticket isn't waiting for review");
  assert.equal(isAwaitingReview(SET[4]), true);
});

test("All Tickets filters: every ticket has exactly one status, and the filter counts add up to the total", () => {
  const index = indexTickets(SET, NOW_D);
  const ids = (status: any) => applyFilters(index, { ...DEFAULT_FILTERS, status }).map((r) => r.id).sort();
  assert.deepEqual(ids("resolved"), ["await_resolved", "esc_resolved_high", "esc_resolved_urgent", "plain_resolved"]);
  assert.deepEqual(ids("escalated"), ["esc_active_high", "esc_active_urgent"], "resolved escalations are not 'escalated' any more");
  assert.deepEqual(ids("awaiting_review"), ["await_active"]);
  assert.deepEqual(ids("open"), ["plain_open"]);
  assert.deepEqual(ids("new"), ["plain_new"]);
  const total = (["new", "open", "awaiting_review", "escalated", "resolved"] as const).reduce((n, s) => n + ids(s).length, 0);
  assert.equal(total, SET.length);
  // Every row in the table agrees with the filter that finds it.
  for (const row of applyFilters(index, DEFAULT_FILTERS)) assert.equal(row.status, displayStatus(SET.find((t) => t.id === row.id)!));
});

test("Overview counts agree with the All Tickets filters and with the Escalations page", () => {
  const m = Object.fromEntries(buildMetrics(SET, NOW_D).map((x) => [x.id, x]));
  const index = indexTickets(SET, NOW_D);
  const count = (status: any) => applyFilters(index, { ...DEFAULT_FILTERS, status }).length;

  assert.equal(m.total.value, SET.length);
  assert.equal(m.open.value, SET.length - count("resolved"), "open = everything not resolved");
  assert.equal(m.open.value, SET.filter(isOpen).length);
  assert.equal(m.escalated.value, count("escalated"), "the Overview escalation count = the 'Escalated' filter");
  // "Awaiting review" counts every unresolved ticket waiting on a person (even one also shown as Escalated).
  assert.equal(m.awaiting_review.value, SET.filter(isAwaitingReview).length);
  assert.equal(m.awaiting_review.value, 3, "the two resolved tickets with a stored awaiting_review are not counted");
  assert.equal(m.escalated.label, "Active escalations");
  assert.equal(m.escalated.footer, "2 resolved of 4 escalated", "history is still visible next to the current count");

  const esc = Object.fromEntries(buildEscalationMetrics(SET.length, selectEscalated(SET)).map((x) => [x.id, x]));
  assert.equal(esc.escalations_awaiting_attention.value, m.escalated.value, "Escalations 'Awaiting attention' = Overview 'Active escalations'");
  assert.equal(deriveOverview(SET, NOW_D).metrics.find((x) => x.id === "open")!.value, m.open.value);
});

test("Escalations page: history keeps resolved escalations, current counts don't include them", () => {
  const escalated = selectEscalated(SET);
  assert.deepEqual(escalated.map((t) => t.id).sort(), ["esc_active_high", "esc_active_urgent", "esc_resolved_high", "esc_resolved_urgent"]);

  const esc = Object.fromEntries(buildEscalationMetrics(SET.length, escalated).map((x) => [x.id, x]));
  assert.equal(esc.escalations_total.value, 4, "historical total includes resolved");
  assert.equal(esc.escalations_urgent.value, 1, "active urgent only");
  assert.equal(esc.escalations_high.value, 1, "active high only");
  assert.equal(esc.escalations_awaiting_attention.value, 2);

  const indexed = indexEscalations(escalated, NOW_D);
  const rows = (status: any) => applyEscalationFilters(indexed, { ...DEFAULT_ESCALATION_FILTERS, status });
  assert.equal(rows("all").length, 4, "the default view still lists every escalation");
  assert.deepEqual(rows("active").map((r) => r.id).sort(), ["esc_active_high", "esc_active_urgent"]);
  assert.deepEqual(rows("resolved").map((r) => r.id).sort(), ["esc_resolved_high", "esc_resolved_urgent"]);
  assert.equal(rows("active").length + rows("resolved").length, rows("all").length);
  for (const r of rows("all")) {
    const t = SET.find((x) => x.id === r.id)!;
    assert.equal(r.resolved, isResolved(t));
    assert.equal(r.statusTone === "resolved", isResolved(t), "the status dot says resolved only for resolved tickets");
  }
  assert.equal(rows("resolved").every((r) => r.statusLabel === "Resolved" && r.statusTone === "resolved"), true);
  // Filters combine.
  assert.deepEqual(applyEscalationFilters(indexed, { ...DEFAULT_ESCALATION_FILTERS, status: "resolved", priority: "high" }).map((r) => r.id), ["esc_resolved_high"]);
});

test("end to end: resolving through the API moves a ticket between every dashboard view, and reopening moves it back", async () => {
  const { fake, db } = seedTicket({ responseStatus: undefined, reviewStatus: "awaiting_review", finalResponse: undefined, responseSentAt: undefined });
  const snapshot = (): SupportTicketRecord[] => [serializeTicket(TID, fake.read(T)!), SET[6], SET[7]];
  const views = () => {
    const tickets = snapshot();
    const index = indexTickets(tickets, NOW_D);
    return {
      status: displayStatus(tickets[0]),
      escalatedFilter: applyFilters(index, { ...DEFAULT_FILTERS, status: "escalated" }).map((r) => r.id),
      resolvedFilter: applyFilters(index, { ...DEFAULT_FILTERS, status: "resolved" }).map((r) => r.id),
      overviewEscalated: buildMetrics(tickets, NOW_D).find((x) => x.id === "escalated")!.value,
      awaiting: buildMetrics(tickets, NOW_D).find((x) => x.id === "awaiting_review")!.value,
      attention: buildEscalationMetrics(3, selectEscalated(tickets)).find((x) => x.id === "escalations_awaiting_attention")!.value,
      inEscalationsList: selectEscalated(tickets).map((t) => t.id),
    };
  };
  assert.deepEqual(views(), { status: "escalated", escalatedFilter: [TID], resolvedFilter: [], overviewEscalated: 1, awaiting: 1, attention: 1, inEscalationsList: [TID] });
  await resolveVia(db, { action: "resolve" }, NOW);
  assert.deepEqual(views(), { status: "resolved", escalatedFilter: [], resolvedFilter: [TID], overviewEscalated: 0, awaiting: 0, attention: 0, inEscalationsList: [TID] });
  await resolveVia(db, { action: "reopen" }, NOW + 1);
  assert.deepEqual(views(), { status: "escalated", escalatedFilter: [TID], resolvedFilter: [], overviewEscalated: 1, awaiting: 1, attention: 1, inEscalationsList: [TID] });
});

test("the ticket page's view model separates escalation history from current resolution", () => {
  const t = serializeTicket("a", { status: "resolved", resolvedAt: Timestamp.fromMillis(NOW), resolvedBy: "admin", reopenedAt: Timestamp.fromMillis(NOW - 1000), reopenedBy: "other", escalationStatus: "required", escalatedAt: Timestamp.fromMillis(NOW - 5000), priority: "High", statusBeforeResolution: "pending_review" });
  const d = buildTicketDetail(t);
  assert.equal(d.status, "resolved");
  assert.equal(d.resolved, true);
  assert.equal(d.resolvedAt, new Date(NOW).toISOString());
  assert.equal(d.resolvedBy, "admin");
  assert.equal(d.reopenedBy, "other");
  assert.equal(d.escalated, true);
  assert.equal(d.escalationActive, false);
  assert.equal(d.escalationStatus, "Required", "the stored escalation record is shown as it is");
  assert.equal("statusBeforeResolution" in t, false);
  const open = buildTicketDetail({ id: "b", status: "pending_review", escalationStatus: "required" });
  assert.deepEqual([open.resolved, open.escalated, open.escalationActive, open.resolvedAt, open.resolvedBy], [false, true, true, null, null]);
});

test("the activity chart still counts a resolved escalation on the day it was received (history is not rewritten)", () => {
  const o = deriveOverview(SET, NOW_D);
  assert.equal(o.activity.reduce((n, p) => n + p.escalated, 0), 4);
});
