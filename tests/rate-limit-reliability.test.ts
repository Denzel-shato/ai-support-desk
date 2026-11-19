/* eslint-disable @typescript-eslint/no-explicit-any -- tests read untyped workflow JSON */
// B4 (global bucket starvation) and B5 (rescue-email flooding).
// The REAL Code-node sources (n8n/code/*.js) are executed in plain Node. A small interpreter plays the part of n8n:
// it runs each node, records its output so `$('Node').last()` works as in n8n, and performs the Firestore calls
// against an in-memory store whose `create` is atomic and fails when the document exists, whose `delete` has no
// ownership check (like the real node), and which can be made to fail. Every store call is a yield point, so tests
// can interleave simultaneous submissions. This proves the LOGIC; it is not Firestore and not the n8n runtime.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../n8n/${p}`, import.meta.url), "utf8");
const wf = JSON.parse(read("ai-support-desk-automation.json"));
const nodes: any[] = wf.nodes;
const byName = (n: string) => nodes.find((x) => x.name === n)!;
type Item = { json: Record<string, any> };

// ------------------------------------------------------------------ fake store

class Store {
  docs = new Map<string, Record<string, any>>();
  log: string[] = [];
  /** return an error for matching operations; set per test */
  fail: ((op: string, id: string) => { httpCode: string; message: string } | null) | null = null;
  create(id: string, doc: Record<string, any>): Item {
    this.log.push(`create ${id}`);
    const f = this.fail?.("create", id);
    if (f) return { json: { error: f } };
    if (this.docs.has(id)) return { json: { error: { message: "Document already exists", httpCode: "409" } } };
    this.docs.set(id, doc);
    return { json: { _id: id } };
  }
  get(id: string): Item {
    this.log.push(`get ${id}`);
    const f = this.fail?.("get", id);
    if (f) return { json: { error: f } };
    return { json: { ...(this.docs.get(id) ?? {}) } }; // a missing document comes back as an empty item
  }
  delete(id: string): Item {
    this.log.push(`delete ${id}`);
    const f = this.fail?.("delete", id);
    if (f) return { json: { error: f } };
    this.docs.delete(id); // Firestore: deleting a missing document is not an error; no ownership check exists
    return { json: { success: true } };
  }
  count(prefix: string) { return [...this.docs.keys()].filter((k) => k.startsWith(prefix)).length; }
}
const down = () => ({ httpCode: "503", message: "Service unavailable" });

// ------------------------------------------------------------------ node interpreter

class Execution {
  out = new Map<string, Item[]>();
  constructor(public id: string, public staticData: Record<string, any> | null, public nowMs: number) {}
  run(name: string, file: string, input: Record<string, any> = {}, patch?: (s: any) => any): Record<string, any> {
    class D extends Date {
      constructor(v?: any) { super(v === undefined ? ex.nowMs : v); }
      static now() { return ex.nowMs; }
    }
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const ex = this;
    const $ = (n: string) => {
      const items = ex.out.get(n);
      const need = () => { if (!items) throw new Error(`no data for node ${n}`); return items; };
      return { isExecuted: Boolean(items), first: () => need()[0], last: () => need()[need().length - 1], all: () => need() };
    };
    let src = read(`code/${file}`);
    if (patch) src = src.replace("settings: SETTINGS", "settings: __patch(SETTINGS)");
    const staticData = this.staticData;
    const $getWorkflowStaticData = () => { if (!staticData) throw new Error("static data unavailable"); return staticData; };
    const r = new Function("$", "$input", "$execution", "$getWorkflowStaticData", "Date", "__patch", src)(
      $, { first: () => ({ json: input }) }, { id: this.id }, $getWorkflowStaticData, D, patch,
    );
    this.out.set(name, [...(this.out.get(name) ?? []), ...r]);
    return r[0].json;
  }
  set(name: string, json: Record<string, any>) { this.out.set(name, [{ json }]); }
}

type Req = { beforeRelease?: (env: Env) => void; email: string; ip?: string | null; name?: string; message?: string; nowMs?: number; patch?: (s: any) => any; staticData?: Record<string, any> | null; execId?: string };
type Env = {
  store: Store;
  /** called for each rescue email the workflow would send; return false to make Gmail fail */
  gmail: (email: { kind: string; subject: string; html: string; execId: string }) => boolean;
};
type Result = { route: string; limitedBy?: string; degraded?: boolean; text: string; emails: string[]; held: string[]; failedExecution?: string; released: number; skipped: number; releaseFailed: number; rescue?: string };
const T0 = Date.parse("2026-11-18T10:15:00Z");
let execCounter = 1000;
const ip = (n: number) => `203.0.113.${n}, 198.51.100.${n}`;

function* submission(env: Env, r: Req): Generator<void, Result, void> {
  const { store } = env;
  const ex = new Execution(r.execId ?? String(++execCounter), r.staticData === undefined ? {} : r.staticData, r.nowMs ?? T0);
  const headers: Record<string, string> = {};
  if (r.ip !== null) headers["x-forwarded-for"] = r.ip ?? ip(1);
  ex.set("Form Trigger", { headers });
  ex.set("Validate submission", { "Your Name": r.name ?? "Ada", "Your Email": r.email, "What is it you would like us to fix ?": r.message ?? "Please help" });
  ex.run("Rate limit settings", "rate-limit-settings.js", {}, r.patch);
  const res: Result = { route: "", text: "", emails: [], held: [], released: 0, skipped: 0, releaseFailed: 0 };

  // ---- claim loop (Prepare rate limit -> Plan claim -> Claim slot -> Evaluate claim -> Claim next slot?)
  let state = ex.run("Prepare rate limit", "prepare-rate-limit.js");
  let ev: Record<string, any>;
  for (let guard = 0; ; guard++) {
    assert.ok(guard < 400, "claim loop did not terminate");
    const planned = ex.run("Plan claim", "plan-claim.js", state);
    yield;
    const result = store.create(planned.docId, { kind: planned.kind, slot: planned.slot, createdAt: planned.createdAt, expireAt: planned.expireAt, claimId: planned.claimId });
    ev = ex.run("Evaluate claim", "evaluate-claim.js", result.json);
    if (ev.route !== "next") break;
    state = { rl: ev.rl };
  }
  res.route = ev.route; res.limitedBy = ev.limitedBy; res.degraded = ev.degraded; res.text = ev.formSubmittedText ?? "";
  if (ev.route === "allowed") return res; // -> Respond (accepted) -> Gemini ... (not modelled)

  // ---- Respond to form (rejected/unavailable) happened; now give back what this submission holds
  r.beforeRelease?.(env);
  let relInput: Record<string, any> = {};
  for (let guard = 0; ; guard++) {
    assert.ok(guard < 100, "release loop did not terminate");
    const pr = ex.run("Plan release", "plan-release.js", relInput);
    if (pr.route !== "release") { res.released = pr.rel.released; res.skipped = pr.rel.skipped; res.releaseFailed = pr.rel.failed; break; }
    yield;
    const got = store.get(pr.docId);
    const own = ex.run("Check owner", "check-owner.js", got.json);
    if (!own.owned) { relInput = own; continue; }
    yield;
    relInput = store.delete(pr.docId).json;
  }
  if (ev.route !== "unavailable") return res;

  // ---- rescue throttle (only for limiter-unavailable refusals)
  let rsInput: Record<string, any> = {};
  let ev2: Record<string, any>;
  for (let guard = 0; ; guard++) {
    assert.ok(guard < 100, "rescue loop did not terminate");
    const planned = ex.run("Plan rescue slot", "plan-rescue-slot.js", rsInput);
    yield;
    const result = store.create(planned.docId, { kind: planned.kind, slot: planned.slot, createdAt: planned.createdAt, expireAt: planned.expireAt });
    ev2 = ex.run("Evaluate rescue slot", "evaluate-rescue-slot.js", result.json);
    if (ev2.route !== "next") break;
    rsInput = { rs: ev2.rs };
  }
  res.rescue = ev2.rescue;
  if (ev2.rescue === "suppress") {
    const h = ex.run("Build held record", "build-held-record.js", ev2);
    yield;
    store.create(h.docId, { kind: h.kind, reason: h.reason, executionId: h.executionId, createdAt: h.createdAt, expireAt: h.expireAt });
    res.held.push(h.docId);
    return res;
  }
  const mail = ex.run("Prepare rescue email", "prepare-rescue-email.js", ev2);
  yield;
  if (env.gmail({ kind: mail.kind, subject: mail.subject, html: mail.html, execId: ex.id })) { res.emails.push(mail.kind); return res; }
  const failed = ex.run("Rescue email failed", "rescue-email-failed.js", { error: { message: "Gmail quota exceeded" } });
  yield;
  store.create(failed.docId, { kind: failed.kind, reason: failed.reason, executionId: failed.executionId, createdAt: failed.createdAt, expireAt: failed.expireAt });
  res.held.push(failed.docId);
  res.failedExecution = failed.failureMessage;
  return res;
}
function mk(): { env: Env; sent: any[] } {
  const sent: any[] = [];
  return { env: { store: new Store(), gmail: (m) => { sent.push(m); return true; } }, sent };
}
const run = (env: Env, r: Req) => { const g = submission(env, r); for (;;) { const s = g.next(); if (s.done) return s.value; } };
function interleave(env: Env, reqs: Req[], seed: number): Result[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const runs = reqs.map((r) => ({ g: submission(env, r), v: undefined as Result | undefined }));
  while (runs.some((x) => !x.v)) {
    const live = runs.filter((x) => !x.v);
    const p = live[Math.floor(rnd() * live.length)];
    const st = p.g.next();
    if (st.done) p.v = st.value;
  }
  return runs.map((x) => x.v!);
}
const globalSlots = (st: Store) => st.count("rl_global_");

// ================================================================== B4

test("B4: a request refused by the IP limit does not consume global capacity", () => {
  const { env } = mk();
  for (let i = 0; i < 10; i++) assert.equal(run(env, { email: `u${i}@example.com`, ip: ip(20) }).route, "allowed");
  assert.equal(globalSlots(env.store), 10);
  for (let i = 10; i < 16; i++) {
    const r = run(env, { email: `u${i}@example.com`, ip: ip(20) });
    assert.deepEqual([r.route, r.limitedBy], ["limited", "ip"]);
  }
  assert.equal(globalSlots(env.store), 10, "six refusals took no global slot");
  assert.equal(env.store.count("rl_email_"), 10, "and kept no email slot either");
  assert.equal(env.store.count("rl_ip_"), 10);
});

test("B4: a request refused by the email limit does not consume global (or IP) capacity", () => {
  const { env } = mk();
  for (let i = 0; i < 3; i++) assert.equal(run(env, { email: "ada@example.com", ip: ip(30 + i) }).route, "allowed");
  assert.equal(globalSlots(env.store), 3);
  const before = env.store.count("rl_ip_");
  for (let i = 0; i < 5; i++) {
    const r = run(env, { email: "ada@example.com", ip: ip(40 + i) });
    assert.deepEqual([r.route, r.limitedBy], ["limited", "email"]);
    assert.equal(r.released, 1, "the IP slot it had already taken was given back");
  }
  assert.equal(globalSlots(env.store), 3);
  assert.equal(env.store.count("rl_ip_"), before, "refused requests leave no IP slot behind");
});

test("B4: a request refused by the GLOBAL limit gives back its IP and email slots", () => {
  const { env } = mk();
  const small = (c: any) => ({ ...c, checks: { ...c.checks, global: { enabled: true, limit: 2, windowSeconds: 60 } } });
  assert.equal(run(env, { email: "a@example.com", ip: ip(50), patch: small }).route, "allowed");
  assert.equal(run(env, { email: "b@example.com", ip: ip(51), patch: small }).route, "allowed");
  const r = run(env, { email: "c@example.com", ip: ip(52), patch: small });
  assert.deepEqual([r.route, r.limitedBy, r.released], ["limited", "global", 2]);
  assert.equal(env.store.count("rl_ip_"), 2);
  assert.equal(env.store.count("rl_email_"), 2);
  assert.equal(globalSlots(env.store), 2, "global slots are never released by a refused request");
  // the refused visitor still has their own capacity: once global frees up (next minute) they are accepted
  assert.equal(run(env, { email: "c@example.com", ip: ip(52), patch: small, nowMs: T0 + 61_000 }).route, "allowed");
});

test("B4: claim order is narrow first (IP or unknown bucket, then email) and global LAST; limits are unchanged", () => {
  const ex = new Execution("1", {}, T0);
  ex.set("Form Trigger", { headers: { "x-forwarded-for": ip(1) } });
  ex.set("Validate submission", { "Your Email": "a@example.com" });
  ex.run("Rate limit settings", "rate-limit-settings.js");
  const s = ex.run("Prepare rate limit", "prepare-rate-limit.js");
  assert.deepEqual(s.rl.checks.map((c: any) => [c.kind, c.limit, c.windowSeconds]), [["ip", 10, 3600], ["email", 3, 3600], ["global", 20, 60]]);
  const ex2 = new Execution("2", {}, T0);
  ex2.set("Form Trigger", { headers: {} });
  ex2.set("Validate submission", { "Your Email": "a@example.com" });
  ex2.run("Rate limit settings", "rate-limit-settings.js");
  assert.deepEqual(ex2.run("Prepare rate limit", "prepare-rate-limit.js").rl.checks.map((c: any) => [c.kind, c.limit, c.windowSeconds]), [["unknown", 20, 3600], ["email", 3, 3600], ["global", 20, 60]]);
  const settings = ex.out.get("Rate limit settings")![0].json.settings;
  assert.equal(settings.retentionGraceSeconds, 3600);
  assert.equal(settings.failMode, "closed");
});

test("B4: concurrent requests at the global limit: exactly 20 get in, nothing leaks, whatever the interleaving", () => {
  for (let trial = 0; trial < 60; trial++) {
    const { env } = mk();
    const reqs = Array.from({ length: 28 }, (_, i) => ({ email: `u${i}@example.com`, ip: ip(100 + i) }));
    const results = interleave(env, reqs, 1000 + trial);
    const allowed = results.filter((r) => r.route === "allowed").length;
    assert.equal(allowed, 20, `trial ${trial}`);
    assert.equal(globalSlots(env.store), 20, "never more than the limit");
    assert.equal(env.store.count("rl_ip_"), 20, "only allowed requests keep an IP slot");
    assert.equal(env.store.count("rl_email_"), 20, "only allowed requests keep an email slot");
    assert.ok(results.filter((r) => r.route !== "allowed").every((r) => r.limitedBy === "global" && r.released === 2));
  }
});

test("B4: concurrent requests from one email/IP cannot exceed the narrow limits and do not starve global capacity", () => {
  for (let trial = 0; trial < 60; trial++) {
    const { env } = mk();
    const same = Array.from({ length: 8 }, () => ({ email: "ada@example.com", ip: ip(7) }));
    const others = Array.from({ length: 12 }, (_, i) => ({ email: `o${i}@example.com`, ip: ip(120 + i) }));
    const results = interleave(env, [...same, ...others], 5000 + trial);
    assert.equal(results.slice(0, 8).filter((r) => r.route === "allowed").length, 3, "email limit 3");
    assert.equal(results.slice(8).filter((r) => r.route === "allowed").length, 12, "other customers are not starved by the refused ones");
    assert.equal(globalSlots(env.store), 15, "global holds exactly the accepted requests (3 + 12)");
  }
});

test("B4: a failure BETWEEN bucket claims (store breaks on the global claim) fails closed and gives back what was taken", () => {
  const { env } = mk();
  env.store.fail = (op, id) => (op === "create" && id.startsWith("rl_global_") ? down() : null);
  const r = run(env, { email: "a@example.com", ip: ip(60) });
  assert.equal(r.route, "unavailable", "fail closed");
  assert.match(r.text, /try again/i);
  assert.equal(r.released, 2, "the IP and email slots it had already claimed were released");
  assert.equal(env.store.docs.size > 0, true, "only rescue-throttle documents remain");
  assert.equal(env.store.count("rl_"), 0);
});

test("B4: a failure on the email claim after the IP claim also gives the IP slot back", () => {
  const { env } = mk();
  env.store.fail = (op, id) => (op === "create" && id.startsWith("rl_email_") ? down() : null);
  const r = run(env, { email: "a@example.com", ip: ip(61) });
  assert.equal(r.route, "unavailable");
  assert.equal(env.store.count("rl_ip_"), 0);
});

test("B4: if giving slots back fails, the request is still refused and the leak is on the SAFE side (slots stay taken, nothing opens up)", () => {
  const { env } = mk();
  env.store.fail = (op, id) => (op === "create" && id.startsWith("rl_global_") ? down() : op === "delete" ? down() : null);
  const r = run(env, { email: "a@example.com", ip: ip(62) });
  assert.equal(r.route, "unavailable");
  assert.equal(r.releaseFailed, 2);
  assert.equal(env.store.count("rl_ip_") + env.store.count("rl_email_"), 2, "slots remain taken until the window ends");
  // and they cannot be bypassed: the same source/email now has fewer slots, never more
  env.store.fail = null;
  for (let i = 0; i < 2; i++) assert.equal(run(env, { email: "a@example.com", ip: ip(62) }).route, "allowed");
  assert.equal(run(env, { email: "a@example.com", ip: ip(62) }).route, "limited");
});

test("B4: release only ever deletes a slot that still carries THIS submission's claim id", () => {
  const { env } = mk();
  const small = (c: any) => ({ ...c, checks: { ...c.checks, global: { enabled: true, limit: 1, windowSeconds: 60 } } });
  run(env, { email: "first@example.com", ip: ip(70), patch: small });
  const firstClaims = new Set([...env.store.docs.values()].map((d) => d.claimId));
  // The victim is refused by global. Before its release runs, its IP slot is replaced by ANOTHER request's claim
  // (as if it had been deleted and re-created in between).
  const res = run(env, {
    email: "victim@example.com", ip: ip(71), patch: small,
    beforeRelease: (e) => {
      const id = [...e.store.docs.keys()].find((k) => k.startsWith("rl_ip_") && !firstClaims.has(e.store.docs.get(k)!.claimId))!;
      e.store.docs.set(id, { ...e.store.docs.get(id)!, claimId: "someone-elses-claim-id-0000000000" });
    },
  });
  assert.deepEqual([res.route, res.limitedBy], ["limited", "global"]);
  assert.equal(res.skipped, 1, "the replaced slot was recognised as not ours and left alone");
  assert.equal(res.released, 1, "its other slot (still its own) was given back");
  assert.equal([...env.store.docs.values()].some((d) => d.claimId === "someone-elses-claim-id-0000000000"), true, "the other request's claim survived");
  assert.equal(env.store.log.filter((l) => l.startsWith("delete ")).length, 1, "exactly one delete was ever issued");
});

test("B4: release treats a missing document, a read error and a foreign claim as 'not ours' (no delete is issued)", () => {
  for (const got of [{}, { error: { message: "boom" } }, { claimId: "other" }, { claimId: "" }]) {
    const ex = new Execution("9", {}, T0);
    ex.set("Plan release", { docId: "rl_ip_x_1_1", claimId: "mine-0000" });
    assert.equal(ex.run("Check owner", "check-owner.js", got).owned, false, JSON.stringify(got));
  }
  const ex = new Execution("9", {}, T0);
  ex.set("Plan release", { docId: "rl_ip_x_1_1", claimId: "mine-0000" });
  assert.equal(ex.run("Check owner", "check-owner.js", { claimId: "mine-0000", kind: "ip" }).owned, true);
});

test("B4: claim ids are unique per submission and stored in every slot it creates", () => {
  const { env } = mk();
  run(env, { email: "a@example.com", ip: ip(80) });
  run(env, { email: "b@example.com", ip: ip(81) });
  const ids = [...env.store.docs.values()].map((d) => d.claimId);
  assert.ok(ids.every((c) => typeof c === "string" && c.length === 32));
  assert.equal(new Set(ids).size, 2, "one claim id per submission, shared by its three slots");
});

test("B4: with the limiter store fully down, fail-closed refuses (and nothing opens up); fail-open degrades explicitly", () => {
  const { env } = mk();
  env.store.fail = () => down();
  const closed = run(env, { email: "a@example.com", ip: ip(90) });
  assert.deepEqual([closed.route, closed.released], ["unavailable", 0]);
  const open = run(env, { email: "a@example.com", ip: ip(90), patch: (c) => ({ ...c, failMode: "open" }) });
  assert.deepEqual([open.route, open.degraded], ["allowed", true]);
});

test("B4: a transient single failure is retried and the submission is accepted normally", () => {
  const { env } = mk();
  let n = 0;
  env.store.fail = (op, id) => (op === "create" && id.startsWith("rl_email_") && n++ === 0 ? down() : null);
  assert.equal(run(env, { email: "a@example.com", ip: ip(91) }).route, "allowed");
});

// ================================================================== B5

const outage = (env: Env) => { env.store.fail = (op, id) => (id.startsWith("rl_") ? down() : null); }; // limiter slots fail, throttle store works

test("B5: repeated limiter failures send at most maxEmails detailed emails, ONE notice, then nothing (and hold records)", () => {
  const { env, sent } = mk();
  outage(env);
  const results = Array.from({ length: 12 }, (_, i) => run(env, { email: `u${i}@example.com`, ip: ip(1 + i), name: `Customer ${i}`, message: `Problem number ${i}` }));
  assert.deepEqual(results.map((r) => r.route), Array(12).fill("unavailable"), "every visitor still gets the same refusal");
  assert.deepEqual(sent.map((m) => m.kind), ["rate_limit_unavailable", "rate_limit_unavailable", "rate_limit_unavailable", "rate_limit_suppressed"]);
  assert.equal(results.filter((r) => r.rescue === "suppress").length, 8);
  assert.equal(env.store.count("held_"), 8, "each suppressed submission leaves an identifying record");
});

test("B5: detailed emails carry the submission; the notice and the held records carry NO customer data", () => {
  const { env, sent } = mk();
  outage(env);
  for (let i = 0; i < 6; i++) run(env, { email: `secret${i}@example.com`, ip: ip(1 + i), name: `Name${i}`, message: `Private text ${i}` });
  assert.match(sent[0].html, /secret0@example\.com/);
  assert.match(sent[0].html, /Private text 0/);
  assert.match(sent[0].html, /n8n execution/);
  const notice = sent.find((m) => m.kind === "rate_limit_suppressed");
  assert.doesNotMatch(notice.html + notice.subject, /secret|Private text|Name\d/);
  assert.match(notice.html, /rate_limits|execution/i, "tells staff where the held submissions are");
  for (const [id, doc] of env.store.docs) if (id.startsWith("held_")) {
    assert.deepEqual(Object.keys(doc).sort(), ["createdAt", "executionId", "expireAt", "kind", "reason"]);
    assert.doesNotMatch(JSON.stringify(doc), /secret|Private|@/);
    assert.match(id, /^held_\d+_\d+$/, "keyed by the n8n execution id");
  }
});

test("B5: concurrent rescue attempts cannot exceed maxEmails + 1 (any interleaving)", () => {
  for (let trial = 0; trial < 80; trial++) {
    const { env, sent } = mk();
    outage(env);
    const results = interleave(env, Array.from({ length: 14 }, (_, i) => ({ email: `u${i}@example.com`, ip: ip(1 + i) })), 9000 + trial);
    assert.equal(sent.filter((m) => m.kind === "rate_limit_unavailable").length, 3, `trial ${trial}`);
    assert.equal(sent.filter((m) => m.kind === "rate_limit_suppressed").length, 1);
    assert.equal(results.filter((r) => r.rescue === "suppress").length, 10);
    assert.equal(env.store.count("rs_limiter_"), 4, "exactly three send slots and the notice slot exist");
  }
});

test("B5: a new window starts a fresh allowance (an ongoing outage is announced again, not forgotten)", () => {
  const { env, sent } = mk();
  outage(env);
  for (let i = 0; i < 6; i++) run(env, { email: `u${i}@example.com`, ip: ip(1 + i), nowMs: T0 });
  assert.equal(sent.length, 4);
  run(env, { email: "late@example.com", ip: ip(30), nowMs: T0 + 3_600_000 });
  assert.equal(sent.length, 5);
  assert.equal(sent.at(-1).kind, "rate_limit_unavailable");
});

test("B5: when Firestore is down for the throttle too, a per-instance fallback counter applies the same cap", () => {
  const { env, sent } = mk();
  env.store.fail = () => down(); // everything fails, including the rescue throttle
  const sd: Record<string, any> = {};
  const results = Array.from({ length: 9 }, (_, i) => run(env, { email: `u${i}@example.com`, ip: ip(1 + i), staticData: sd }));
  assert.deepEqual(sent.map((m) => m.kind), ["rate_limit_unavailable", "rate_limit_unavailable", "rate_limit_unavailable", "rate_limit_suppressed"]);
  assert.equal(results.filter((r) => r.rescue === "suppress").length, 5);
  assert.equal(env.store.docs.size, 0, "nothing could be stored, and nothing crashed");
});

test("B5: if neither the throttle store nor static data works, the email is SENT (never lose the outage notification)", () => {
  const { env, sent } = mk();
  env.store.fail = () => down();
  for (let i = 0; i < 5; i++) run(env, { email: `u${i}@example.com`, ip: ip(1 + i), staticData: null });
  assert.equal(sent.length, 5, "documented residual risk: unbounded only when both Firestore and n8n static data fail");
});

test("B5: a failed rescue email is handled explicitly: held record (no customer data) and a failure message that marks the execution", () => {
  const { env } = mk();
  outage(env);
  env.gmail = () => false;
  const r = run(env, { email: "ada@example.com", ip: ip(5), name: "Ada", message: "Private text", execId: "4242" });
  assert.equal(r.route, "unavailable", "the visitor's answer is unchanged");
  assert.deepEqual(r.held, ["held_4242_email_failed"]);
  const doc = env.store.docs.get("held_4242_email_failed")!;
  assert.deepEqual([doc.reason, doc.kind, doc.executionId], ["email_failed", "rate_limit_unavailable", "4242"]);
  assert.doesNotMatch(JSON.stringify(doc), /ada|Private/i);
  assert.match(r.failedExecution!, /could not be sent/);
  assert.match(r.failedExecution!, /execution 4242/);
  assert.match(r.failedExecution!, /Gmail quota exceeded/);
});

test("B5: a failed rescue email does not stop the next one in the window from being tried", () => {
  const { env } = mk();
  outage(env);
  let calls = 0;
  const delivered: string[] = [];
  env.gmail = (m) => { calls++; if (calls === 1) return false; delivered.push(m.kind); return true; };
  for (let i = 0; i < 3; i++) run(env, { email: `u${i}@example.com`, ip: ip(1 + i) });
  assert.equal(calls, 3);
  assert.equal(delivered.length, 2);
});

test("B5: customer submission data is preserved wherever it is available: the email, the execution record, and the same refusal text", () => {
  const { env, sent } = mk();
  outage(env);
  const r = run(env, { email: "ada@example.com", ip: ip(5), name: "Ada <b>", message: "Line 1\nLine <script>2" });
  const html = sent[0].html;
  assert.match(html, /Ada &lt;b&gt;/);
  assert.match(html, /Line &lt;script&gt;2/);
  assert.doesNotMatch(html, /<script>/);
  const settings = new Execution("x", {}, T0).run("s", "rate-limit-settings.js").settings;
  assert.equal(r.text, settings.messages.unavailable, "customer-facing failure behaviour is unchanged");
});

test("B5: rescue emails for ACCEPTED submissions (ticket not saved, acknowledgement/escalation failed) are never throttled", () => {
  const conn = wf.connections as Record<string, { main: { node: string }[][] }>;
  const targets = (n: string) => (conn[n]?.main ?? []).flatMap((b) => b.map((c) => c.node));
  const pathsTo = (to: string, from: string, seen: string[] = []): string[][] => {
    if (from === to) return [[...seen, from]];
    if (seen.includes(from)) return [];
    return targets(from).flatMap((t) => pathsTo(to, t, [...seen, from]));
  };
  for (const start of ["Is write conflict", "Is duplicate submission", "Send a message", "Send a message1"]) {
    const paths = pathsTo("Prepare rescue email", start);
    assert.ok(paths.length > 0, start);
    for (const p of paths) assert.equal(p.some((n) => /rescue slot|Evaluate rescue/.test(n)), false, `${start} passes the throttle: ${p.join(" > ")}`);
  }
  // and the only way INTO the throttle is a refused (limiter-unavailable) submission
  assert.deepEqual(targets("Needs rescue?"), ["Plan rescue slot"]);
  const into = Object.entries(conn).filter(([, c]) => c.main.some((b) => b.some((x) => x.node === "Plan rescue slot"))).map(([n]) => n).sort();
  assert.deepEqual(into, ["Needs rescue?", "Rescue next slot?"]);
});

test("B5: rescue throttle numbers are configurable in the one settings node and clamped", () => {
  const { env, sent } = mk();
  outage(env);
  const patch = (c: any) => ({ ...c, rescue: { maxEmails: 1, windowSeconds: 600, heldRetentionSeconds: 86400 } });
  for (let i = 0; i < 4; i++) run(env, { email: `u${i}@example.com`, ip: ip(1 + i), patch });
  assert.deepEqual(sent.map((m) => m.kind), ["rate_limit_unavailable", "rate_limit_suppressed"]);
  const { env: e2, sent: s2 } = mk();
  outage(e2);
  const wild = (c: any) => ({ ...c, rescue: { maxEmails: 9999, windowSeconds: -1, heldRetentionSeconds: "x" } });
  for (let i = 0; i < 20; i++) run(e2, { email: `u${i}@example.com`, ip: ip(1 + i), patch: wild });
  assert.equal(s2.filter((m) => m.kind === "rate_limit_unavailable").length, 10, "capped at 10 detailed emails");
  assert.equal(s2.length, 11);
});

// ================================================================== graph / wiring

const conn = wf.connections as Record<string, { main: { node: string }[][] }>;
const targets = (n: string, port?: number) => (conn[n]?.main ?? []).flatMap((b, i) => (port === undefined || port === i ? b.map((c) => c.node) : []));

test("wiring: refusals answer the visitor FIRST, then release, then (limiter outage only) the throttled rescue", () => {
  assert.deepEqual(targets("Respond to form (rejected)"), ["Plan release"]);
  assert.deepEqual(targets("Respond to form (unavailable)"), ["Plan release"]);
  assert.deepEqual(targets("Respond to form (accepted)"), ["Message a model"]);
  assert.deepEqual(targets("Release pending?", 0), ["Read claim"]);
  assert.deepEqual(targets("Release pending?", 1), ["Needs rescue?"]);
  assert.deepEqual(targets("Read claim"), ["Check owner"]);
  assert.deepEqual(targets("Check owner"), ["Owned?"]);
  assert.deepEqual(targets("Owned?", 0), ["Release slot"]);
  assert.deepEqual(targets("Owned?", 1), ["Plan release"], "a slot that is not ours is skipped, never deleted");
  assert.deepEqual(targets("Release slot"), ["Plan release"]);
  assert.deepEqual(targets("Claim rescue slot", 0), ["Evaluate rescue slot"]);
  assert.deepEqual(targets("Claim rescue slot", 1), ["Evaluate rescue slot"]);
  assert.deepEqual(targets("Rescue suppressed?", 0), ["Build held record"]);
  assert.deepEqual(targets("Rescue suppressed?", 1), ["Prepare rescue email"]);
  assert.deepEqual(targets("Send rescue email", 1), ["Rescue email failed"]);
  assert.deepEqual(targets("Rescue email failed"), ["Record failed notification"]);
  assert.deepEqual(targets("Record failed notification"), ["Rescue email not sent"]);
  assert.equal(byName("Rescue email not sent").type, "n8n-nodes-base.stopAndError");
});

test("wiring: release/throttle Firestore nodes cannot take the workflow down, never retry, and only touch rate_limits", () => {
  assert.equal(byName("Read claim").parameters.operation, "get");
  assert.equal(byName("Read claim").alwaysOutputData, true);
  assert.equal(byName("Release slot").parameters.operation, "delete");
  assert.equal(byName("Release slot").parameters.documentId, "={{ $('Plan release').last().json.docId }}");
  for (const n of ["Read claim", "Release slot", "Record held submission", "Record failed notification"]) {
    assert.equal(byName(n).onError, "continueRegularOutput", n);
    assert.equal(byName(n).retryOnFail, undefined, n);
    assert.equal(byName(n).parameters.collection, "rate_limits", n);
  }
  assert.equal(byName("Claim rescue slot").onError, "continueErrorOutput");
  assert.equal(byName("Claim rescue slot").retryOnFail, undefined);
  assert.equal(byName("Claim rescue slot").parameters.operation, "create");
  assert.equal(byName("Claim slot").parameters.columns, "kind,slot,createdAt,expireAt,claimId");
  assert.equal(byName("Send rescue email").onError, "continueErrorOutput");
  assert.equal(byName("Send rescue email").retryOnFail, true);
  // no node other than the release node deletes anything
  assert.deepEqual(nodes.filter((n) => n.parameters?.operation === "delete").map((n) => n.name), ["Release slot"]);
});

test("embedded Code nodes equal the n8n/code sources (no drift)", () => {
  const pairs: [string, string][] = [
    ["Rate limit settings", "rate-limit-settings.js"], ["Prepare rate limit", "prepare-rate-limit.js"], ["Plan claim", "plan-claim.js"], ["Evaluate claim", "evaluate-claim.js"],
    ["Plan release", "plan-release.js"], ["Check owner", "check-owner.js"], ["Plan rescue slot", "plan-rescue-slot.js"], ["Evaluate rescue slot", "evaluate-rescue-slot.js"],
    ["Build held record", "build-held-record.js"], ["Rescue email failed", "rescue-email-failed.js"], ["Prepare rescue email", "prepare-rescue-email.js"],
  ];
  for (const [n, f] of pairs) assert.equal(byName(n).parameters.jsCode, read(`code/${f}`), n);
});

test("the numeric limits and customer-facing messages are unchanged from before this work", () => {
  const s = new Execution("1", {}, T0).run("s", "rate-limit-settings.js").settings;
  assert.deepEqual(
    [s.checks.global, s.checks.ip, s.checks.unknownIp, s.checks.email].map((c: any) => [c.limit, c.windowSeconds]),
    [[20, 60], [10, 3600], [20, 3600], [3, 3600]],
  );
  assert.equal(s.messages.unavailable, "We couldn't process your request right now. Please try again in a little while.");
  assert.equal(s.messages.limited, "You've sent several requests recently, so we can't accept another one right now. Please try again later.");
});
