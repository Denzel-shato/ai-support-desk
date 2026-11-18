/* eslint-disable @typescript-eslint/no-explicit-any -- tests read untyped workflow JSON */
// Reliability tests for the PROPOSED intake workflow (n8n/ai-support-desk-automation.json):
// retries, ticket IDs, duplicate/failure branches and notification handling.
// Code-node sources run in plain Node with a stand-in for n8n's `$` helpers; the JSON is checked
// structurally. This does NOT run n8n, Gemini, Firestore or Gmail.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../n8n/${p}`, import.meta.url), "utf8");
const wf = JSON.parse(read("ai-support-desk-automation.json"));
type Node = { name: string; type: string; parameters: Record<string, any>; onError?: string; retryOnFail?: boolean; maxTries?: number; waitBetweenTries?: number; alwaysOutputData?: boolean };
const nodes: Node[] = wf.nodes;
const byName = (n: string) => nodes.find((x) => x.name === n)!;

// ---- Phase A ------------------------------------------------------------

test("both Gemini nodes retry transient errors (3 tries, waiting between) and still fall back on a final failure", () => {
  for (const name of ["Message a model", "Message a model1"]) {
    const n = byName(name);
    assert.equal(n.retryOnFail, true, name);
    assert.equal(n.maxTries, 3, name);
    assert.ok(n.waitBetweenTries! >= 1000 && n.waitBetweenTries! <= 5000, `${name}: n8n allows 0-5000 ms`);
    assert.equal(n.onError, "continueRegularOutput", `${name} must keep the manual-handling fallback`);
  }
});

test("customer and staff emails do not carry n8n's attribution line", () => {
  for (const name of ["Send a message", "Send a message1"]) assert.equal(byName(name).parameters.options?.appendAttribution, false, name);
});

test("escalation subject never prints a blank or unvalidated priority", () => {
  assert.match(String(byName("Send a message").parameters.subject), /\{\{ \$json\.safe\.subjectPriority \}\}/);
  const run = (priority: unknown) =>
    new Function("$", "$input", read("code/prepare-email.js"))(null, { first: () => ({ json: { customerName: "A", priority } }) })[0].json.safe.subjectPriority;
  assert.equal(run("High"), "High");
  assert.equal(run(undefined), "Unknown");
  assert.equal(run(null), "Unknown");
  assert.equal(run("Critical\nBcc: x@y.z"), "Unknown");
});

test("the form's confirmation text does not claim the request was recorded or saved", () => {
  const text: string = wf.nodes[0].parameters.options.respondWithOptions.values.formSubmittedText;
  assert.equal(byName("Form Trigger").type, "n8n-nodes-base.formTrigger");
  assert.doesNotMatch(text, /recorded|saved|created|ticket/i);
  assert.match(text, /submitted/i);
});

// ---- Phase B: deterministic ticket ID ----------------------------------

import { createHash } from "node:crypto";
type Item = { json: Record<string, any> };
const form = { "Your Name": "Ada", "Your Email": "ada@example.com", "What is it you would like us to fix ?": "App crashes" };
const model = (obj: unknown) => [{ json: { content: { parts: [{ text: JSON.stringify(obj) }] } } }];
const classification = model({ category: "Bug", reason: "r", sentiment: "Negative", priority: "Low", summary: "s" });
const evaluation = model({ kbStatus: "covered", relevantSection: "Crash", coverageReason: "c", supportedSteps: ["Reinstall"], unsupportedParts: [], escalationRequired: false, customerResponse: "Hello Ada" });

function build(f: Record<string, string> = form, opts: { nowMs?: number; executionId?: string | null } = {}): Record<string, any> {
  const nodesData: Record<string, Item[]> = {
    "Validate submission": [{ json: { valid: true, errors: [], ...f } }],
    "Message a model": classification,
    "Select active articles": [{ json: { articleCount: 2, kbUnavailable: false } }],
    "Message a model1": evaluation,
  };
  const $ = (name: string) => {
    const items = nodesData[name];
    if (!items) throw new Error(`no data for ${name}`);
    return { first: () => items[0], all: () => items };
  };
  const nowMs = opts.nowMs ?? Date.parse("2026-11-18T10:15:00Z");
  class FakeDate extends Date {
    constructor(value?: any) {
      super(value === undefined ? nowMs : value);
    }
  }
  const execution = opts.executionId === null ? undefined : { id: opts.executionId ?? "exec-1" };
  return new Function("$", "$input", "$execution", "Date", read("code/build-ticket.js"))($, { first: () => nodesData["Message a model"][0] }, execution, FakeDate)[0].json;
}

test("the in-workflow SHA-256 matches Node's crypto (empty, short, unicode, multi-block)", () => {
  const src = read("code/build-ticket.js").match(/function sha256Hex[\s\S]*?\n}\n/)![0];
  const sha = new Function(`${src}; return sha256Hex;`)() as (s: string) => string;
  for (const s of ["", "abc", "ada@example.com", "naïve café 日本語 😀", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000), "line\nbreak"]) {
    assert.equal(sha(s), createHash("sha256").update(s, "utf8").digest("hex"), JSON.stringify(s.slice(0, 20)));
  }
});

test("the same submission in the same hour gets the same ID; changes to it get a different one", () => {
  const a = build();
  assert.match(a.ticketId, /^tk_[0-9a-f]{32}$/);
  assert.equal(build().ticketId, a.ticketId, "double submit");
  assert.equal(build({ ...form, "Your Name": "Someone Else" }).ticketId, a.ticketId, "name is not part of the identity");
  assert.equal(build({ ...form, "Your Email": " ADA@Example.COM " }).ticketId, a.ticketId, "email case/whitespace ignored");
  assert.equal(build({ ...form, "What is it you would like us to fix ?": "App   crashes\n" }).ticketId, a.ticketId, "whitespace in the message ignored");
  assert.notEqual(build({ ...form, "What is it you would like us to fix ?": "App crashes again" }).ticketId, a.ticketId);
  assert.notEqual(build({ ...form, "Your Email": "other@example.com" }).ticketId, a.ticketId);
});

test("the ID changes with the clock hour, so a later genuine repeat is a new ticket", () => {
  const h1 = build(form, { nowMs: Date.parse("2026-11-18T10:59:59Z") }).ticketId;
  const h1b = build(form, { nowMs: Date.parse("2026-11-18T10:00:00Z") }).ticketId;
  const h2 = build(form, { nowMs: Date.parse("2026-11-18T11:00:00Z") }).ticketId;
  assert.equal(h1, h1b);
  assert.notEqual(h1, h2);
});

test("the ID is a valid Firestore document ID and the Create node uses it", () => {
  const id = build().ticketId as string;
  assert.ok(id.length > 0 && !id.includes("/") && !/^__.*__$/.test(id));
  const create = byName("Create a document");
  assert.equal(create.parameters.operation, "create");
  assert.equal(create.parameters.documentId, "={{ $json.ticketId }}");
  assert.ok(String(create.parameters.columns).split(",").includes("intakeExecutionId"));
  assert.ok(!String(create.parameters.columns).split(",").includes("ticketId"), "the ID is the document name, not a stored column");
});

test("the run's execution ID is recorded; a missing $execution never makes Build ticket throw", () => {
  assert.equal(build(form, { executionId: "exec-42" }).intakeExecutionId, "exec-42");
  const t = build(form, { executionId: null });
  assert.equal("intakeExecutionId" in t, false);
  assert.match(t.ticketId, /^tk_/);
  assert.equal(t.customerEmail, "ada@example.com");
});

test("existing ticket fields are unchanged by the ID work (Low covered still automatic)", () => {
  const t = build();
  assert.equal(t.escalationStatus, "not_required");
  assert.equal(t.status, "pending_review");
  assert.equal(t.reviewStatus, "awaiting_review");
  assert.equal(t.priority, "Low");
});

test("Prepare email fields keeps the reference ID when the Create node did not supply _id", () => {
  const run = (input: Record<string, any>) =>
    new Function("$", "$input", read("code/prepare-email.js"))((n: string) => ({ first: () => ({ json: n === "Build ticket" ? { ticketId: "tk_abc" } : {} }) }), { first: () => ({ json: input }) })[0].json;
  assert.equal(run({ customerName: "A" })._id, "tk_abc");
  assert.equal(run({ customerName: "A", _id: "fromCreate" })._id, "fromCreate");
});
