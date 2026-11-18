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
