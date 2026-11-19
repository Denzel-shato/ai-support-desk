/* eslint-disable @typescript-eslint/no-explicit-any -- tests read untyped workflow JSON and run Code-node sources */
// B2: placeholder and missing deployment configuration must never pass as valid.
// The Code-node sources run in plain Node with a stand-in for n8n's `$` helpers. This proves the LOGIC and the
// wiring of the exported JSON. It does NOT run n8n, so it cannot prove how a real instance behaves (see
// docs/n8n-deployment-config.md, "What is not verified"). No real inbox or secret appears in this file.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TEST_INBOX, TEST_SALT, TEST_SALT_B, validDeployment } from "./deployment-fixtures";

const ROOT = new URL("../", import.meta.url).pathname;
const read = (p: string) => readFileSync(new URL(`../n8n/${p}`, import.meta.url), "utf8");
const wf = JSON.parse(read("ai-support-desk-automation.json"));
const sendWf = JSON.parse(read("ai-support-desk-send-response.json"));
type Node = { name: string; type: string; parameters: Record<string, any> };
const nodes: Node[] = wf.nodes;
const byName = (n: string) => nodes.find((x) => x.name === n)!;
const targets = (from: string, branch = 0) => (wf.connections[from]?.main?.[branch] ?? []).map((c: any) => c.node);

const PLACEHOLDER_INBOX = "REPLACE_WITH_ESCALATION_INBOX@example.com";
const PLACEHOLDER_SALT = "CHANGE-ME-TO-A-LONG-RANDOM-STRING";

type Items = Record<string, { json: Record<string, any> }[]>;
function exec(source: string, ctx: { nodes?: Items; input?: Record<string, any> } = {}): any[] {
  const $ = (name: string) => {
    const items = ctx.nodes?.[name];
    if (!items) throw new Error(`no data for node ${name}`);
    return { first: () => items[0], all: () => items };
  };
  return new Function("$", "$input", source)($, { first: () => ({ json: ctx.input ?? {} }) });
}
const lit = (v: unknown) => (v === undefined ? "undefined" : JSON.stringify(v));
/** Run 'Deployment config' with the two values the operator would type in. */
function deploy(inbox: unknown, salt: unknown, input: Record<string, any> = {}) {
  let src = read("code/deployment-config.js");
  const a = `'${PLACEHOLDER_INBOX}'`, b = `'${PLACEHOLDER_SALT}'`;
  assert.ok(src.includes(a) && src.includes(b), "the shipped node must contain exactly these placeholders");
  src = src.replace(a, () => lit(inbox)).replace(b, () => lit(salt));
  return exec(src, { input })[0].json;
}
const shipped = () => exec(read("code/deployment-config.js"), { input: {} })[0].json;

// ---- 1. the shipped placeholders are never valid ---------------------------------------------------------------

test("as shipped, 'Deployment config' reports BOTH placeholders and exposes neither value", () => {
  const out = shipped();
  assert.equal(out.deployment.ok, false);
  assert.deepEqual(out.deployment.errors, ["escalation_inbox_placeholder", "rate_limit_salt_placeholder"]);
  assert.equal(out.deployment.escalationInbox, "");
  assert.equal(out.deployment.rateLimitSalt, "");
  assert.doesNotMatch(JSON.stringify(out), /REPLACE_WITH|CHANGE-ME|example\.com/, "a bad value is never echoed");
});

test("a valid inbox with the placeholder salt is refused, and a valid salt with the placeholder inbox is refused", () => {
  assert.deepEqual(deploy(TEST_INBOX, PLACEHOLDER_SALT).deployment.errors, ["rate_limit_salt_placeholder"]);
  assert.deepEqual(deploy(PLACEHOLDER_INBOX, TEST_SALT).deployment.errors, ["escalation_inbox_placeholder"]);
  for (const out of [deploy(TEST_INBOX, PLACEHOLDER_SALT), deploy(PLACEHOLDER_INBOX, TEST_SALT)]) {
    assert.equal(out.deployment.ok, false);
    assert.equal(out.deployment.escalationInbox, "", "no partial configuration is handed on");
    assert.equal(out.deployment.rateLimitSalt, "");
  }
});

test("a valid configuration passes, hands the values on, and leaves the form submission untouched", () => {
  const form = { "Your Name": "Ada", headers: { "x-forwarded-for": "198.51.100.7" } };
  const out = deploy(TEST_INBOX, TEST_SALT, form);
  assert.equal(out.deployment.ok, true);
  assert.deepEqual(out.deployment.errors, []);
  assert.equal(out.deployment.escalationInbox, TEST_INBOX);
  assert.equal(out.deployment.rateLimitSalt, TEST_SALT);
  assert.equal(out["Your Name"], "Ada");
  assert.deepEqual(out.headers, form.headers);
});

// ---- 2. escalation inbox validation ----------------------------------------------------------------------------

test("escalation inbox: missing, placeholder, reserved-domain and malformed values are all refused", () => {
  const bad: [unknown, string][] = [
    [undefined, "escalation_inbox_missing"], [null, "escalation_inbox_missing"], ["", "escalation_inbox_missing"], ["   ", "escalation_inbox_missing"],
    [42, "escalation_inbox_missing"], [{}, "escalation_inbox_missing"], [["staff@acme-helpdesk-fixture.dev"], "escalation_inbox_missing"],
    [PLACEHOLDER_INBOX, "escalation_inbox_placeholder"], [PLACEHOLDER_INBOX.toLowerCase(), "escalation_inbox_placeholder"],
    ["replace-with-inbox@acme-helpdesk-fixture.dev", "escalation_inbox_placeholder"], ["change_me@acme-helpdesk-fixture.dev", "escalation_inbox_placeholder"],
    ["your-email@acme-helpdesk-fixture.dev", "escalation_inbox_placeholder"],
    ["someone@example.com", "escalation_inbox_placeholder"], ["a@example.org", "escalation_inbox_placeholder"], ["a@mail.example.net", "escalation_inbox_placeholder"],
    ["a@host.test", "escalation_inbox_placeholder"], ["a@host.invalid", "escalation_inbox_placeholder"], ["a@host.example", "escalation_inbox_placeholder"],
    ["plainaddress", "escalation_inbox_invalid"], ["a@b", "escalation_inbox_invalid"], ["a@b.c", "escalation_inbox_invalid"], ["@acme.io", "escalation_inbox_invalid"],
    ["a@@acme.io", "escalation_inbox_invalid"], ["a..b@acme.io", "escalation_inbox_invalid"], [".a@acme.io", "escalation_inbox_invalid"], ["a.@acme.io", "escalation_inbox_invalid"],
    ["a@acme..io", "escalation_inbox_invalid"], ["a@-acme.io", "escalation_inbox_invalid"], ["a b@acme.io", "escalation_inbox_invalid"],
    [" staff@acme.io", "escalation_inbox_invalid"], ["staff@acme.io ", "escalation_inbox_invalid"],
    ["a@acme.io, b@acme.io", "escalation_inbox_invalid"], ["a@acme.io;b@acme.io", "escalation_inbox_invalid"], ["Staff <a@acme.io>", "escalation_inbox_invalid"],
    ["a@acme.io\nBcc: x@acme.io", "escalation_inbox_invalid"], ["a@acme.io\r\n", "escalation_inbox_invalid"],
    ["{{ $json.inbox }}", "escalation_inbox_invalid"], ["{{x}}@acme.io", "escalation_inbox_invalid"], [`${"a".repeat(65)}@acme.io`, "escalation_inbox_invalid"],
  ];
  for (const [value, code] of bad) {
    const out = deploy(value, TEST_SALT);
    assert.equal(out.deployment.ok, false, JSON.stringify(value));
    assert.deepEqual(out.deployment.errors, [code], JSON.stringify(value));
    assert.equal(out.deployment.escalationInbox, "");
  }
});

test("escalation inbox: ordinary staff mailboxes are accepted", () => {
  for (const ok of [TEST_INBOX, "help.desk+tickets@sub.acme-helpdesk-fixture.co.uk", "a_b-c@acme-helpdesk-fixture.org"]) {
    const out = deploy(ok, TEST_SALT);
    assert.equal(out.deployment.ok, true, ok);
    assert.equal(out.deployment.escalationInbox, ok);
  }
});

// ---- 3. rate-limit salt validation -----------------------------------------------------------------------------

test("rate-limit salt: missing, placeholder, short, low-variety and unsafe values are all refused", () => {
  const bad: [unknown, string][] = [
    [undefined, "rate_limit_salt_missing"], [null, "rate_limit_salt_missing"], ["", "rate_limit_salt_missing"], ["    ", "rate_limit_salt_missing"], [12345, "rate_limit_salt_missing"], [{}, "rate_limit_salt_missing"],
    [PLACEHOLDER_SALT, "rate_limit_salt_placeholder"], [PLACEHOLDER_SALT.toLowerCase(), "rate_limit_salt_placeholder"],
    [`changeme${TEST_SALT}`, "rate_limit_salt_placeholder"], [`REPLACE_WITH_RANDOM_SALT_${TEST_SALT}`, "rate_limit_salt_placeholder"], [`${TEST_SALT}-placeholder`, "rate_limit_salt_placeholder"],
    ["a1b2c3d4e5f60718293a4b5c6d7e8f9", "rate_limit_salt_length"], // 31 characters
    [`${TEST_SALT}${TEST_SALT}${TEST_SALT}${TEST_SALT}x`, "rate_limit_salt_length"],
    ["a".repeat(64), "rate_limit_salt_low_variety"], ["ab".repeat(32), "rate_limit_salt_low_variety"], ["1234567".repeat(10), "rate_limit_salt_low_variety"],
    [` ${TEST_SALT}`, "rate_limit_salt_invalid_characters"], [`${TEST_SALT}\n`, "rate_limit_salt_invalid_characters"], [`${TEST_SALT.slice(0, 30)} ${TEST_SALT.slice(30)}`, "rate_limit_salt_invalid_characters"],
    [`{{ $env.SALT }}${TEST_SALT}`, "rate_limit_salt_invalid_characters"], [`<${TEST_SALT}>`, "rate_limit_salt_invalid_characters"], [`${TEST_SALT}é`, "rate_limit_salt_invalid_characters"],
  ];
  for (const [value, code] of bad) {
    const out = deploy(TEST_INBOX, value);
    assert.equal(out.deployment.ok, false, JSON.stringify(value));
    assert.deepEqual(out.deployment.errors, [code], JSON.stringify(value));
    assert.equal(out.deployment.rateLimitSalt, "");
  }
});

test("rate-limit salt: output shaped like `openssl rand -hex 32` / `-base64 48` is accepted", () => {
  const base64 = Buffer.from(Array.from({ length: 48 }, (_, i) => (i * 37 + 11) % 256)).toString("base64");
  for (const ok of [TEST_SALT, TEST_SALT_B, base64, `${TEST_SALT}${TEST_SALT}`]) assert.equal(deploy(TEST_INBOX, ok).deployment.ok, true, ok.slice(0, 8));
});

test("both problems are reported together, as codes only", () => {
  const out = deploy("", "short");
  assert.deepEqual(out.deployment.errors, ["escalation_inbox_missing", "rate_limit_salt_length", "rate_limit_salt_low_variety"]);
  assert.ok(out.deployment.errors.every((e: string) => /^[a-z_]+$/.test(e)));
});

// ---- 4. the workflow stops when the configuration is not valid -------------------------------------------------

test("wiring: Form Trigger -> Deployment config -> gate; only the valid branch continues; the other answers politely, then fails the run", () => {
  assert.deepEqual(targets("Form Trigger"), ["Deployment config"]);
  assert.deepEqual(targets("Deployment config"), ["Deployment config valid?"]);
  assert.deepEqual(targets("Deployment config valid?", 0), ["Rate limit settings"]);
  assert.deepEqual(targets("Deployment config valid?", 1), ["Respond to form (misconfigured)"]);
  assert.deepEqual(targets("Respond to form (misconfigured)"), ["Stop: deployment misconfigured"]);
  assert.equal(wf.connections["Stop: deployment misconfigured"], undefined, "the misconfigured branch ends in a failing Stop and Error node");
  assert.equal(byName("Stop: deployment misconfigured").type, "n8n-nodes-base.stopAndError");
  const incoming = (name: string) => Object.entries<any>(wf.connections).filter(([, c]) => c.main.some((b: any[]) => b.some((x) => x.node === name))).map(([n]) => n);
  assert.deepEqual(incoming("Rate limit settings"), ["Deployment config valid?"], "nothing can reach the limiter or anything after it without passing the gate");
  assert.deepEqual(incoming("Deployment config"), ["Form Trigger"]);
});

test("nothing that calls Firestore, Gemini or Gmail is reachable from the misconfigured branch or without the gate", () => {
  const external = (n: Node) => /gemini|firestore|gmail/i.test(n.type);
  const reach = (start: string, skip?: (from: string, branch: number) => boolean) => {
    const seen = new Set<string>(), stack = [start];
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      (wf.connections[c]?.main ?? []).forEach((b: any[], i: number) => { if (skip?.(c, i)) return; for (const t of b) stack.push(t.node); });
    }
    return seen;
  };
  assert.deepEqual([...reach("Respond to form (misconfigured)")].filter((n) => external(byName(n))), []);
  const withoutValid = reach("Form Trigger", (from, i) => from === "Deployment config valid?" && i === 0);
  assert.deepEqual([...withoutValid].sort(), ["Deployment config", "Deployment config valid?", "Form Trigger", "Respond to form (misconfigured)", "Stop: deployment misconfigured"]);
});

test("the gate expression is 'yes' only for ok === true: placeholder, missing, malformed or absent deployment data all fail closed", () => {
  const cond = byName("Deployment config valid?").parameters.conditions.conditions[0];
  assert.equal(cond.rightValue, "yes");
  const inner = String(cond.leftValue).replace(/^=\{\{/, "").replace(/\}\}$/, "");
  const gate = (json: any) => new Function("$json", `return ${inner}`)(json);
  assert.equal(gate(shipped()), "no", "as shipped");
  assert.equal(gate(deploy(TEST_INBOX, PLACEHOLDER_SALT)), "no");
  assert.equal(gate(deploy(PLACEHOLDER_INBOX, TEST_SALT)), "no");
  assert.equal(gate({}), "no", "no deployment object at all");
  assert.equal(gate({ deployment: {} }), "no");
  assert.equal(gate({ deployment: { ok: "true" } }), "no", "a truthy string is not ok === true");
  assert.equal(gate({ deployment: { ok: 1 } }), "no");
  assert.equal(gate(deploy(TEST_INBOX, TEST_SALT)), "yes");
});

test("misconfigured branch: the visitor sees the existing 'unavailable' text; the failing run names problem codes, never values", () => {
  const settings = exec(read("code/rate-limit-settings.js"), { input: {} })[0].json.settings;
  const bad = shipped();
  const body = String(byName("Respond to form (misconfigured)").parameters.responseBody).replace(/^=\{\{/, "").replace(/\}\}$/, "");
  const text = JSON.parse(new Function("$json", `return ${body}`)(bad)).formSubmittedText;
  assert.equal(text, settings.messages.unavailable);
  assert.doesNotMatch(text, /config|inbox|salt|placeholder/i, "no operator detail leaks to the public visitor");
  const msgExpr = String(byName("Stop: deployment misconfigured").parameters.errorMessage).replace(/^=\{\{/, "").replace(/\}\}$/, "");
  const $ = () => ({ first: () => ({ json: bad }) });
  const message = new Function("$", `return ${msgExpr}`)($);
  assert.match(message, /escalation_inbox_placeholder/);
  assert.match(message, /rate_limit_salt_placeholder/);
  assert.doesNotMatch(message, /REPLACE_WITH|CHANGE-ME|example\.com/);
});

// ---- 5. defence in depth: the limiter re-checks the salt and refuses to run on a bad one ------------------------

function prepareRateLimit(deployment: any, withNode = true) {
  const settings = exec(read("code/rate-limit-settings.js"), { input: {} })[0].json;
  const nodesData: Items = {
    "Rate limit settings": [{ json: settings }],
    "Form Trigger": [{ json: { headers: { "x-forwarded-for": "203.0.113.9, 198.51.100.9" } } }],
    "Validate submission": [{ json: { "Your Email": "ada@acme-helpdesk-fixture.dev" } }],
  };
  if (withNode) nodesData["Deployment config"] = [{ json: { deployment } }];
  return exec(read("code/prepare-rate-limit.js"), { nodes: nodesData })[0].json.rl;
}

test("'Prepare rate limit' throws (fails the run) for a missing node, ok:false, a forged ok:true with a bad salt, or a missing salt", () => {
  const refuse = /Rate limiter refused to run/;
  assert.throws(() => prepareRateLimit(undefined, false), /no data for node Deployment config/);
  assert.throws(() => prepareRateLimit(undefined), refuse);
  assert.throws(() => prepareRateLimit({ ok: false, errors: ["x"], rateLimitSalt: "" }), refuse);
  for (const salt of [PLACEHOLDER_SALT, "", undefined, null, "short", "a".repeat(64), `${TEST_SALT}\n`, "changeme-changeme-changeme-changeme-0123"]) {
    assert.throws(() => prepareRateLimit({ ok: true, errors: [], rateLimitSalt: salt }), refuse, JSON.stringify(salt));
  }
  const err = (() => { try { prepareRateLimit({ ok: true, rateLimitSalt: PLACEHOLDER_SALT }); } catch (e) { return String(e); } return ""; })();
  assert.doesNotMatch(err, /CHANGE-ME/, "the error names the problem, not the value");
});

test("'Prepare rate limit' runs with a valid salt and the salt changes every stored key (algorithm and limits untouched)", () => {
  const a = prepareRateLimit({ ok: true, errors: [], rateLimitSalt: TEST_SALT });
  const b = prepareRateLimit({ ok: true, errors: [], rateLimitSalt: TEST_SALT_B });
  assert.deepEqual(a.checks.map((c: any) => `${c.kind}:${c.limit}:${c.windowSeconds}`), ["global:20:60", "ip:10:3600", "email:3:3600"]);
  assert.deepEqual(b.checks.map((c: any) => `${c.kind}:${c.limit}:${c.windowSeconds}`), ["global:20:60", "ip:10:3600", "email:3:3600"]);
  for (const kind of ["ip", "email"]) assert.notEqual(a.checks.find((c: any) => c.kind === kind).key, b.checks.find((c: any) => c.kind === kind).key);
});

test("'Rate limit settings' no longer carries any salt or placeholder", () => {
  const src = read("code/rate-limit-settings.js");
  assert.doesNotMatch(src, /CHANGE-ME|REPLACE_WITH|salt\s*:/);
  assert.equal("salt" in exec(src, { input: {} })[0].json.settings, false);
});

// ---- 6. both staff emails go to the configured inbox, and nothing is hard-coded ---------------------------------

test("escalation and rescue emails use the same validated inbox from 'Deployment config'; no literal address is stored in any Gmail node", () => {
  const expr = "={{ $('Deployment config').first().json.deployment.escalationInbox }}";
  assert.equal(byName("Send a message").parameters.sendTo, expr);
  assert.equal(byName("Send rescue email").parameters.sendTo, expr);
  const gmail = nodes.filter((n) => n.type === "n8n-nodes-base.gmail");
  assert.deepEqual(Object.fromEntries(gmail.map((n) => [n.name, n.parameters.sendTo])), { "Send a message": expr, "Send a message1": "={{ $json.customerEmail }}", "Send rescue email": expr });
  for (const n of gmail) assert.doesNotMatch(String(n.parameters.sendTo), /^[^{]*@[^}]*$/, `${n.name} must not hold a literal address`);
  // The expression resolves to exactly what the validator accepted.
  const inner = expr.replace(/^=\{\{/, "").replace(/\}\}$/, "");
  const ok = deploy(TEST_INBOX, TEST_SALT);
  assert.equal(new Function("$", `return ${inner}`)(() => ({ first: () => ({ json: ok }) })), TEST_INBOX);
  // The run cannot get this far with a bad configuration: the expression would be empty (and the gate stops it earlier).
  const bad = shipped();
  assert.equal(new Function("$", `return ${inner}`)(() => ({ first: () => ({ json: bad }) })), "");
});

test("the Deployment config Gmail-expression node is the only node that mentions the placeholders", () => {
  const mention = nodes.filter((n) => /REPLACE_WITH_ESCALATION_INBOX|CHANGE-ME-TO-A-LONG/.test(JSON.stringify(n.parameters))).map((n) => n.name);
  assert.deepEqual(mention, ["Deployment config"]);
  assert.equal(byName("Deployment config").parameters.jsCode, read("code/deployment-config.js"));
  assert.equal(byName("Rate limit settings").parameters.jsCode, read("code/rate-limit-settings.js"));
  assert.equal(byName("Prepare rate limit").parameters.jsCode, read("code/prepare-rate-limit.js"));
});

test("the two copies of the salt validator are identical, so they cannot drift", () => {
  const block = (f: string) => /\/\/ ---- BEGIN salt validator[^\n]*\n([\s\S]*?)\/\/ ---- END salt validator/.exec(read(`code/${f}`))?.[1];
  assert.ok(block("deployment-config.js"));
  assert.equal(block("prepare-rate-limit.js"), block("deployment-config.js"));
  const pattern = (f: string) => /const PLACEHOLDER_PATTERN = .*;/.exec(read(`code/${f}`))?.[0];
  assert.equal(pattern("prepare-rate-limit.js"), pattern("deployment-config.js"));
});

// ---- 7. placeholder inventory and secret hygiene ---------------------------------------------------------------

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if ([".git", "node_modules", ".next", "package-lock.json"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

test("inventory: outside docs, changelog and tests, the placeholders exist ONLY inside the 'Deployment config' node (and its JSON copy)", () => {
  const found = new Set<string>();
  for (const f of files(ROOT)) {
    const rel = f.slice(ROOT.length);
    if (/^(docs|tests)\//.test(rel) || rel === "CHANGELOG.md") continue;
    if (/REPLACE_WITH_ESCALATION_INBOX|CHANGE-ME-TO-A-LONG-RANDOM-STRING/.test(readFileSync(f, "utf8"))) found.add(rel);
  }
  assert.deepEqual([...found].sort(), ["n8n/ai-support-desk-automation.json", "n8n/code/deployment-config.js"]);
});

test("no real-looking secret or address is committed in workflow JSON, code, docs or env examples", () => {
  for (const f of files(ROOT)) {
    const rel = f.slice(ROOT.length);
    if (!/^(docs\/|n8n\/)|^\.env\.example$|^README\.md$/.test(rel)) continue;
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /\b[0-9a-f]{64}\b/i, `${rel}: a 64-hex string looks like a generated secret`);
    assert.doesNotMatch(text, /\b[A-Za-z0-9+/]{60,}={0,2}(?![A-Za-z0-9+/])/, `${rel}: a long base64-like string looks like a secret`);
  }
  // The only literal inbox-like value in the intake workflow is the placeholder inside the Deployment config node.
  const withoutNode = JSON.stringify({ ...wf, nodes: nodes.filter((n) => n.name !== "Deployment config") });
  assert.doesNotMatch(withoutNode, /REPLACE_WITH|CHANGE-ME/);
});

test("scope: the Send Response workflow is not part of this change and knows nothing about the deployment config", () => {
  const text = JSON.stringify(sendWf);
  assert.doesNotMatch(text, /Deployment config|REPLACE_WITH_ESCALATION_INBOX|CHANGE-ME/);
  assert.equal(sendWf.active, false);
  assert.equal(wf.active, false, "the intake workflow stays exported inactive");
});
