/* eslint-disable @typescript-eslint/no-explicit-any -- tests read untyped workflow JSON and dynamic route modules */
// Tests for the PROPOSED n8n workflow (n8n/ai-support-desk-automation.json).
// They run the Code-node sources in plain Node with a stand-in for n8n's `$`
// helpers, and check the wiring of the JSON. They do NOT run n8n, Gemini,
// Firestore or Gmail, so they cannot prove the workflow works when imported.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
const ctx = (priority: string) => ({ nodes: { "Form Trigger": form, "Message a model": classification(priority), "Message a model1": evaluation } });

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

test("'Build ticket' tolerates a Markdown fence and fails loudly on garbage (no silent empty ticket)", () => {
  const fenced = { nodes: { ...ctx("Low").nodes, "Message a model": model("```json\n" + JSON.stringify({ category: "Bug", reason: "r", sentiment: "Neutral", priority: "Low", summary: "s" }) + "\n```") } };
  assert.equal(run("build-ticket.js", fenced)[0].json.priority, "Low");
  const bad = { nodes: { ...ctx("Low").nodes, "Message a model1": model("not json") } };
  assert.throws(() => run("build-ticket.js", bad), /not valid JSON/);
});

test("graph: single linear path, ONE Firestore create, no upsert, every connection resolves", () => {
  const creates = nodes.filter((n) => n.type.includes("Firestore") && n.parameters.operation === "create");
  const upserts = nodes.filter((n) => n.parameters.operation === "upsert");
  assert.equal(creates.length, 1);
  assert.equal(upserts.length, 0);
  const names = new Set(nodes.map((n) => n.name));
  for (const [from, c] of Object.entries<any>(wf.connections)) {
    assert.ok(names.has(from));
    for (const branch of c.main) for (const to of branch) assert.ok(names.has(to.node), `${from} -> ${to.node}`);
  }
  // Only the "If" fans out, and only into the two notification emails.
  const fanOut = Object.entries<any>(wf.connections).filter(([, c]) => c.main.length > 1 || c.main[0].length > 1);
  assert.deepEqual(fanOut.map(([n]) => n), ["If"]);
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
