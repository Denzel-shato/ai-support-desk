/* eslint-disable @typescript-eslint/no-explicit-any -- tests read untyped workflow JSON */
// Tests for the PROPOSED rate limiter in n8n/ai-support-desk-automation.json.
// The Code-node sources run in plain Node with a stand-in for n8n's `$` helpers, and a fake Firestore whose
// "create" is atomic and fails when the document exists (how Firestore createDocument behaves). This proves the
// LOGIC. It does not prove real Firestore behaviour or the n8n runtime; see docs/n8n-intake-workflow.md for
// what was and wasn't run in a real (stubbed) n8n.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TEST_SALT, TEST_SALT_B, validDeployment } from "./deployment-fixtures";

const read = (p: string) => readFileSync(new URL(`../n8n/${p}`, import.meta.url), "utf8");
const wf = JSON.parse(read("ai-support-desk-automation.json"));
type Node = { name: string; type: string; typeVersion: number; parameters: Record<string, any>; onError?: string; retryOnFail?: boolean };
const nodes: Node[] = wf.nodes;
const byName = (n: string) => nodes.find((x) => x.name === n)!;
type Item = { json: Record<string, any> };

function runNode(file: string, ctx: { input?: Record<string, any>; nodes?: Record<string, Item[]>; nowMs?: number; patch?: (s: any) => any }): Record<string, any> {
  const nowMs = ctx.nowMs ?? Date.parse("2026-11-18T10:15:00Z");
  class FakeDate extends Date {
    constructor(value?: any) {
      super(value === undefined ? nowMs : value);
    }
    static now() {
      return nowMs;
    }
  }
  const $ = (name: string) => {
    const items = ctx.nodes?.[name];
    const need = () => {
      if (!items) throw new Error(`no data for node ${name}`);
      return items;
    };
    return { first: () => need()[0], last: () => need()[need().length - 1], all: () => need() };
  };
  let src = read(`code/${file}`);
  if (ctx.patch) src = src.replace("settings: SETTINGS", "settings: __patch(SETTINGS)");
  return new Function("$", "$input", "Date", "__patch", src)($, { first: () => ({ json: ctx.input ?? {} }) }, FakeDate, ctx.patch)[0].json;
}

// ---- a miniature of the claim loop built from the real Code-node sources ---------------------------------------

class Store {
  docs = new Map<string, Record<string, any>>();
  failWith: { httpCode: string; message: string } | null = null;
  failTimes = Infinity;
  attempts = 0;
  create(id: string, doc: Record<string, any>): Item {
    this.attempts++;
    if (this.failWith && this.failTimes > 0) {
      this.failTimes--;
      return { json: { error: { message: this.failWith.message, httpCode: this.failWith.httpCode } } };
    }
    if (this.docs.has(id)) return { json: { error: { message: "Document already exists", httpCode: "409" } } };
    this.docs.set(id, doc);
    return { json: { _id: id } };
  }
}
type Req = { email: string; ip?: string | null; header?: string; nowMs?: number; patch?: (s: any) => any; salt?: string };
type Result = { route: string; degraded?: boolean; limitedBy?: string; text: string; docIds: string[] };

// A generator so tests can interleave several submissions at the point where they touch the store.
function* submission(store: Store, r: Req): Generator<void, Result, void> {
  const headers: Record<string, string> = {};
  if (r.ip !== null && r.ip !== undefined) headers[r.header ?? "x-forwarded-for"] = r.ip;
  const settingsItem = runNode("rate-limit-settings.js", { input: {}, patch: r.patch });
  const base = { "Deployment config": [validDeployment({ rateLimitSalt: r.salt ?? TEST_SALT })], "Rate limit settings": [{ json: settingsItem }], "Form Trigger": [{ json: { headers } }], "Validate submission": [{ json: { "Your Email": r.email } }] };
  let state: Record<string, any> = runNode("prepare-rate-limit.js", { nodes: base, nowMs: r.nowMs });
  const docIds: string[] = [];
  for (let guard = 0; guard < 500; guard++) {
    const planned = runNode("plan-claim.js", { input: state });
    yield; // another submission may run here, right before this one touches the store
    const result = store.create(planned.docId, { kind: planned.kind, slot: planned.slot, createdAt: planned.createdAt, expireAt: planned.expireAt });
    if (result.json.error === undefined) docIds.push(planned.docId);
    const ev = runNode("evaluate-claim.js", { input: result.json, nodes: { "Plan claim": [{ json: planned }] } });
    if (ev.route === "next") {
      state = { rl: ev.rl };
      continue;
    }
    return { route: ev.route, degraded: ev.degraded, limitedBy: ev.limitedBy, text: ev.formSubmittedText, docIds };
  }
  throw new Error("claim loop did not terminate");
}
const run = (store: Store, r: Req): Result => {
  const g = submission(store, r);
  for (;;) {
    const s = g.next();
    if (s.done) return s.value;
  }
};
const ip = (n: number) => `203.0.113.${n}, 198.51.100.${n}`; // last entry = what OUR proxy saw; first = client-supplied
const T0 = Date.parse("2026-11-18T10:15:00Z");

// ---- required scenarios ----------------------------------------------------------------------------------------

test("1. a normal submission within the limit is allowed and shows the normal confirmation", () => {
  const s = new Store();
  const r = run(s, { email: "ada@example.com", ip: ip(10) });
  assert.equal(r.route, "allowed");
  assert.match(r.text, /submitted/i);
  assert.equal(s.docs.size, 3, "one slot per check: global, ip, email");
});

test("2. a submission over the email limit is refused with the polite message, after exactly `limit` successes", () => {
  const s = new Store();
  const results = [1, 2, 3, 4, 5].map(() => run(s, { email: "ada@example.com", ip: ip(10) }));
  assert.deepEqual(results.map((r) => r.route), ["allowed", "allowed", "allowed", "limited", "limited"]);
  assert.equal(results[3].limitedBy, "email");
  assert.match(results[3].text, /several requests.*try again later/i);
  assert.doesNotMatch(results[3].text, /limit|slot|rate|3|hour|firestore/i, "no implementation details are exposed");
});

test("3. a new submission after the window expires is allowed again", () => {
  const s = new Store();
  for (let i = 0; i < 3; i++) run(s, { email: "ada@example.com", ip: ip(10), nowMs: T0 });
  assert.equal(run(s, { email: "ada@example.com", ip: ip(10), nowMs: T0 + 30 * 60_000 }).route, "limited", "still inside the one-hour window");
  const windowStart = Math.floor(T0 / 3_600_000) * 3_600_000;
  assert.equal(run(s, { email: "ada@example.com", ip: ip(10), nowMs: windowStart + 3_600_000 }).route, "allowed", "next window");
});

test("4. rapid submissions from one source: exactly `limit` get in (IP limit, distinct emails)", () => {
  const s = new Store();
  const routes = Array.from({ length: 14 }, (_, i) => run(s, { email: `user${i}@example.com`, ip: ip(20) }));
  assert.equal(routes.filter((r) => r.route === "allowed").length, 10);
  assert.equal(routes.filter((r) => r.route === "limited" && r.limitedBy === "ip").length, 4);
});

test("5. concurrent submissions cannot bypass the limit (many random interleavings)", () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let trial = 0; trial < 300; trial++) {
    const s = new Store();
    const runs = Array.from({ length: 8 }, () => ({ g: submission(s, { email: "ada@example.com", ip: ip(30) }), done: false, value: undefined as Result | undefined }));
    while (runs.some((x) => !x.done)) {
      const live = runs.filter((x) => !x.done);
      const pick = live[Math.floor(rnd() * live.length)];
      const step = pick.g.next();
      if (step.done) { pick.done = true; pick.value = step.value; }
    }
    const allowed = runs.filter((x) => x.value!.route === "allowed").length;
    assert.equal(allowed, 3, `trial ${trial}: the email limit is 3`);
    // No slot document was ever claimed twice, and none beyond the limit exists.
    const emailDocs = [...s.docs.keys()].filter((k) => k.startsWith("rl_email_"));
    assert.equal(emailDocs.length, 3);
  }
});

test("5b. a failed create (slot held by another run) never counts as a granted slot", () => {
  const s = new Store();
  const a = submission(s, { email: "x@example.com", ip: ip(31) });
  const b = submission(s, { email: "x@example.com", ip: ip(31) });
  a.next(); b.next(); // both planned slot 1 of the global check
  let ra = a.next(); let rb = b.next(); // both claim "global slot 1": only one can win
  while (!ra.done || !rb.done) { if (!ra.done) ra = a.next(); if (!rb.done) rb = b.next(); }
  assert.equal((ra.value as Result).route, "allowed");
  assert.equal((rb.value as Result).route, "allowed", "the loser moves to slot 2, it is not rejected below the limit");
  assert.equal([...s.docs.keys()].filter((k) => k.startsWith("rl_global_")).length, 2);
});

test("6. different customers (different IP and email) are limited independently", () => {
  const s = new Store();
  for (let i = 0; i < 3; i++) run(s, { email: "ada@example.com", ip: ip(40) });
  assert.equal(run(s, { email: "ada@example.com", ip: ip(40) }).route, "limited");
  assert.equal(run(s, { email: "bob@example.com", ip: ip(41) }).route, "allowed");
  assert.equal(run(s, { email: "bob@example.com", ip: ip(40) }).route, "allowed", "same IP, other email: only the IP/global caps apply");
});

test("7. missing or untrustworthy IP metadata falls back to the shared 'unknown' bucket (not unlimited, not per-visitor)", () => {
  const unknownCases: (string | null)[] = [null, "", "garbage", "10.0.0.5", "127.0.0.1", "192.168.1.1", "100.64.1.1", "169.254.1.1", "999.1.1.1", "::1", "fd00::1"];
  for (const header of unknownCases) {
    const s = new Store();
    run(s, { email: "a@example.com", ip: header });
    assert.ok([...s.docs.keys()].some((k) => k.startsWith("rl_unknown_all_")), `unknown bucket for ${JSON.stringify(header)}`);
    assert.ok(![...s.docs.keys()].some((k) => k.startsWith("rl_ip_")));
  }
  const s = new Store();
  const noGlobal = (c: any) => ({ ...c, checks: { ...c.checks, global: { enabled: false } } }); // isolate the unknown bucket from the flood cap
  const routes = Array.from({ length: 22 }, (_, i) => run(s, { email: `u${i}@example.com`, ip: null, patch: noGlobal }));
  assert.equal(routes.filter((r) => r.route === "allowed").length, 20, "the shared unknown bucket allows 20 per hour");
  assert.equal(routes[20].limitedBy, "unknown");
});

test("7b. only the entry added by our own proxy is trusted: a client-supplied leading entry cannot dodge the limit", () => {
  const s = new Store();
  for (let i = 0; i < 10; i++) run(s, { email: `u${i}@example.com`, ip: `${i + 1}.2.3.4, 198.51.100.99` }); // new fake client IP each time
  assert.equal(run(s, { email: "late@example.com", ip: "77.7.7.7, 198.51.100.99" }).limitedBy, "ip");
  // A header with fewer entries than trusted hops cannot have been written by our proxy.
  const t = new Store();
  run(t, { email: "a@example.com", ip: "198.51.100.5", patch: (x) => ({ ...x, ipSource: { header: "x-forwarded-for", trustedProxyHops: 2 } }) });
  assert.ok([...t.docs.keys()].some((k) => k.startsWith("rl_unknown_")));
});

test("7c. other header names, IPv6 grouped by /64, and an unconfigured header", () => {
  const s = new Store();
  run(s, { email: "a@example.com", ip: "198.51.100.5", header: "cf-connecting-ip", patch: (x) => ({ ...x, ipSource: { header: "cf-connecting-ip", trustedProxyHops: 1 } }) });
  assert.ok([...s.docs.keys()].some((k) => k.startsWith("rl_ip_")));
  const a = new Store(), b = new Store();
  run(a, { email: "a@example.com", ip: "2001:db8:1:2:aaaa::1" });
  run(b, { email: "a@example.com", ip: "2001:db8:1:2:bbbb::9" });
  const ipKey = (st: Store) => [...st.docs.keys()].find((k) => k.startsWith("rl_ip_"));
  assert.ok(ipKey(a));
  assert.equal(ipKey(a), ipKey(b), "addresses in the same /64 share a key");
  const none = new Store();
  run(none, { email: "a@example.com", ip: "198.51.100.5", patch: (x) => ({ ...x, ipSource: { header: "", trustedProxyHops: 1 } }) });
  assert.ok([...none.docs.keys()].some((k) => k.startsWith("rl_unknown_")), "no configured header means no trusted source");
});

test("8. limiter store failure: fail-closed refuses (distinguishable route), fail-open degrades, a blip is retried", () => {
  const closed = new Store();
  closed.failWith = { httpCode: "503", message: "Service unavailable" };
  const r = run(closed, { email: "a@example.com", ip: ip(50) });
  assert.equal(r.route, "unavailable");
  assert.match(r.text, /try again/i);
  assert.equal(closed.attempts, 3, "first try plus two immediate retries");
  assert.equal(closed.docs.size, 0, "nothing was claimed");

  const open = new Store();
  open.failWith = { httpCode: "503", message: "Service unavailable" };
  const o = run(open, { email: "a@example.com", ip: ip(50), patch: (x) => ({ ...x, failMode: "open" }) });
  assert.equal(o.route, "allowed");
  assert.equal(o.degraded, true);

  const blip = new Store();
  blip.failWith = { httpCode: "503", message: "Service unavailable" };
  blip.failTimes = 1;
  const b = run(blip, { email: "a@example.com", ip: ip(50) });
  assert.equal(b.route, "allowed");
  assert.notEqual(b.degraded, true);
});

test("8b. a limiter failure is distinguishable from every other failure and preserves the submission by email", () => {
  const ev = runNode("evaluate-claim.js", {
    input: { error: { message: "Service unavailable", httpCode: "503" } },
    nodes: { "Plan claim": [{ json: { rl: { checks: [{ kind: "ip", limit: 3 }], idx: 0, slot: 1, errors: 2, failMode: "closed", messages: { unavailable: "u", received: "r", limited: "l" } } } }] },
  });
  assert.equal(ev.route, "unavailable");
  const rescue = runNode("prepare-rescue-email.js", {
    input: ev,
    nodes: { "Validate submission": [{ json: { "Your Name": "Ada", "Your Email": "ada@example.com", "What is it you would like us to fix ?": "App <b>crashes</b>" } }] },
  });
  assert.equal(rescue.kind, "rate_limit_unavailable");
  assert.match(rescue.html, /ada@example\.com/);
  assert.match(rescue.html, /App &lt;b&gt;crashes&lt;\/b&gt;/);
  assert.match(rescue.subject, /Spam check unavailable/);
});

test("9. a legitimate retry after a rejection is accepted once the window rolls over, and the rejection did not extend the block", () => {
  const s = new Store();
  for (let i = 0; i < 3; i++) run(s, { email: "ada@example.com", ip: ip(60), nowMs: T0 });
  const before = [...s.docs.keys()].filter((k) => k.startsWith("rl_email_")).length;
  assert.equal(run(s, { email: "ada@example.com", ip: ip(60), nowMs: T0 + 1000 }).route, "limited");
  assert.equal([...s.docs.keys()].filter((k) => k.startsWith("rl_email_")).length, before, "a rejection claims no extra email slot");
  const nextWindow = (Math.floor(T0 / 3_600_000) + 1) * 3_600_000 + 1;
  assert.equal(run(s, { email: "ada@example.com", ip: ip(60), nowMs: nextWindow }).route, "allowed");
});

// ---- email normalisation, privacy, retention, configuration ----------------------------------------------------

test("email limiting uses the normalised address: case, +tags and Gmail dots do not give extra submissions", () => {
  const s = new Store();
  const variants = ["Ada.Lovelace@gmail.com", "adalovelace+a@gmail.com", "ada.lovelace@googlemail.com", "ADALOVELACE@GMAIL.COM", "ada.lovelace+x@gmail.com"];
  const routes = variants.map((e, i) => run(s, { email: e, ip: ip(70 + i) }));
  assert.deepEqual(routes.map((r) => r.route), ["allowed", "allowed", "allowed", "limited", "limited"]);
  const t = new Store();
  assert.equal(run(t, { email: "a.b@example.com", ip: ip(80) }).route, "allowed");
  const keyOf = (e: string) => { const x = new Store(); run(x, { email: e, ip: ip(81) }); return [...x.docs.keys()].find((k) => k.startsWith("rl_email_")); };
  assert.notEqual(keyOf("a.b@example.com"), keyOf("ab@example.com"), "dots only matter for Gmail");
});

test("only salted hashes and timestamps are stored: no raw IP or email, and a different salt gives different keys", () => {
  const s = new Store();
  run(s, { email: "ada@example.com", ip: "203.0.113.9, 198.51.100.9" });
  for (const [id, doc] of s.docs) {
    assert.doesNotMatch(id, /198\.51\.100|203\.0\.113|ada|example/);
    assert.deepEqual(Object.keys(doc).sort(), ["createdAt", "expireAt", "kind", "slot"]);
    assert.doesNotMatch(JSON.stringify(doc), /198\.51\.100|ada|@/);
  }
  const keys = (salt: string) => { const x = new Store(); run(x, { email: "ada@example.com", ip: ip(9), salt }); return [...x.docs.keys()].filter((k) => !k.includes("global")).join(); };
  assert.notEqual(keys(TEST_SALT), keys(TEST_SALT_B));
  assert.equal(keys(TEST_SALT), keys(TEST_SALT));
  assert.doesNotMatch(read("code/rate-limit-settings.js"), /salt\s*:|CHANGE-ME/, "the salt is configured in 'Deployment config' only, never in the settings node");
});

test("every stored document expires after its window plus the grace period (so a TTL policy can delete it)", () => {
  const s = new Store();
  run(s, { email: "ada@example.com", ip: ip(9), nowMs: T0 });
  const hourEnd = (Math.floor(T0 / 3_600_000) + 1) * 3_600_000;
  const minuteEnd = (Math.floor(T0 / 60_000) + 1) * 60_000;
  for (const [id, doc] of s.docs) {
    const windowEnd = id.startsWith("rl_global") ? minuteEnd : hourEnd;
    assert.equal(Date.parse(doc.expireAt), windowEnd + 3_600_000, id);
    assert.ok(Date.parse(doc.expireAt) > Date.parse(doc.createdAt));
  }
});

test("limits and windows are configurable in ONE place and clamped to safe bounds", () => {
  const s = new Store();
  const patch = (c: any) => ({ ...c, checks: { ...c.checks, email: { enabled: true, limit: 1, windowSeconds: 600 } } });
  assert.deepEqual([1, 2].map((i) => run(s, { email: "a@example.com", ip: ip(90 + i), patch }).route), ["allowed", "limited"]);
  const off = new Store();
  run(off, { email: "a@example.com", ip: ip(95), patch: (c) => ({ ...c, checks: { ...c.checks, email: { enabled: false }, global: { enabled: false } } }) });
  assert.deepEqual([...off.docs.keys()].map((k) => k.split("_")[1]), ["ip"], "disabled checks are skipped");
  const wild = new Store();
  const r = run(wild, { email: "a@example.com", ip: ip(96), patch: (c) => ({ ...c, checks: { ...c.checks, ip: { enabled: true, limit: 10_000, windowSeconds: 1 }, email: { enabled: true, limit: -5, windowSeconds: "x" } } }) });
  assert.equal(r.route, "allowed");
  assert.ok([...wild.docs.keys()].some((k) => /^rl_email_[0-9a-f]{24}_\d+_1$/.test(k)), "an invalid limit falls back to a default rather than breaking");
  // The numbers live in the settings node only.
  for (const f of ["prepare-rate-limit.js", "plan-claim.js", "evaluate-claim.js"]) assert.doesNotMatch(read(`code/${f}`), /limit: \d|windowSeconds: \d/, f);
});

// ---- the graph -------------------------------------------------------------------------------------------------

const conn = wf.connections as Record<string, { main: { node: string }[][] }>;
const targets = (n: string, port?: number) => (conn[n]?.main ?? []).flatMap((b, i) => (port === undefined || port === i ? b.map((c) => c.node) : []));
function reach(start: string, skip?: (from: string, port: number) => boolean): Set<string> {
  const seen = new Set<string>(), stack = [start];
  while (stack.length) {
    const c = stack.pop()!;
    if (seen.has(c)) continue;
    seen.add(c);
    (conn[c]?.main ?? []).forEach((b, i) => { if (!skip?.(c, i)) for (const t of b) stack.push(t.node); });
  }
  return seen;
}

test("Gemini, ticket creation and customer/staff emails are only reachable through a GRANTED claim", () => {
  const external = (n: string) => /gemini|gmail/i.test(byName(n).type) || n === "Create a document" || /^Message a model/.test(n);
  const withoutGranted = reach("Form Trigger", (from, port) => from === "Claim granted?" && port === 0);
  const leaked = [...withoutGranted].filter((n) => external(n) && n !== "Send rescue email");
  assert.deepEqual(leaked, [], "no path to Gemini/ticket/notification mails that skips the granted branch");
  assert.deepEqual(targets("Claim granted?", 0), ["Respond to form (accepted)"]);
  assert.deepEqual(targets("Respond to form (accepted)"), ["Message a model"]);
  // The limited path answers the visitor and ends: nothing else runs.
  assert.deepEqual(targets("Claim refused?", 0), ["Respond to form (rejected)"]);
  assert.deepEqual(targets("Respond to form (rejected)"), []);
  // The only email on the unavailable path is the staff rescue email.
  const unavailable = [...reach("Respond to form (unavailable)")].filter(external);
  assert.deepEqual(unavailable, ["Send rescue email"]);
  assert.equal(reach("Respond to form (rejected)").has("Create a document"), false);
});

test("the form uses Form Trigger 2.1 with a response node, request headers on, and every early exit answers the visitor", () => {
  const f = nodes[0];
  assert.equal(f.type, "n8n-nodes-base.formTrigger");
  assert.equal(f.typeVersion, 2.1, "Respond to Webhook is rejected by Form Trigger >= 2.2");
  assert.equal(f.parameters.responseMode, "responseNode");
  assert.equal(f.parameters.options.showHeaders, true);
  assert.equal(typeof f.parameters.path, "string");
  for (const respond of ["Respond to form (accepted)", "Respond to form (rejected)", "Respond to form (unavailable)"]) {
    const n = byName(respond);
    assert.equal(n.type, "n8n-nodes-base.respondToWebhook");
    // Only the visitor-facing text is returned, never the limiter's internal state.
    assert.equal(n.parameters.responseBody, "={{ JSON.stringify({ formSubmittedText: $json.formSubmittedText }) }}");
  }
  // Every branch that leaves the claim loop or the validity gate ends in a Respond node before anything else.
  assert.deepEqual(targets("Reply: invalid"), ["Respond to form (rejected)"]);
  assert.deepEqual(targets("Claim refused?", 1), ["Respond to form (unavailable)"]);
});

test("a rate-limited or invalid request is never mistaken for a ticket: no ticket or email node is reachable from its responder", () => {
  for (const start of ["Rejected submission (stop)", "Respond to form (rejected)"]) {
    const reached = reach(start);
    for (const n of ["Create a document", "Send a message", "Send a message1", "Message a model", "Message a model1", "Get many documents"]) assert.equal(reached.has(n), false, `${start} -> ${n}`);
  }
});

test("the claim store is the only new Firestore use: create-only, its own collection, error output, no retry", () => {
  const c = byName("Claim slot");
  assert.equal(c.parameters.operation, "create");
  assert.equal(c.parameters.collection, "rate_limits");
  assert.equal(c.parameters.documentId, "={{ $json.docId }}");
  assert.equal(c.parameters.columns, "kind,slot,createdAt,expireAt");
  assert.equal(c.onError, "continueErrorOutput");
  assert.equal(c.retryOnFail, undefined, "n8n would retry a 'slot taken' conflict; the loop does its own targeted retries");
  assert.deepEqual(targets("Claim slot", 0), ["Evaluate claim"]);
  assert.deepEqual(targets("Claim slot", 1), ["Evaluate claim"]);
});

test("embedded Code nodes equal n8n/code sources; the SHA-256 is identical to the one in Build ticket", () => {
  const pairs: [string, string][] = [["Rate limit settings", "rate-limit-settings.js"], ["Prepare rate limit", "prepare-rate-limit.js"], ["Plan claim", "plan-claim.js"], ["Evaluate claim", "evaluate-claim.js"], ["Reply: invalid", "reply-invalid.js"], ["Prepare rescue email", "prepare-rescue-email.js"]];
  for (const [n, f] of pairs) assert.equal(byName(n).parameters.jsCode, read(`code/${f}`), n);
  const fn = (src: string) => src.match(/function sha256Hex[\s\S]*?\n}\n/)![0];
  assert.equal(fn(read("code/prepare-rate-limit.js")), fn(read("code/build-ticket.js")));
});

test("the confirmation and rejection texts are visitor-safe and the existing ticket/dedupe behaviour is untouched", () => {
  const settings = runNode("rate-limit-settings.js", { input: {} }).settings;
  for (const k of ["received", "invalid", "limited", "unavailable"]) assert.ok(settings.messages[k].length > 10);
  assert.doesNotMatch(JSON.stringify(settings.messages), /rate limit|firestore|slot|window|\bIP\b/i);
  assert.equal(byName("Create a document").parameters.documentId, "={{ $json.ticketId }}");
  assert.equal(byName("Create a document").parameters.collection, "support_tickets");
});
