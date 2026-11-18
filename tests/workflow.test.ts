/* eslint-disable @typescript-eslint/no-explicit-any -- tests read untyped workflow JSON and dynamic route modules */
// Tests for the PROPOSED n8n workflow (n8n/ai-support-desk-automation.json).
// They run the Code-node sources in plain Node with a stand-in for n8n's `$`
// helpers, and check the wiring of the JSON. They do NOT run n8n, Gemini,
// Firestore or Gmail, so they cannot prove the workflow works when imported.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { approvalRequired } from "@/lib/overview";
import { serializeTicket } from "@/lib/ticket-serialization";

const read = (p: string) => readFileSync(new URL(`../n8n/${p}`, import.meta.url), "utf8");
const wf = JSON.parse(read("ai-support-desk-automation.json"));
type Node = { name: string; type: string; parameters: Record<string, any>; alwaysOutputData?: boolean; credentials?: Record<string, any> };
const nodes: Node[] = wf.nodes;
const byName = (n: string) => nodes.find((x) => x.name === n)!;

type Item = { json: Record<string, any> };
function run(file: string, ctx: { input?: Item[]; nodes?: Record<string, Item[]> }): Item[] {
  const input = ctx.input ?? [];
  const $ = (name: string) => {
    const items = ctx.nodes?.[name];
    if (!items) throw new Error(`no data for node ${name}`);
    return { first: () => items[0], all: () => items, item: items[0] };
  };
  const $input = { all: () => input, first: () => input[0] };
  return new Function("$", "$input", read(`code/${file}`))($, $input);
}

const article = (o: Record<string, unknown>) => ({ json: { _id: "a", title: "T", category: "C", keywords: ["k1", "k2"], content: "Body", active: true, ...o } });
const model = (obj: unknown) => [{ json: { content: { parts: [{ text: typeof obj === "string" ? obj : JSON.stringify(obj) }] } } }];
const form = [{ json: { "Your Name": "Ada", "Your Email": "ada@example.com", "What is it you would like us to fix ?": "App crashes" } }];
const classification = (priority: string) => model({ category: "Bug", reason: "r", sentiment: "Negative", priority, summary: "s" });
const evaluation = model({ kbStatus: "covered", relevantSection: "Crash", coverageReason: "c", supportedSteps: ["Reinstall"], unsupportedParts: [], escalationRequired: false, customerResponse: "Hello Ada" });
const validated = [{ json: { valid: true, errors: [], ...form[0].json } }];
const kbOk = [{ json: { articleCount: 2, kbUnavailable: false } }];
const ctx = (priority: string) => ({ nodes: { "Validate submission": validated, "Message a model": classification(priority), "Select active articles": kbOk, "Message a model1": evaluation } });
// What a Gemini node returns when it fails with "continue on error".
const geminiError = [{ json: { error: "503 The model is overloaded" } }];

test("N articles in -> exactly ONE item out of 'Select active articles' (no fan-out)", () => {
  const out = run("select-active-articles.js", { input: [article({ _id: "1" }), article({ _id: "2" }), article({ _id: "3" })] });
  assert.equal(out.length, 1);
  assert.equal(out[0].json.articleCount, 3);
});

test("inactive articles are filtered out; metadata is preserved for the model", () => {
  const out = run("select-active-articles.js", {
    input: [article({ _id: "keep", title: "Login help", category: "Auth", keywords: ["login", "password"], content: "Reset it" }), article({ _id: "drop", title: "Old", active: false }), article({ _id: "str", title: "StringTrue", active: "true" }), article({ _id: "missing", title: "NoActive", active: undefined })],
  });
  const kb = out[0].json.knowledgeBase as string;
  assert.equal(out[0].json.articleCount, 2);
  assert.match(kb, /ID: keep/);
  assert.match(kb, /Title: Login help/);
  assert.match(kb, /Category: Auth/);
  assert.match(kb, /Keywords: login, password/);
  assert.doesNotMatch(kb, /Old|NoActive/);
});

test("zero active articles still yields one item (so a ticket is still created and escalated by the model)", () => {
  for (const input of [[], [article({ active: false })], [{ json: {} }]]) {
    const out = run("select-active-articles.js", { input });
    assert.equal(out.length, 1);
    assert.equal(out[0].json.articleCount, 0);
    assert.match(out[0].json.knowledgeBase, /NO ACTIVE/);
  }
  assert.equal(byName("Get many documents").alwaysOutputData, true, "an empty collection must still reach the Code node");
});

test("'Build ticket' creates exactly ONE ticket per submission", () => {
  const out = run("build-ticket.js", ctx("Medium"));
  assert.equal(out.length, 1);
  assert.equal(out[0].json.customerEmail, "ada@example.com");
  assert.equal(out[0].json.aiResponse, out[0].json.customerResponse);
  assert.deepEqual(out[0].json.supportedSteps, ["Reinstall"]);
});

test("routing fields are decided once: High/Urgent escalate; Low/Medium do not", () => {
  for (const p of ["High", "Urgent"]) {
    const t = run("build-ticket.js", ctx(p))[0].json;
    assert.equal(t.escalationStatus, "required");
    assert.ok(t.escalatedAt);
  }
  for (const p of ["Low", "Medium"]) {
    const t = run("build-ticket.js", ctx(p))[0].json;
    assert.equal(t.escalationStatus, "not_required");
    assert.equal("escalatedAt" in t, false);
  }
});

test("'Build ticket' tolerates a Markdown fence", () => {
  const fenced = { nodes: { ...ctx("Low").nodes, "Message a model": model("```json\n" + JSON.stringify({ category: "Bug", reason: "r", sentiment: "Neutral", priority: "Low", summary: "s" }) + "\n```") } };
  assert.equal(run("build-ticket.js", fenced)[0].json.priority, "Low");
});

/* ---- failure handling: a submission is never lost, nothing is invented ---- */

const build = (nodes: Record<string, Item[]>) => {
  const out = run("build-ticket.js", { nodes: { ...ctx("Low").nodes, ...nodes } });
  assert.equal(out.length, 1, "exactly one ticket");
  return out[0].json;
};
const assertManualWithOriginal = (t: Record<string, any>) => {
  assert.equal(t.customerName, "Ada");
  assert.equal(t.customerEmail, "ada@example.com");
  assert.equal(t.message, "App crashes");
  assert.equal(t.escalationStatus, "required");
  assert.ok(t.escalatedAt);
  assert.equal(approvalRequired(t), true);
  assert.equal("customerResponse" in t, false, "no customer response is invented");
  assert.equal("aiResponse" in t, false);
};

test("classification failure (Gemini error, garbage, empty) still creates ONE manual-handling ticket with no invented fields", () => {
  for (const bad of [geminiError, model("not json"), model(""), model("[1,2]"), [{ json: {} }]]) {
    const t = build({ "Message a model": bad });
    assertManualWithOriginal(t);
    assert.match(t.intakeIssue, /^classification_(failed|invalid)$/);
    for (const f of ["priority", "category", "sentiment", "summary", "reason"]) assert.equal(f in t, false, `${f} must not be invented`);
  }
});

test("evaluation failure keeps the real classification, stores no response, requires manual handling", () => {
  for (const bad of [geminiError, model("not json"), model({ kbStatus: "covered" }), model({ kbStatus: "maybe", escalationRequired: false, customerResponse: "x" })]) {
    const t = build({ "Message a model": classification("Low"), "Message a model1": bad });
    assertManualWithOriginal(t);
    assert.match(t.intakeIssue, /^evaluation_(failed|invalid)$/);
    assert.equal(t.priority, "Low");
    assert.equal(t.category, "Bug");
    assert.equal(t.escalationRequired, true);
    assert.equal("kbStatus" in t, false, "an evaluation that never happened is not recorded as one");
  }
});

test("both models failing and a failed knowledge-base read still produce one ticket", () => {
  const t = build({ "Message a model": geminiError, "Message a model1": geminiError, "Select active articles": [{ json: { articleCount: 0, kbUnavailable: true } }] });
  assertManualWithOriginal(t);
  assert.equal(t.intakeIssue, "classification_failed");
  const kbDown = build({ "Select active articles": [{ json: { articleCount: 0, kbUnavailable: true } }] });
  assert.equal(kbDown.intakeIssue, "knowledge_base_unavailable");
  assert.equal(kbDown.kbStatus, "not_covered");
  assert.equal("customerResponse" in kbDown, false);
});

test("a failed Firestore read is flagged, not mistaken for an empty knowledge base", () => {
  const out = run("select-active-articles.js", { input: [{ json: { error: "permission denied" } }] })[0].json;
  assert.equal(out.kbUnavailable, true);
  assert.equal(out.articleCount, 0);
  const empty = run("select-active-articles.js", { input: [{ json: {} }] })[0].json;
  assert.equal(empty.kbUnavailable, false);
});

/* ---- priority validation and the shared approval rule ---- */

test("priority and category are normalised; anything unrecognised is NOT guessed and needs a human", () => {
  const ok = build({ "Message a model": model({ category: " feature  request ", reason: "r", sentiment: "NEGATIVE", priority: " medium ", summary: "s" }) });
  assert.equal(ok.priority, "Medium");
  assert.equal(ok.category, "Feature Request");
  assert.equal(ok.sentiment, "Negative");
  assert.equal(ok.escalationStatus, "not_required");
  for (const priority of ["Critical", "normal", "moderate", "P1", "", null, 3, "Highest"]) {
    const t = build({ "Message a model": model({ category: "Bug", reason: "r", sentiment: "Neutral", priority, summary: "s" }) });
    assert.equal(t.escalationStatus, "required", `priority ${JSON.stringify(priority)}`);
    assert.equal("priority" in t, false, "an invalid priority is not stored");
    assert.equal(t.intakeIssue, "classification_invalid");
    assert.equal(approvalRequired(t), true);
  }
  const badCategory = build({ "Message a model": model({ category: "Billing", reason: "r", sentiment: "Neutral", priority: "Low", summary: "s" }) });
  assert.equal("category" in badCategory, false);
  assert.equal(badCategory.escalationStatus, "required");
  assert.equal(badCategory.priority, "Low");
});

test("lower-case high/urgent are still escalated (the old exact-match routing let them through)", () => {
  for (const p of ["high", "URGENT", " High "]) {
    const t = build({ "Message a model": classification(p) });
    assert.equal(t.escalationStatus, "required");
    assert.equal(t.priority, p.trim()[0].toUpperCase() + p.trim().slice(1).toLowerCase());
  }
});

test("knowledge-base coverage overrides Low/Medium automatic handling", () => {
  const ev = (o: Record<string, unknown>) => model({ kbStatus: "covered", relevantSection: "S", coverageReason: "c", supportedSteps: ["Step"], unsupportedParts: [], escalationRequired: false, customerResponse: "Hello Ada", ...o });
  // no active articles at all: not_covered, the model's text is thrown away
  const none = build({ "Select active articles": [{ json: { articleCount: 0, kbUnavailable: false } }], "Message a model1": ev({}) });
  assert.equal(none.kbStatus, "not_covered");
  assert.equal(none.escalationRequired, true);
  assert.deepEqual(none.supportedSteps, []);
  assert.equal("customerResponse" in none, false, "no invented automatic answer");
  assert.equal(none.escalationStatus, "required");
  assert.equal("intakeIssue" in none, false, "an empty knowledge base is not a failure");
  // model says not_covered but (wrongly) lists steps and escalationRequired false: enforced
  const nc = build({ "Message a model1": ev({ kbStatus: "not_covered", escalationRequired: false, supportedSteps: ["Invented"] }) });
  assert.deepEqual(nc.supportedSteps, []);
  assert.equal(nc.escalationRequired, true);
  assert.equal(nc.escalationStatus, "required");
  // escalationRequired true overrides a covered Low ticket
  assert.equal(build({ "Message a model1": ev({ escalationRequired: true }) }).escalationStatus, "required");
  // only the fully-supported Low/Medium case is automatic
  const auto = build({ "Message a model1": ev({}) });
  assert.equal(auto.escalationStatus, "not_required");
  assert.equal("escalatedAt" in auto, false);
  assert.equal(auto.customerResponse, "Hello Ada");
  // partially covered, nothing left to investigate: allowed
  assert.equal(build({ "Message a model1": ev({ kbStatus: "partially_covered" }) }).escalationStatus, "not_required");
  // High/Urgent always need a human, even when fully covered
  for (const p of ["High", "Urgent"]) assert.equal(build({ "Message a model": classification(p), "Message a model1": ev({}) }).escalationStatus, "required");
});

test("n8n routing and the dashboard approval rule agree on every combination", () => {
  const priorities = ["Low", "Medium", "High", "Urgent", "Critical", null];
  const evals: [string, any][] = [
    ["covered", { kbStatus: "covered", relevantSection: "S", coverageReason: "c", supportedSteps: ["a"], unsupportedParts: [], escalationRequired: false, customerResponse: "Hi" }],
    ["covered+escalate", { kbStatus: "covered", relevantSection: "S", coverageReason: "c", supportedSteps: ["a"], unsupportedParts: [], escalationRequired: true, customerResponse: "Hi" }],
    ["not_covered", { kbStatus: "not_covered", relevantSection: null, coverageReason: "c", supportedSteps: [], unsupportedParts: ["x"], escalationRequired: true, customerResponse: "Hi" }],
    ["garbage", "nope"],
  ];
  for (const p of priorities) for (const [label, e] of evals) for (const articleCount of [0, 3]) {
    const t = build({
      "Message a model": p === null ? geminiError : classification(p as string),
      "Message a model1": model(e),
      "Select active articles": [{ json: { articleCount, kbUnavailable: false } }],
    });
    const stored = serializeTicket("t", t);
    assert.equal(approvalRequired(stored), t.escalationStatus === "required", `priority=${p} eval=${label} articles=${articleCount}`);
  }
});

test("dashboard rule: only Low/Medium without contradicting flags is automatic; no priority aliases", () => {
  assert.equal(approvalRequired({ priority: "Low" }), false);
  assert.equal(approvalRequired({ priority: "medium", kbStatus: "covered", escalationRequired: false }), false);
  assert.equal(approvalRequired({ priority: "Low", kbStatus: "not_covered" }), true);
  assert.equal(approvalRequired({ priority: "Low", escalationRequired: true }), true);
  assert.equal(approvalRequired({ priority: "Low", intakeIssue: "evaluation_failed" }), true);
  for (const p of ["High", "Urgent", "normal", "moderate", "critical", "", null, undefined]) assert.equal(approvalRequired({ priority: p }), true, String(p));
});

test("graph: single linear path, ONE Firestore create, no upsert, every connection resolves", () => {
  const creates = nodes.filter((n) => n.type.includes("Firestore") && n.parameters.operation === "create");
  const upserts = nodes.filter((n) => n.parameters.operation === "upsert");
  // One ticket create (support_tickets) plus the rate limiter's slot claim (rate_limits, tiny hashed documents).
  assert.deepEqual(creates.map((n) => `${n.name}:${n.parameters.collection}`).sort(), ["Claim slot:rate_limits", "Create a document:support_tickets"]);
  assert.equal(upserts.length, 0);
  const names = new Set(nodes.map((n) => n.name));
  for (const [from, c] of Object.entries<any>(wf.connections)) {
    assert.ok(names.has(from));
    for (const branch of c.main) for (const to of branch) assert.ok(names.has(to.node), `${from} -> ${to.node}`);
  }
  // Only these nodes fan out: the validity gate, the escalation split into the two notification emails,
  // and the failure handling added for reliability (error outputs of Create/Gmail, duplicate/conflict decisions).
  // The happy path itself stays linear; see tests/intake-reliability.test.ts for the failure branches.
  const fanOut = Object.entries<any>(wf.connections).filter(([, c]) => c.main.length > 1 || c.main[0].length > 1);
  assert.deepEqual(fanOut.map(([n]) => n).sort(), [
    "Claim granted?",
    "Claim next slot?",
    "Claim refused?",
    "Claim slot",
    "Create a document",
    "If",
    "Is duplicate submission",
    "Is our own earlier attempt",
    "Is submission valid",
    "Is write conflict",
    "Send a message",
    "Send a message1",
  ]);
  assert.deepEqual(wf.connections.If.main.map((b: any[]) => b[0].node), ["Send a message", "Send a message1"]);
  assert.equal(wf.active, false, "must not auto-activate on import");
});

test("no expression refers to a node that no longer exists, and the old update-key bug is gone", () => {
  const names = new Set(nodes.map((n) => n.name));
  const text = JSON.stringify(wf);
  for (const m of text.matchAll(/\$\('([^']+)'\)/g)) assert.ok(names.has(m[1]), `refers to missing node ${m[1]}`);
  assert.doesNotMatch(text, /updateKey/);
  assert.match(byName("Create a document").parameters.columns, /escalationStatus.*reviewStatus/);
});

test("code embedded in the JSON is identical to n8n/code/*.js (no drift)", () => {
  assert.equal(byName("Select active articles").parameters.jsCode, read("code/select-active-articles.js"));
  assert.equal(byName("Build ticket").parameters.jsCode, read("code/build-ticket.js"));
  assert.equal(byName("Prepare email fields").parameters.jsCode, read("code/prepare-email.js"));
});

test("every $json.safe.* the email templates use is produced by 'Prepare email fields', and HTML is escaped", () => {
  const ticket = { ...run("build-ticket.js", ctx("High"))[0].json, customerName: '<script>alert(1)</script>Ada\nBcc: x@evil.com', message: "<img src=x onerror=1>", supportedSteps: ["<b>step</b>"] };
  const safe = run("prepare-email.js", { input: [{ json: ticket }] })[0].json.safe;
  const used = new Set<string>();
  for (const n of ["Send a message", "Send a message1"]) {
    const p = byName(n).parameters;
    for (const m of JSON.stringify([p.message, p.subject]).matchAll(/\$json\.safe\.(\w+)/g)) used.add(m[1]);
  }
  assert.ok(used.size > 5);
  for (const k of used) assert.ok(k in safe, `safe.${k} missing`);
  assert.doesNotMatch(safe.customerName, /<script>/);
  assert.match(safe.message, /&lt;img/);
  assert.match(safe.stepsHtml, /&lt;b&gt;step/);
  assert.doesNotMatch(safe.subjectName, /[\r\n]/);
});

test("the workflow file holds no personal email address, instance ID, credential ID or webhook ID", () => {
  const text = JSON.stringify(wf);
  assert.doesNotMatch(text, /@gmail\.com|instanceId|webhookId/);
  for (const n of nodes) for (const c of Object.values<any>(n.credentials ?? {})) assert.equal("id" in c, false);
});


/* ---- public intake validation (phase 4B) ---- */

const NAME = "Your Name", EMAIL = "Your Email", MSG = "What is it you would like us to fix ?";
const submit = (o: Record<string, unknown>) => run("validate-submission.js", { nodes: { "Form Trigger": [{ json: o }] } });
const good: Record<string, string> = { [NAME]: "Ada Lovelace", [EMAIL]: "ada@example.com", [MSG]: "The app crashes when I upload a photo." };
const rejected = (o: Record<string, unknown>, field: string, code?: string) => {
  const out = submit(o);
  assert.equal(out.length, 1);
  assert.equal(out[0].json.valid, false);
  const e = out[0].json.errors.find((x: any) => x.field === field);
  assert.ok(e, `expected an error on ${field}, got ${JSON.stringify(out[0].json.errors)}`);
  if (code) assert.equal(e.code, code);
  assert.deepEqual(Object.keys(out[0].json).sort(), ["errors", "valid"], "a rejected submission carries no submitted text forward");
};

test("valid submission passes and comes out trimmed, under the same field labels", () => {
  const out = submit({ [NAME]: "  Ada   Lovelace ", [EMAIL]: " Ada@Example.com ", [MSG]: "  line one\r\nline two  " });
  assert.equal(out[0].json.valid, true);
  assert.equal(out[0].json[NAME], "Ada Lovelace");
  assert.equal(out[0].json[EMAIL], "Ada@Example.com");
  assert.equal(out[0].json[MSG], "line one\nline two");
  assert.equal(submit(good)[0].json.valid, true);
});

test("missing or blank name, email and message are rejected (each reported)", () => {
  const key: Record<string, string> = { [NAME]: "name", [EMAIL]: "email", [MSG]: "message" };
  for (const f of [NAME, EMAIL, MSG]) {
    const without = { ...good };
    delete without[f];
    rejected(without, key[f], "missing");
    rejected({ ...good, [f]: "" }, key[f], "empty");
  }
  const all = submit({});
  assert.deepEqual(all[0].json.errors.map((e: any) => e.field).sort(), ["email", "message", "name"]);
});

test("whitespace-only (spaces, tabs, line breaks, NBSP) name and message are rejected", () => {
  for (const blank of ["   ", "\t\t", "\n\r\n \n", "\u00a0\u00a0"]) {
    rejected({ ...good, [MSG]: blank }, "message", "empty");
    rejected({ ...good, [NAME]: blank }, "name");
  }
});

test("malformed email addresses are rejected, including header-injection attempts", () => {
  for (const bad of ["plainaddress", "@example.com", "ada@", "ada@example", "ada@@example.com", "a da@example.com", "ada@exa mple.com", "ada@example..com", ".ada@example.com", "ada.@example.com", "ada@.example.com", "ada@example.com.", "ada@-example.com", "<ada@example.com>", "ada@example.com, eve@example.com", "ada@example.com;eve@example.com", "\"ada\"@example.com", "ada@example.com\nBcc: eve@example.com", "ada@example.com\r\nSubject: hi", `${"a".repeat(65)}@example.com`, `ada@${"b".repeat(250)}.com`]) {
    const out = submit({ ...good, [EMAIL]: bad });
    assert.equal(out[0].json.valid, false, JSON.stringify(bad));
    assert.ok(out[0].json.errors.some((e: any) => e.field === "email"), JSON.stringify(bad));
  }
  for (const ok of ["ada@example.com", "ada.lovelace+tag@sub.example.co.uk", "a_b-c@ex-ample.org"]) assert.equal(submit({ ...good, [EMAIL]: ok })[0].json.valid, true, ok);
});

test("message length: exactly the maximum is accepted, one over is rejected", () => {
  assert.equal(submit({ ...good, [MSG]: "x".repeat(5000) })[0].json.valid, true);
  rejected({ ...good, [MSG]: "x".repeat(5001) }, "message", "too_long");
  rejected({ ...good, [MSG]: "y".repeat(200_000) }, "message", "too_long");
  rejected({ ...good, [NAME]: "n".repeat(101) }, "name", "too_long");
  // Trimming happens before the limit: padding doesn't count against the customer.
  assert.equal(submit({ ...good, [MSG]: " ".repeat(3000) + "x".repeat(5000) + " ".repeat(3000) })[0].json.valid, true);
});

test("non-text values (a hand-crafted POST) and control characters in name/email are rejected", () => {
  for (const v of [123, true, ["a"], { a: 1 }]) {
    rejected({ ...good, [MSG]: v }, "message", "not_text");
    rejected({ ...good, [NAME]: v }, "name", "not_text");
    rejected({ ...good, [EMAIL]: v }, "email", "not_text");
  }
  rejected({ ...good, [NAME]: "Ada\nBcc: eve@example.com" }, "name", "invalid_characters");
  rejected({ ...good, [NAME]: "Ada\u0000" }, "name", "invalid_characters");
  assert.equal(submit({ ...good, [MSG]: "a\u0000b\u0007c" })[0].json[MSG], "abc", "control characters are stripped from a message");
});

test("graph: nothing that calls Gemini, Firestore or Gmail is reachable except through the 'valid' branch", () => {
  assert.deepEqual(wf.connections["Form Trigger"].main[0].map((c: any) => c.node), ["Rate limit settings"]);
  assert.deepEqual(wf.connections["Rate limit settings"].main[0].map((c: any) => c.node), ["Validate submission"]);
  assert.deepEqual(wf.connections["Validate submission"].main[0].map((c: any) => c.node), ["Is submission valid"]);
  const gate = wf.connections["Is submission valid"].main.map((b: any[]) => b.map((c) => c.node));
  assert.deepEqual(gate, [["Prepare rate limit"], ["Rejected submission (stop)"]]);
  // The rejected branch only answers the visitor (Reply -> Respond) and ends.
  assert.deepEqual(wf.connections["Rejected submission (stop)"].main[0].map((c: any) => c.node), ["Reply: invalid"]);
  assert.deepEqual(wf.connections["Reply: invalid"].main[0].map((c: any) => c.node), ["Respond to form (rejected)"]);
  assert.equal(wf.connections["Respond to form (rejected)"], undefined, "the rejected branch ends there");
  // Reachable from the rejected branch: nothing.
  const external = (n: Node) => /gemini|firestore|gmail/i.test(n.type);
  const reach = (start: string) => {
    const seen = new Set<string>(), stack = [start];
    while (stack.length) { const c = stack.pop()!; if (seen.has(c)) continue; seen.add(c); for (const b of wf.connections[c]?.main ?? []) for (const t of b) stack.push(t.node); }
    return seen;
  };
  assert.equal([...reach("Rejected submission (stop)")].some((n) => external(byName(n))), false);
  // Every external-calling node is only reachable through the gate's valid output.
  const withoutGate = (() => {
    const seen = new Set<string>(), stack = ["Form Trigger"];
    while (stack.length) {
      const c = stack.pop()!; if (seen.has(c)) continue; seen.add(c);
      const branches = wf.connections[c]?.main ?? [];
      branches.forEach((b: any[], i: number) => { if (c === "Is submission valid" && i === 0) return; for (const t of b) stack.push(t.node); });
    }
    return seen;
  })();
  assert.deepEqual([...withoutGate].filter((n) => external(byName(n))), []);
  assert.deepEqual(byName("Validate submission").parameters.jsCode, read("code/validate-submission.js"));
});

test("downstream nodes read the validated values, never the raw form", () => {
  // Only the validator reads the raw form's values; 'Prepare rate limit' reads its request HEADERS (the IP can only come from there).
  const readers = wf.nodes.filter((n: Node) => /\$\('Form Trigger'\)/.test(JSON.stringify(n.parameters))).map((n: Node) => n.name).sort();
  assert.deepEqual(readers, ["Prepare rate limit", "Validate submission"]);
  assert.match(byName("Prepare rate limit").parameters.jsCode, /form\.headers/);
  assert.doesNotMatch(byName("Prepare rate limit").parameters.jsCode, /form\[|form\.(?!headers)/);
  const form = byName("Form Trigger").parameters.formFields.values;
  assert.ok(form.every((f: any) => f.requiredField === true));
  assert.equal(wf.active, false);
});
