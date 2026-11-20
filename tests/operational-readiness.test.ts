/* eslint-disable @typescript-eslint/no-explicit-any -- tests drive untyped n8n Code nodes and workflow JSON */
// Operational-readiness audit findings B6 (Firestore TTL), B8 (failure alerting / execution data),
// B9 (trusted proxy / IP handling) and B10 (Gemini model stability).
//
// What these tests CAN show: the exported workflows and Code nodes behave as written, using a stand-in for n8n's
// `$` helpers and a port of the n8n Firestore node's value serialisation. What they can NOT show: that your live
// Firestore has a TTL policy, that your n8n has an error workflow assigned, what headers your proxy really sends,
// or that Gemini answers this prompt the way it did before. Those need your real environments (docs/n8n-intake-workflow.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { validDeployment } from "./deployment-fixtures";
import { classifyExpireAt, summarizeTtl } from "../scripts/rate-limit-ttl-check.mjs";

const rootUrl = (p: string) => new URL(`../${p}`, import.meta.url);
const read = (p: string) => readFileSync(rootUrl(p), "utf8");
const wf = JSON.parse(read("n8n/ai-support-desk-automation.json"));
const alertWf = JSON.parse(read("n8n/ai-support-desk-failure-alert.json"));
const nodes: any[] = wf.nodes;
const node = (name: string) => nodes.find((n) => n.name === name);
const conn: Record<string, { main: { node: string }[][] }> = wf.connections;
const targets = (name: string, output = 0) => (conn[name]?.main[output] ?? []).map((x) => x.node);
const docs = read("docs/n8n-intake-workflow.md");

type Item = { json: Record<string, any> };
function runCode(file: string, ctx: { input?: any; nodes?: Record<string, any>; executed?: string[]; nowMs?: number } = {}): any[] {
  const $ = (name: string) => {
    const items: Item[] | undefined = ctx.nodes?.[name];
    return {
      isExecuted: ctx.executed?.includes(name) ?? false,
      first: () => {
        if (!items) throw new Error(`no data for node ${name}`);
        return items[0];
      },
      last: () => {
        if (!items) throw new Error(`no data for node ${name}`);
        return items[items.length - 1];
      },
    };
  };
  const RealDate = Date;
  const FakeDate: any = function (...a: any[]) {
    return a.length ? new (RealDate as any)(...a) : new RealDate(ctx.nowMs ?? RealDate.now());
  };
  FakeDate.now = () => ctx.nowMs ?? RealDate.now();
  FakeDate.parse = RealDate.parse;
  return new Function("$", "$input", "$execution", "Date", read(`n8n/code/${file}`))(
    $,
    { first: () => ({ json: ctx.input ?? {} }) },
    { id: "exec-1" },
    FakeDate,
  );
}

/* ============================================================================================================ */
/* B6: Firestore TTL                                                                                              */
/* ============================================================================================================ */

// A faithful port of jsonToDocument() from n8n 2.47.7
// (packages/nodes-base/nodes/Google/Firebase/CloudFirestore/GenericFunctions.ts), the function every Firestore
// node applies to every column. moment's strict ISO-8601 check is replaced by an equivalent regex for the one
// shape our Code nodes emit. This is a port, NOT the node: it shows what the node's documented source does with
// each value, not what a live Firestore stored (that is what `npm run ttl:check` is for).
const ISO_STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
function n8nJsonToDocument(value: unknown): Record<string, unknown> {
  if (value === "true" || value === "false" || typeof value === "boolean") return { booleanValue: value };
  if (value === undefined || value === null) return { nullValue: null };
  if (typeof value === "number" && !Number.isNaN(value)) return value.toString().includes(".") ? { doubleValue: value } : { integerValue: value };
  if (typeof value === "string" && /[-T:]/.test(value) && ISO_STRICT.test(value) && !Number.isNaN(Date.parse(value))) return { timestampValue: new Date(Date.parse(value)).toISOString() };
  if (typeof value === "string") return { stringValue: value };
  return {};
}

const settingsFor = () => runCode("rate-limit-settings.js", { input: {} })[0].json.settings;
const NOW_MS = Date.parse("2026-11-19T10:15:00Z");
const planInputs = () => {
  const settings = settingsFor();
  return {
    settings,
    nodes: {
      "Rate limit settings": [{ json: { settings } }],
      "Deployment config": [validDeployment()],
      "Form Trigger": [{ json: { headers: { "x-forwarded-for": "198.51.100.7" } } }],
      "Validate submission": [{ json: { "Your Email": "ada@example.com" } }],
    },
  };
};

/** One entry per workflow node that writes to `rate_limits`: what builds its fields, and what it must produce. */
function rateLimitWriters(): { node: string; docs: Record<string, any>[] }[] {
  const { settings, nodes: base } = planInputs();
  const rl = runCode("prepare-rate-limit.js", { nodes: base, nowMs: NOW_MS })[0].json.rl;
  const claims = rl.checks.map((_c: any, idx: number) => runCode("plan-claim.js", { input: { rl: { ...rl, idx, slot: 1 } } })[0].json);
  const planned = runCode("plan-rescue-slot.js", { input: {}, nodes: { "Rate limit settings": [{ json: { settings } }], "Plan release": [{ json: { error: "x", limiterError: true } }] }, nowMs: NOW_MS })[0].json;
  const evaluated = runCode("evaluate-rescue-slot.js", { input: {}, nodes: { "Plan rescue slot": [{ json: planned }] }, nowMs: NOW_MS })[0].json;
  const held = runCode("build-held-record.js", { input: evaluated })[0].json;
  const failed = runCode("rescue-email-failed.js", { input: { error: { message: "Gmail said no" } }, nodes: { "Rate limit settings": [{ json: { settings } }], "Prepare rescue email": [{ json: { kind: "ticket_not_saved" } }] }, nowMs: NOW_MS })[0].json;
  return [
    { node: "Claim slot", docs: claims },
    { node: "Claim rescue slot", docs: [planned] },
    { node: "Record held submission", docs: [held] },
    { node: "Record failed notification", docs: [failed] },
  ];
}

test("B6: every workflow node that writes to rate_limits is covered, and no other collection needs a TTL field", () => {
  const writers = nodes.filter((n) => n.type.includes("googleFirebaseCloudFirestore") && n.parameters.collection === "rate_limits" && n.parameters.operation === "create").map((n) => n.name).sort();
  assert.deepEqual(writers, ["Claim rescue slot", "Claim slot", "Record failed notification", "Record held submission"].sort(), "a new writer must be added to rateLimitWriters() below");
  assert.deepEqual(rateLimitWriters().map((w) => w.node).sort(), writers);
  for (const n of nodes.filter((x) => x.type.includes("googleFirebaseCloudFirestore"))) {
    const cols = String(n.parameters.columns ?? "").split(",").filter(Boolean);
    if (n.parameters.collection === "rate_limits" && n.parameters.operation === "create") assert.ok(cols.includes("expireAt"), `${n.name} must write expireAt`);
    else assert.ok(!cols.includes("expireAt"), `${n.name} writes ${n.parameters.collection}: a TTL field there would have no policy`);
  }
});

test("B6: every rate_limits document is built with an expireAt that is a canonical UTC ISO-8601 string, in the future, after createdAt", () => {
  for (const w of rateLimitWriters()) {
    const cols = String(node(w.node).parameters.columns).split(",");
    assert.ok(w.docs.length >= 1);
    for (const doc of w.docs) {
      for (const c of cols) assert.ok(doc[c] !== undefined, `${w.node}: column ${c} is produced (a missing column is written as null, which disables TTL for expireAt)`);
      for (const f of ["expireAt", "createdAt"]) {
        assert.match(doc[f], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `${w.node}.${f}`);
        assert.equal(new Date(doc[f]).toISOString(), doc[f], `${w.node}.${f} round-trips`);
      }
      assert.ok(Date.parse(doc.expireAt) > NOW_MS, `${w.node}: not already expired when written`);
      assert.ok(Date.parse(doc.expireAt) > Date.parse(doc.createdAt), `${w.node}: expires after it was created`);
    }
  }
});

test("B6: through the n8n Firestore serialisation, expireAt and createdAt become Timestamps for EVERY writer; other fields keep their types", () => {
  for (const w of rateLimitWriters()) {
    const cols = String(node(w.node).parameters.columns).split(",");
    for (const doc of w.docs) {
      const stored = Object.fromEntries(cols.map((c) => [c, n8nJsonToDocument(doc[c])]));
      assert.ok("timestampValue" in (stored.expireAt as object), `${w.node}: expireAt must be a timestampValue, got ${JSON.stringify(stored.expireAt)}`);
      assert.ok("timestampValue" in (stored.createdAt as object), `${w.node}: createdAt`);
      for (const c of cols.filter((x) => !["expireAt", "createdAt", "slot"].includes(x))) assert.ok("stringValue" in (stored[c] as object), `${w.node}.${c} stays a string: ${JSON.stringify(stored[c])}`);
      if (cols.includes("slot")) assert.ok("integerValue" in (stored.slot as object), `${w.node}.slot`);
    }
  }
});

test("B6: lifetimes: a slot outlives its window and the in-flight release; held records live for the configured retention", () => {
  const settings = settingsFor();
  const { nodes: base } = planInputs();
  const rl = runCode("prepare-rate-limit.js", { nodes: base, nowMs: NOW_MS })[0].json.rl;
  for (const c of rl.checks) {
    const windowEnd = (c.windowId + 1) * c.windowSeconds * 1000;
    assert.ok(Date.parse(c.expireAt) >= windowEnd + 300 * 1000, `${c.kind}: at least window end + 5 minutes (B4: never deleted while its request still holds or releases it)`);
  }
  const rescue = rateLimitWriters().find((w) => w.node === "Claim rescue slot")!.docs[0];
  assert.ok(Date.parse(rescue.expireAt) > NOW_MS + 60 * 1000);
  const held = rateLimitWriters().find((w) => w.node === "Record held submission")!.docs[0];
  assert.equal(Date.parse(held.expireAt), NOW_MS + settings.rescue.heldRetentionSeconds * 1000);
});

test("B6: the port rejects the formats that WOULD break TTL (guards against a future 'simplification')", () => {
  assert.ok("integerValue" in n8nJsonToDocument(1_800_000_000_000), "epoch milliseconds are an integer, not a Timestamp");
  assert.ok("stringValue" in n8nJsonToDocument("1800000000"), "epoch seconds as text are a string");
  assert.ok("stringValue" in n8nJsonToDocument("in one hour"));
  assert.ok("stringValue" in n8nJsonToDocument(""));
  assert.ok("nullValue" in n8nJsonToDocument(undefined), "a missing column is written as null");
  assert.ok("timestampValue" in n8nJsonToDocument("2026-11-19T11:15:00.000Z"));
});

test("B6: the TTL verification helper distinguishes Timestamps from strings, numbers and missing values", () => {
  const ts = { toMillis: () => Date.parse("2026-11-19T00:00:00Z") };
  assert.equal(classifyExpireAt(ts), "timestamp");
  assert.equal(classifyExpireAt(new Date("2026-11-19T00:00:00Z")), "timestamp");
  assert.equal(classifyExpireAt("2026-11-19T00:00:00.000Z"), "string");
  assert.equal(classifyExpireAt(1763510400000), "number");
  assert.equal(classifyExpireAt(null), "missing");
  assert.equal(classifyExpireAt(undefined), "missing");
  assert.equal(classifyExpireAt({}), "other");
  assert.equal(classifyExpireAt(new Date("nope")), "other");

  const now = Date.parse("2026-11-19T12:00:00Z");
  const fresh = { toMillis: () => now + 3_600_000 };
  const longGone = { toMillis: () => now - 3 * 86_400_000 };
  assert.equal(summarizeTtl([{ expireAt: fresh }, { expireAt: fresh }], now).ok, true);
  const strings = summarizeTtl([{ expireAt: fresh }, { expireAt: "2026-11-19T13:00:00.000Z" }], now);
  assert.equal(strings.ok, false);
  assert.match(strings.problems[0], /not a Firestore Timestamp/);
  const overdue = summarizeTtl([{ expireAt: longGone }], now);
  assert.equal(overdue.ok, false);
  assert.equal(overdue.overdue, 1);
  assert.match(overdue.problems[0], /still exist/);
  assert.equal(summarizeTtl([], now).ok, false, "no documents is 'not confirmed', never 'OK'");
});

test("B6: docs give the exact TTL policy for rl_, rs_limiter_ and held_ documents and do not claim it is active", () => {
  assert.match(docs, /gcloud firestore fields ttls update expireAt --collection-group=rate_limits --enable-ttl/);
  assert.match(docs, /gcloud firestore fields ttls list --collection-group=rate_limits/);
  assert.match(docs, /npm run ttl:check/);
  assert.match(docs, /not verified[^.]*TTL|TTL[^.]*not verified/i);
  for (const prefix of ["rl_", "rs_limiter_", "held_"]) assert.ok(docs.includes(prefix), prefix);
});

/* ============================================================================================================ */
/* B9: trusted proxy and IP handling                                                                              */
/* ============================================================================================================ */

function limiterSource(header: string | undefined, ipSource?: Record<string, unknown>) {
  const settings = settingsFor();
  if (ipSource) settings.ipSource = { ...settings.ipSource, ...ipSource };
  const headerName = String(settings.ipSource.header);
  const headers: Record<string, unknown> = header === undefined ? {} : { [headerName]: header };
  const rl = runCode("prepare-rate-limit.js", {
    nodes: {
      "Rate limit settings": [{ json: { settings } }],
      "Deployment config": [validDeployment()],
      "Form Trigger": [{ json: { headers } }],
      "Validate submission": [{ json: { "Your Email": "ada@example.com" } }],
    },
    nowMs: Date.parse("2026-11-19T10:15:00Z"),
  })[0].json.rl;
  const c = rl.checks.find((x: any) => x.kind === "ip" || x.kind === "unknown");
  return { kind: c.kind as "ip" | "unknown", key: c.key as string, known: rl.sourceKnown as boolean };
}
const keyOf = (v: string, o?: Record<string, unknown>) => {
  const r = limiterSource(v, o);
  assert.equal(r.kind, "ip", `${JSON.stringify(v)} should be a usable client IP`);
  return r.key;
};
const isUnknown = (v: string | undefined, o?: Record<string, unknown>) => {
  const r = limiterSource(v, o);
  assert.equal(r.kind, "unknown", `${JSON.stringify(v)} should NOT be trusted as a client IP`);
  assert.equal(r.known, false);
};

test("B9: the current code trusts exactly one thing: the Nth entry from the RIGHT of one configured header", () => {
  const s = settingsFor();
  assert.deepEqual(s.ipSource, { header: "x-forwarded-for", trustedProxyHops: 1 }, "defaults are unchanged: hop count is NOT guessed");
  const chain = "1.1.1.1, 2.2.2.2, 3.3.3.3";
  assert.notEqual(keyOf(chain, { trustedProxyHops: 1 }), keyOf(chain, { trustedProxyHops: 2 }));
  assert.equal(keyOf(chain, { trustedProxyHops: 1 }), keyOf("3.3.3.3"));
  assert.equal(keyOf(chain, { trustedProxyHops: 2 }), keyOf("2.2.2.2"));
  assert.equal(keyOf(chain, { trustedProxyHops: 3 }), keyOf("1.1.1.1"));
  isUnknown(chain, { trustedProxyHops: 4 }); // fewer entries than trusted proxies: cannot have come from our proxies
  // entries to the LEFT of the trusted one are client-controlled and never influence the result
  assert.equal(keyOf("9.9.9.9, 8.8.8.8, 3.3.3.3", { trustedProxyHops: 1 }), keyOf(chain, { trustedProxyHops: 1 }));
});

test("B9: KNOWN LIMITATION, direct access: if n8n is reachable without the proxy, the client chooses its own IP", () => {
  // No proxy appends anything, so the header is wholly attacker-controlled: every value is accepted as 'the client'.
  const keys = new Set(["8.8.8.8", "8.8.4.4", "1.1.1.1", "9.9.9.9", "208.67.222.222"].map((ip) => keyOf(ip)));
  assert.equal(keys.size, 5, "five spoofed values give five separate per-IP buckets: the per-IP limit is bypassed");
  // The code cannot detect this. It is closed by network configuration only (docs: 'Direct access to n8n').
  assert.match(docs, /Direct access to n8n/);
  assert.match(docs, /firewall|only accept[^.]*proxy|private network|tunnel/i);
});

test("B9: valid public addresses, with ports, brackets and IPv4-mapped forms, map to ONE canonical client", () => {
  const v4 = keyOf("203.0.113.9");
  for (const same of ["203.0.113.9:51234", "  203.0.113.9  ", "203.000.113.009", "::ffff:203.0.113.9", "::FFFF:203.0.113.9", "::ffff:cb00:7109", "0:0:0:0:0:ffff:203.0.113.9", "[::ffff:203.0.113.9]:443"]) {
    assert.equal(keyOf(same), v4, same);
  }
  const v6 = keyOf("2001:db8:1:2::9");
  for (const same of ["[2001:db8:1:2::9]", "[2001:db8:1:2::9]:443", "2001:DB8:1:2:aaaa:bbbb:cccc:dddd", "2001:0db8:0001:0002::1"]) {
    assert.equal(keyOf(same), v6, `same /64: ${same}`);
  }
  assert.notEqual(keyOf("2001:db8:1:3::9"), v6, "a different /64 is a different client");
  assert.notEqual(keyOf("203.0.113.10"), v4);
});

test("B9: private, loopback, link-local, multicast, reserved and unspecified addresses are never trusted as a client", () => {
  const bad = [
    "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "100.127.255.255",
    "0.0.0.0", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    "::1", "::", "fe80::1", "febf::1", "fc00::1", "fd12:3456:789a::1", "fec0::1", "ff02::1", "::1.2.3.4",
    "::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:c0a8:101", "[::ffff:192.168.1.1]:80",
  ];
  for (const v of bad) isUnknown(v);
  for (const v of ["172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.253.0.1", "223.255.255.255"]) keyOf(v); // just outside the private ranges
});

test("B9: malformed values fall back to the shared 'unknown' bucket instead of being trusted or crashing", () => {
  const bad = [
    "", "   ", "unknown", "for=1.2.3.4", "1.2.3", "1.2.3.4.5", "999.1.1.1", "1.2.3.256", "1.2.3.4/24", "1.2.3.4:99999999", "a.b.c.d",
    "2001:db8::g", "2001:::1", "1:2:3:4:5:6:7:8:9", "2001:db8::1::2", "2001:db8:1", "fe80::1%eth0", "::ffff:999.1.1.1", "::ffff:1.2.3",
    "<script>alert(1)</script>", "1.2.3.4; DROP TABLE", "０.０.０.０", "-1.2.3.4", "1e2.3.4.5", "0x7f.0.0.1", ",", ",,,",
  ];
  for (const v of bad) isUnknown(v);
  isUnknown(undefined);
  isUnknown("x".repeat(100));
});

test("B9: oversized or stuffed headers are not trusted, and odd header value types do not crash", () => {
  isUnknown(Array.from({ length: 21 }, (_, i) => `203.0.113.${i + 1}`).join(", "));
  keyOf(Array.from({ length: 20 }, (_, i) => `203.0.113.${i + 1}`).join(", ")); // 20 entries is still accepted
  isUnknown(`203.0.113.9${" ".repeat(600)}`);
  const settings = settingsFor();
  const run = (value: unknown) =>
    runCode("prepare-rate-limit.js", {
      nodes: {
        "Rate limit settings": [{ json: { settings } }],
      "Deployment config": [validDeployment()],
        "Form Trigger": [{ json: { headers: { "x-forwarded-for": value } } }],
        "Validate submission": [{ json: { "Your Email": "ada@example.com" } }],
      },
    })[0].json.rl;
  assert.equal(run(["198.51.100.1", "198.51.100.2"]).sourceKnown, true, "a duplicated header arrives as a list: joined, last entry used");
  for (const v of [42, { a: 1 }, true, null, ["x"], []]) assert.equal(run(v).sourceKnown, false, JSON.stringify(v));
  assert.equal(runCode("prepare-rate-limit.js", {
    nodes: { "Rate limit settings": [{ json: { settings } }],
      "Deployment config": [validDeployment()], "Form Trigger": [{ json: {} }], "Validate submission": [{ json: { "Your Email": "a@example.com" } }] },
  })[0].json.rl.sourceKnown, false, "no headers object at all");
});

test("B9: the configured header name is case-insensitive, and an empty header disables IP trust", () => {
  const settings = settingsFor();
  settings.ipSource = { header: "CF-Connecting-IP", trustedProxyHops: 1 };
  const rl = runCode("prepare-rate-limit.js", {
    nodes: {
      "Rate limit settings": [{ json: { settings } }],
      "Deployment config": [validDeployment()],
      "Form Trigger": [{ json: { headers: { "cf-connecting-ip": "198.51.100.7" } } }],
      "Validate submission": [{ json: { "Your Email": "ada@example.com" } }],
    },
  })[0].json.rl;
  assert.equal(rl.sourceKnown, true);
  isUnknown("198.51.100.7", { header: "" });
  for (const hops of [0, -3, "abc", null, 99]) {
    // out-of-range hop counts are clamped to 1..10, never treated as 'trust everything' or 'trust nothing' silently
    const r = limiterSource("198.51.100.7", { trustedProxyHops: hops });
    assert.ok(r.kind === "ip" || r.kind === "unknown");
  }
});

test("B9: raw client addresses never appear in what is stored or returned by the node", () => {
  const settings = settingsFor();
  const out = JSON.stringify(
    runCode("prepare-rate-limit.js", {
      nodes: {
        "Rate limit settings": [{ json: { settings } }],
      "Deployment config": [validDeployment()],
        "Form Trigger": [{ json: { headers: { "x-forwarded-for": "203.0.113.77" } } }],
        "Validate submission": [{ json: { "Your Email": "ada@example.com" } }],
      },
    }),
  );
  assert.doesNotMatch(out, /203\.0\.113\.77|ada@example\.com/);
});

test("B9: the docs name the facts that must be measured, not guessed, and keep code and live verification apart", () => {
  assert.match(docs, /trustedProxyHops/);
  assert.match(docs, /N8N_PROXY_HOPS/);
  assert.match(docs, /Direct access to n8n/);
  assert.match(docs, /Not verified[^\n]*(live|network|proxy)/i);
});

/* ============================================================================================================ */
/* B8: failure alerting and execution data                                                                        */
/* ============================================================================================================ */

// Nodes after "submitted" that may fail without their own error output. Each is reviewed: the If/NoOp nodes cannot
// fail in practice; 'Prepare rescue email' only builds text; 'Rescue email failed' and 'Rescue email not sent' are
// B5's deliberate failure markers. A failure in 'Prepare rescue email' is loud (the run errors) and is what the error
// workflow is for.
const UNHANDLED_ALLOWED = [
  "Duplicate submission (stop)", "If", "Is duplicate submission", "Is our own earlier attempt", "Is write conflict",
  "Prepare rescue email", "Rescue email failed", "Rescue email not sent",
];
const B5_RESCUE_CHAIN = ["Record failed notification", "Rescue email failed", "Rescue email not sent", "Send rescue email"];
const NEW_ERROR_OUTPUT_NODES = ["Select active articles", "Build ticket", "Prepare email fields", "Classify create error", "Check existing ticket"];

function reachableFrom(start: string): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const out of conn[cur]?.main ?? []) for (const t of out) if (!seen.has(t.node)) { seen.add(t.node); stack.push(t.node); }
  }
  return seen;
}

test("B8: every node after the visitor is told 'submitted' either handles its own failure or is on a short, reviewed list", () => {
  const after = reachableFrom("Respond to form (accepted)");
  const withoutHandler = [...after].filter((n) => !node(n).onError && node(n).type !== "n8n-nodes-base.stickyNote").sort();
  assert.deepEqual(withoutHandler, UNHANDLED_ALLOWED, "a new node that can fail must route to the rescue email, or be added here deliberately");
});

test("B8: Code nodes that can fail between 'submitted' and 'notified' end in the rescue email, never in a silent stop", () => {
  for (const name of NEW_ERROR_OUTPUT_NODES) {
    const n = node(name);
    assert.equal(n.onError, "continueErrorOutput", name);
    assert.equal(conn[name].main.length, 2, `${name}: success output and error output`);
    assert.deepEqual(targets(name, 1), ["Prepare rescue email"], `${name}: error output goes DIRECTLY to the rescue email (these submissions were accepted; B5's throttle is for limiter-unavailable refusals)`);
    assert.ok(targets(name, 0).length >= 1, `${name}: the success path is kept`);
  }
  // an error output can reach nothing but B5's rescue chain: never Gemini, a Firestore ticket write, or the customer email
  assert.deepEqual([...reachableFrom("Prepare rescue email")].sort(), B5_RESCUE_CHAIN);
});

test("B8: B5 is preserved: the limiter-unavailable path is still throttled, and a failed rescue email is still loud", () => {
  assert.deepEqual(targets("Rescue suppressed?", 1), ["Prepare rescue email"]);
  assert.deepEqual(targets("Rescue suppressed?", 0), ["Build held record"]);
  assert.deepEqual(targets("Send rescue email", 1), ["Rescue email failed"]);
  assert.equal(node("Send rescue email").onError, "continueErrorOutput");
  assert.equal(node("Rescue email not sent").type, "n8n-nodes-base.stopAndError");
  const into = Object.entries(conn).filter(([, c]) => c.main.some((o) => o.some((t) => t.node === "Prepare rescue email"))).map(([n]) => n).sort();
  assert.deepEqual(into, ["Build ticket", "Check existing ticket", "Classify create error", "Is duplicate submission", "Is write conflict", "Prepare email fields", "Rescue suppressed?", "Select active articles", "Send a message", "Send a message1"]);
});

test("B8: the rescue email names the failure honestly for each situation, including the new one", () => {
  const form = { json: { valid: true, "Your Name": "Ada", "Your Email": "ada@example.com", "What is it you would like us to fix ?": "The app crashes" } };
  const ticket = { ticketId: "tk_1", customerName: "Ada", customerEmail: "ada@example.com", message: "The app crashes", priority: "Low" };
  const kind = (input: any, executed: string[], extra: Record<string, any> = {}) =>
    runCode("prepare-rescue-email.js", { input, nodes: { "Validate submission": [form], ...extra }, executed })[0].json;
  // Build ticket threw: it has no output, so the validated form values are the fallback
  const built = kind({ error: { message: "TypeError: x is undefined" } }, []);
  assert.match(built.subject, /Ticket NOT saved/);
  assert.match(built.html, /ada@example\.com/);
  assert.match(built.html, /The app crashes/);
  // Prepare email fields threw AFTER the ticket was created: the ticket exists, nothing was emailed
  const notified = kind({ error: { message: "boom" } }, ["Create a document"], { "Build ticket": [{ json: ticket }] });
  assert.equal(notified.kind, "notification_failed");
  assert.match(notified.subject, /Ticket saved, notification failed/);
  assert.match(notified.html, /tk_1/);
  // the existing kinds, including B5's, are unchanged
  assert.equal(kind({ error: { message: "x" } }, ["Create a document", "Send a message1"], { "Build ticket": [{ json: ticket }] }).kind, "acknowledgement_failed");
  assert.equal(kind({ error: { message: "x" } }, ["Create a document", "Send a message"], { "Build ticket": [{ json: ticket }] }).kind, "escalation_failed");
  assert.equal(kind({ kind: "failure", error: "503" }, ["Create a document"], { "Build ticket": [{ json: ticket }] }).kind, "ticket_not_saved");
  assert.equal(kind({ route: "unavailable", rescue: "notice" }, []).kind, "rate_limit_suppressed");
  assert.equal(kind({ route: "unavailable" }, []).kind, "rate_limit_unavailable");
});

test("B8: execution data: kept for BOTH outcomes, because B5 keeps a suppressed submission only in its execution; no error-workflow id is pinned", () => {
  // 'Rescue suppressed?' ends the run normally (a "successful" execution) and 'Build held record' stores identifiers
  // only. If successful executions were not saved, that submission would be gone for good.
  assert.match(read("n8n/code/build-held-record.js"), /submission itself stays in that n8n execution's data/);
  assert.equal(targets("Build held record").join(), "Record held submission");
  assert.deepEqual(reachableFrom("Record held submission").size, 0, "the held path ends there: it is a normal 'success' end");
  const s = wf.settings;
  assert.equal(s.saveDataSuccessExecution, "all", "NOT 'none': that would silently destroy B5's suppressed submissions");
  assert.equal(s.saveDataErrorExecution, "all", "failed runs are the recovery copy of the submission");
  assert.equal(s.saveManualExecutions, false);
  assert.equal(s.saveExecutionProgress, false, "progress saving would persist every node's data mid-run");
  assert.equal(s.errorWorkflow, undefined, "an exported id would point at the wrong workflow on another instance: assign it by hand");
  assert.equal(wf.active, false, "exports stay inactive");
  assert.equal(alertWf.active, false);
});

test("B8: the failure-alert workflow is Error Trigger -> config -> sanitiser -> staff email, and nothing else", () => {
  assert.deepEqual(alertWf.nodes.map((n: any) => n.name), ["Error Trigger", "Alert config", "Prepare alert", "Send failure alert"]);
  assert.deepEqual(alertWf.nodes.map((n: any) => n.type), ["n8n-nodes-base.errorTrigger", "n8n-nodes-base.code", "n8n-nodes-base.code", "n8n-nodes-base.gmail"]);
  const ids = alertWf.nodes.map((n: any) => n.id);
  assert.equal(new Set([...ids, ...nodes.map((n) => n.id)]).size, ids.length + nodes.length, "node ids are unique across both exports");
  const next = (n: string) => alertWf.connections[n].main[0].map((x: any) => x.node);
  assert.deepEqual(next("Error Trigger"), ["Alert config"]);
  assert.deepEqual(next("Alert config"), ["Prepare alert"]);
  assert.deepEqual(next("Prepare alert"), ["Send failure alert"]);
  const send = alertWf.nodes[3];
  assert.equal(send.parameters.sendTo, "={{ $('Alert config').first().json.alertInbox }}", "no address is stored in the Gmail node (B2 pattern)");
  assert.equal(send.parameters.message, "={{ $json.html }}");
  assert.equal(send.parameters.subject, "={{ $json.subject }}");
  assert.equal(send.parameters.options.appendAttribution, false);
  assert.equal(send.credentials.gmailOAuth2.name, node("Send rescue email").credentials.gmailOAuth2.name, "same Gmail credential as the intake workflow");
  for (const [name, file] of [["Alert config", "failure-alert-config.js"], ["Prepare alert", "prepare-failure-alert.js"]]) {
    assert.equal(alertWf.nodes.find((n: any) => n.name === name).parameters.jsCode, read(`n8n/code/${file}`), `${name} embedded code equals its source file`);
  }
  assert.equal(alertWf.settings.saveDataSuccessExecution, "none", "an alert holds no customer data and needs no retained success runs");
  assert.ok(alertWf.nodes.every((n: any) => ["errorTrigger", "code", "gmail"].some((t) => n.type.endsWith(`.${t}`))), "the alert workflow touches no data store and calls no model");
});

const PLACEHOLDER = "REPLACE_WITH_ESCALATION_INBOX@example.com";
const runAlertConfig = (inbox: string | undefined) => {
  const src = read("n8n/code/failure-alert-config.js").replace(`'${PLACEHOLDER}'`, inbox === undefined ? "undefined" : JSON.stringify(inbox));
  return new Function("$", "$input", src)(undefined, { first: () => ({ json: { execution: { id: "9" }, workflow: { name: "W" } } }) });
};

test("B8: 'Alert config' fails closed: a placeholder, missing or malformed inbox throws and is never echoed or used", () => {
  for (const bad of [undefined, "", "   ", PLACEHOLDER, PLACEHOLDER.toLowerCase(), "someone@example.com", "a@host.test", "not-an-address", "a@b", "a b@acme-helpdesk-fixture.dev", "a@acme-helpdesk-fixture.dev\nbcc: x@evil.dev", "Name <a@acme-helpdesk-fixture.dev>", "a@x.dev, b@y.dev", "replace-with-it@acme-helpdesk-fixture.dev"]) {
    let message = "";
    try { runAlertConfig(bad); } catch (e) { message = String((e as Error).message); }
    assert.match(message, /Failure alert not sent: invalid alert inbox configuration \(escalation_inbox_(missing|placeholder|invalid)\)/, JSON.stringify(bad));
    if (bad && bad.trim()) assert.ok(!message.includes(bad.trim()), "the bad value is not echoed");
  }
  const ok = runAlertConfig("staff-inbox@acme-helpdesk-fixture.dev");
  assert.equal(ok[0].json.alertInbox, "staff-inbox@acme-helpdesk-fixture.dev");
  assert.equal(ok[0].json.workflow.name, "W", "the Error Trigger payload passes through untouched");
});

test("B8: the shipped alert workflow contains only the placeholder, and 'Alert config' uses B2's validator verbatim", () => {
  const alertCfg = read("n8n/code/failure-alert-config.js");
  const b2 = read("n8n/code/deployment-config.js");
  const grab = (src: string) => [/const PLACEHOLDER_PATTERN = .*;/, /const RESERVED_DOMAIN = .*;/, /const EMAIL_PATTERN = .*;/, /function inboxProblems\(value\) \{[\s\S]*?\n\}/].map((re) => re.exec(src)?.[0]);
  assert.deepEqual(grab(alertCfg), grab(b2));
  assert.ok(grab(alertCfg).every(Boolean));
  assert.ok(alertCfg.includes(`'${PLACEHOLDER}'`), "ships the placeholder, so a fresh import cannot send anything");
  assert.doesNotMatch(JSON.stringify({ ...alertWf, nodes: alertWf.nodes.filter((n: any) => n.name !== "Alert config") }), /REPLACE_WITH|example\.com/);
});

test("B8: the alert carries NO customer data, masks addresses and links in the error text, escapes HTML and bounds its size", () => {
  const payload = {
    alertInbox: "staff-inbox@acme-helpdesk-fixture.dev",
    execution: {
      id: "231",
      url: "https://n8n.example.org/workflow/1/executions/231",
      retryOf: "34",
      error: { message: "Invalid To header ada@example.com see https://evil.example/x?token=abc <script>alert(1)</script> " + "z".repeat(900), stack: "STACKTRACE at Object.<anonymous> secret" },
      lastNodeExecuted: "Send a message1",
      mode: "trigger",
      // fields that must NEVER be forwarded even if present
      customerEmail: "ada@example.com",
      data: { message: "my private message" },
    },
    workflow: { id: "7", name: "AI Support Desk automation" },
    customerName: "Ada Lovelace",
    message: "TOP SECRET CUSTOMER TEXT",
  };
  const out = runCode("prepare-failure-alert.js", { input: payload })[0].json;
  for (const secret of ["ada@example.com", "Ada Lovelace", "TOP SECRET", "private message", "STACKTRACE", "evil.example", "token=abc", "staff-inbox@acme-helpdesk-fixture.dev"]) {
    assert.ok(!out.html.includes(secret) && !out.subject.includes(secret), `leaked: ${secret}`);
  }
  assert.doesNotMatch(out.html, /<script/);
  assert.match(out.html, /\[email removed\]/);
  assert.match(out.html, /\[link removed\]/);
  assert.match(out.html, /AI Support Desk automation/);
  assert.match(out.html, /Send a message1/);
  assert.match(out.html, /231/);
  assert.match(out.html, /https:\/\/n8n\.example\.org\/workflow\/1\/executions\/231/);
  assert.ok(out.html.length < 3500, "error text is truncated");
  assert.doesNotMatch(out.subject, /[\r\n]/);
  assert.ok(out.subject.length <= 160);
});

test("B8: the alert never throws on missing or odd Error Trigger data, and drops unsafe execution links", () => {
  for (const input of [{}, { execution: null, workflow: null }, { execution: { error: "plain string", id: 5 }, workflow: { name: 12 } }, { execution: { error: { message: undefined } } }]) {
    const out = runCode("prepare-failure-alert.js", { input })[0].json;
    assert.match(out.subject, /Automation failed/);
    assert.ok(out.html.includes("An automation failed"));
  }
  for (const url of ["javascript:alert(1)", "https://n8n.example.org/x?secret=1", "https://user:pw@n8n.example.org/x", "ftp://x/y", "https://a b"]) {
    const out = runCode("prepare-failure-alert.js", { input: { execution: { url } } })[0].json;
    assert.ok(!out.html.includes("Open in n8n"), url);
  }
});

test("B8: no Code node writes to the n8n log or an external sink", () => {
  for (const f of readdirSync(rootUrl("n8n/code"))) {
    // comments may mention these words; only executable lines are scanned
    const src = read(`n8n/code/${f}`).split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    assert.doesNotMatch(src, /console\.|\bfetch\(|XMLHttpRequest|require\(|\$helpers|\$http/, `${f}: customer data must not be logged or sent anywhere except through the reviewed email/Firestore nodes`);
  }
});

test("B8: what the visitor is told does not claim a ticket exists, and tells them what to do if nothing arrives", () => {
  const m = settingsFor().messages;
  assert.doesNotMatch(m.received, /ticket|reference|confirm|created/i);
  assert.match(m.received, /do not hear from us/i);
});

test("B8: docs give the exact manual n8n settings, state the B5/B2 trade-offs, and say what was NOT verified", () => {
  const alertDocs = read("docs/n8n-failure-alerts.md");
  for (const re of [
    /Error Workflow/i, /AI Support Desk failure alert/, /EXECUTIONS_DATA_PRUNE=true/, /EXECUTIONS_DATA_MAX_AGE/,
    /Send Response/, /N8N_ENCRYPTION_KEY/, /backup/i, /Alert config/, /suppressed/i, /salt/i,
  ]) assert.match(alertDocs, re);
  assert.match(alertDocs, /Not verified[^\n]*(error workflow|alert)/i);
  assert.match(alertDocs, /do not turn off[^\n]*successful|Save successful production executions[^\n]*(keep|leave|do not)/i);
  assert.match(docs, /n8n-failure-alerts\.md/, "linked from the intake workflow guide");
});

/* ============================================================================================================ */
/* B10: Gemini models                                                                                             */
/* ============================================================================================================ */

// Facts checked against Google's OFFICIAL pages on 2026-11-19:
//   https://ai.google.dev/gemini-api/docs/models        (stable vs preview; page last updated 2026-10-28)
//   https://ai.google.dev/gemini-api/docs/deprecations  (shutdown dates are the EARLIEST possible)
// Re-check both pages whenever this table changes or a test below fails.
const GEMINI_FACTS: Record<string, { status: "stable" | "preview"; earliestShutdown: string | null; note: string }> = {
  "gemini-3.6-flash": { status: "stable", earliestShutdown: null, note: "Google's named replacement for gemini-3-flash-preview; no shutdown date announced" },
  "gemini-3.1-flash-lite": { status: "stable", earliestShutdown: "2027-05-07", note: "deprecated; Google recommends gemini-3.5-flash-lite" },
  "gemini-3-flash-preview": { status: "preview", earliestShutdown: null, note: "preview model; deprecations page recommends gemini-3.6-flash" },
};
const modelOf = (name: string): string => String(node(name).parameters.modelId.value).replace(/^models\//, "");

test("B10: no Gemini node uses a preview, experimental or floating 'latest' model", () => {
  for (const name of ["Message a model", "Message a model1"]) {
    const id = modelOf(name);
    assert.doesNotMatch(id, /preview|exp|latest/i, `${name}: ${id}`);
    assert.ok(GEMINI_FACTS[id], `${name}: ${id} is not in the checked-facts table above: verify it against Google's pages, then add it`);
    assert.equal(GEMINI_FACTS[id].status, "stable", `${name}: ${id}`);
  }
});

test("B10: the evaluation node moved off the preview model to Google's documented replacement; classification is unchanged", () => {
  assert.equal(modelOf("Message a model1"), "gemini-3.6-flash");
  assert.equal(node("Message a model1").parameters.modelId.cachedResultName, "Gemini 3.6 Flash");
  assert.equal(modelOf("Message a model"), "gemini-3.1-flash-lite", "not switched: it is stable and has until at least 2027-05-07; changing it alters priority/escalation decisions");
});

test("B10: DEADLINE TRIPWIRE: a configured model must not have passed its earliest announced shutdown date", () => {
  const now = Date.now();
  for (const name of ["Message a model", "Message a model1"]) {
    const id = modelOf(name);
    const d = GEMINI_FACTS[id].earliestShutdown;
    if (!d) continue;
    assert.ok(
      now < Date.parse(`${d}T00:00:00Z`),
      `${id} (${name}) reached its earliest announced shutdown date ${d}. Re-read https://ai.google.dev/gemini-api/docs/deprecations, migrate the node (docs/n8n-intake-workflow.md, 'Gemini models'), run the live smoke test, then update GEMINI_FACTS.`,
    );
  }
});

test("B10: the workflow relies on the n8n Gemini node's default 'simplified' output (one item per candidate)", () => {
  for (const name of ["Message a model", "Message a model1"]) {
    const p = node(name).parameters;
    assert.notEqual(p.simplify, false, `${name}: Build ticket reads content.parts from the simplified item`);
    assert.equal(p.jsonOutput, undefined, `${name}: JSON is requested in the prompt; the answer is parsed and validated by Build ticket`);
    assert.equal(node(name).onError, "continueRegularOutput", `${name}: a failed call must fall back to human review, never stop the run`);
  }
});

function buildWith(parts: unknown, which: "Message a model" | "Message a model1" = "Message a model") {
  const cls = { category: "Bug", reason: "r", sentiment: "Negative", priority: "Low", summary: "SUMMARY-OK" };
  const ev = { kbStatus: "not_covered", relevantArticleId: null, relevantSection: null, coverageReason: "c", supportedSteps: [], unsupportedParts: [], escalationRequired: true, customerResponse: "Hello" };
  const wrap = (p: unknown) => [{ json: { content: { parts: p } } }];
  const text = (o: unknown) => [{ text: JSON.stringify(o) }];
  return runCode("build-ticket.js", {
    nodes: {
      "Validate submission": [{ json: { valid: true, errors: [], "Your Name": "Ada", "Your Email": "ada@example.com", "What is it you would like us to fix ?": "The app crashes" } }],
      "Select active articles": [{ json: { articleCount: 1, kbUnavailable: false, articles: [{ id: "a1", title: "Crash", content: "Reinstall the app from the store." }] } }],
      "Message a model": which === "Message a model" ? wrap(parts) : wrap(text(cls)),
      "Message a model1": which === "Message a model1" ? wrap(parts) : wrap(text(ev)),
    },
  })[0].json;
}

test("B10: model output split across parts, preceded by thought/signature parts, or fenced still parses; anything else fails safe", () => {
  const cls = JSON.stringify({ category: "Bug", reason: "r", sentiment: "Negative", priority: "Low", summary: "SUMMARY-OK" });
  const cut = Math.floor(cls.length / 2);
  const ok: [string, unknown][] = [
    ["single part", [{ text: cls }]],
    ["split across two parts", [{ text: cls.slice(0, cut) }, { text: cls.slice(cut) }]],
    ["leading thought part", [{ thought: true, text: "reasoning that is not JSON" }, { text: cls }]],
    ["leading signature-only part", [{ thoughtSignature: "abc" }, { text: cls }]],
    ["trailing empty/signature part", [{ text: cls }, { thoughtSignature: "abc" }, { text: "" }]],
    ["fenced", [{ text: "```json\n" + cls + "\n```" }]],
  ];
  for (const [label, parts] of ok) {
    const t = buildWith(parts);
    assert.equal(t.summary, "SUMMARY-OK", label);
    assert.notEqual(t.intakeIssue, "classification_failed", label);
  }
  const bad: [string, unknown][] = [
    ["only a thought part", [{ thought: true, text: cls }]],
    ["no parts", []],
    ["parts missing", undefined],
    ["parts not an array", "nope"],
    ["null parts", null],
    ["non-JSON text", [{ text: "Sure! Here is your answer." }]],
    ["JSON array", [{ text: "[" + cls + "]" }]],
    ["truncated", [{ text: cls.slice(0, cut) }]],
  ];
  for (const [label, parts] of bad) {
    const t = buildWith(parts);
    assert.equal(t.intakeIssue, "classification_failed", label);
    assert.equal(t.escalationStatus, "required", `${label}: held for a human`);
    assert.equal(t.message, "The app crashes", `${label}: the submission is preserved`);
  }
});

test("B10: a thought part can never smuggle content into the evaluation either", () => {
  const evalJson = {
    kbStatus: "covered", relevantArticleId: "a1", relevantSection: "Crash", coverageReason: "c",
    supportedSteps: ["Reinstall the app from the store."], unsupportedParts: [], escalationRequired: false, customerResponse: "EVIL-MARKER",
  };
  const t = buildWith([{ thought: true, text: JSON.stringify({ ...evalJson, supportedSteps: ["EVIL-MARKER"] }) }, { text: JSON.stringify(evalJson) }], "Message a model1");
  assert.equal(t.escalationStatus, "not_required");
  assert.deepEqual(t.supportedSteps, ["Reinstall the app from the store."], "only the real answer part was used, and it was still verified against the article");
  assert.doesNotMatch(t.customerResponse, /EVIL-MARKER/);
});

test("B10: docs record the verified model facts, the source pages, and the live smoke test that remains", () => {
  for (const re of [/gemini-3\.6-flash/, /gemini-3-flash-preview/, /gemini-3\.1-flash-lite/, /2027-05-07|May 7, 2027/, /ai\.google\.dev\/gemini-api\/docs\/deprecations/, /smoke test/i]) assert.match(docs, re);
  assert.match(docs, /Not verified[^\n]*Gemini/i);
});
