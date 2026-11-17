/* eslint-disable @typescript-eslint/no-explicit-any -- tests read untyped workflow JSON */
// Tests for the PROPOSED send-response workflow (n8n/ai-support-desk-send-response.json).
// They run the Code-node sources in plain Node with a stand-in for n8n's `$` helpers and
// check the wiring of the JSON, plus the contract with the dashboard's payload builder and
// response interpreter. They do NOT run n8n, Gmail or Firestore, so they cannot prove the
// workflow sends email when imported and activated.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { buildWebhookPayload, buildFollowUpPayload } from "@/lib/n8n-send-response";
import { interpretWebhookResponse } from "@/lib/response-workflow";

const read = (p: string) => readFileSync(new URL(`../n8n/${p}`, import.meta.url), "utf8");
const wf = JSON.parse(read("ai-support-desk-send-response.json"));
type Node = { name: string; type: string; typeVersion: number; parameters: Record<string, any>; onError?: string; alwaysOutputData?: boolean; credentials?: Record<string, any> };
const nodes: Node[] = wf.nodes;
const byName = (n: string) => nodes.find((x) => x.name === n)!;
type Item = { json: Record<string, any> };

function run(file: string, ctx: { input?: Item[]; nodes?: Record<string, Item[]> }): Item[] {
  const input = ctx.input ?? [];
  const $ = (name: string) => {
    const items = ctx.nodes?.[name];
    if (!items) throw new Error(`no data for node ${name}`);
    return { first: () => items[0], all: () => items };
  };
  const $input = { all: () => input, first: () => input[0] };
  return new Function("$", "$input", read(`code/${file}`))($, $input);
}

const KEY = "6f1c2e0e-1111-4222-8333-444455556666";
const goodBody = {
  ticketId: "abc123",
  messageType: "initial_response",
  idempotencyKey: KEY,
  attempt: 1,
  customerName: "Ann",
  customerEmail: "ann@example.invalid",
  subject: "Re: Your support request",
  messageBody: "Hi Ann, we fixed it.",
  finalResponse: "Hi Ann, we fixed it.",
  requestedAt: "2026-11-17T10:00:00Z",
  source: "ai-support-desk",
};
const validate = (body: unknown) => run("send-validate-payload.js", { input: [{ json: { body } }] })[0].json;
const P = (over: Record<string, unknown> = {}) => ({ json: { ok: true, p: { ticketId: "abc123", key: KEY, messageType: "initial_response", customerEmail: "ann@example.invalid", subject: "S", messageBody: "Hi Ann, we fixed it.", attempt: 1, ...over } } });
const checkTicket = (ticket: Record<string, any>, p = P()) => run("send-check-ticket.js", { input: [{ json: ticket }], nodes: { "Validate payload": [p] } })[0].json;
const approved = { _id: "abc123", customerEmail: "Ann@Example.invalid", reviewStatus: "approved", finalResponse: "Hi Ann, we fixed it." };
const decide = (sent: Record<string, any>, claim: Record<string, any>) => run("send-decide-duplicate.js", { nodes: { "Validate payload": [P()], "Get sent record": [{ json: sent }], "Get claim record": [{ json: claim }] } })[0].json;

// ---- wiring -------------------------------------------------------------

test("workflow is inactive, carries no credential values, and uses credentials by name only", () => {
  assert.equal(wf.active, false);
  const text = read("ai-support-desk-send-response.json");
  assert.doesNotMatch(text, /@(gmail|outlook|yahoo)\.com|private_key|BEGIN [A-Z ]*KEY|client_secret/i);
  for (const n of nodes) for (const c of Object.values(n.credentials ?? {}) as any[]) assert.ok(typeof c.name === "string" && c.name.length > 0);
});

test("webhook: POST, header-auth, answered by a Respond node", () => {
  const w = byName("Webhook");
  assert.equal(w.parameters.httpMethod, "POST");
  assert.equal(w.parameters.authentication, "headerAuth");
  assert.equal(w.parameters.responseMode, "responseNode");
  assert.ok(w.credentials?.httpHeaderAuth, "header auth credential must be attached by name");
});

// Every path from the Webhook to the Gmail node.
function pathsToGmail(): string[][] {
  const conn = wf.connections as Record<string, { main: { node: string }[][] }>;
  const out: string[][] = [];
  const walk = (name: string, trail: string[]) => {
    if (trail.includes(name)) return;
    const t = [...trail, name];
    if (name === "Send email") return void out.push(t);
    for (const branch of conn[name]?.main ?? []) for (const next of branch) walk(next.node, t);
  };
  walk("Webhook", []);
  return out;
}

test("exactly one Gmail node, reachable only after validation, ticket check, duplicate check and claim", () => {
  assert.equal(nodes.filter((n) => n.type === "n8n-nodes-base.gmail").length, 1);
  const paths = pathsToGmail();
  assert.ok(paths.length > 0);
  for (const p of paths) {
    for (const step of ["Validate payload", "Payload valid", "Check ticket", "Ticket ok", "Decide duplicate", "Can send", "Create claim"]) {
      assert.ok(p.includes(step), `${step} missing on path ${p.join(" > ")}`);
    }
    assert.ok(p.indexOf("Create claim") < p.indexOf("Send email"));
    assert.ok(p.indexOf("Decide duplicate") < p.indexOf("Create claim"));
  }
});

test("Gmail uses plain text from the validated body and never appends n8n attribution", () => {
  const g = byName("Send email");
  assert.equal(g.parameters.emailType, "text");
  assert.equal(g.parameters.options?.appendAttribution, false);
  assert.match(String(g.parameters.sendTo), /Validate payload/);
  assert.match(String(g.parameters.message), /Validate payload/);
  assert.equal(g.onError, "continueErrorOutput");
});

test("Gmail send is the only step that can send mail: no other node type emails", () => {
  const mailTypes = nodes.filter((n) => /gmail|emailSend|smtp|sendGrid|mailgun/i.test(n.type));
  assert.deepEqual(mailTypes.map((n) => n.name), ["Send email"]);
});

test("workflow does not write to tickets and does not touch the intake workflow's collections", () => {
  for (const n of nodes.filter((x) => x.type.includes("Firestore"))) {
    if (n.parameters.operation === "get" && n.parameters.collection === "support_tickets") continue;
    assert.equal(n.parameters.collection, "n8n_send_log", `${n.name} must only write the n8n send log`);
  }
});

test("existing-read nodes still reach the Code node when the document is missing", () => {
  for (const name of ["Get ticket", "Get sent record", "Get claim record"]) assert.equal(byName(name).alwaysOutputData, true, name);
});

test("every terminal branch ends in the Respond node, answering with the decided code and body", () => {
  const r = byName("Respond");
  assert.equal(r.type, "n8n-nodes-base.respondToWebhook");
  assert.match(String(r.parameters.responseBody), /\$json\.body/);
  assert.match(String(r.parameters.options?.responseCode), /\$json\.code/);
  const conn = wf.connections as Record<string, { main: { node: string }[][] }>;
  const sinks = nodes.map((n) => n.name).filter((n) => n !== "Respond" && !(conn[n]?.main ?? []).some((b) => b.length));
  assert.deepEqual(sinks, [], "no dead-end node besides Respond");
});

test("embedded Code nodes are identical to n8n/code/send-*.js", () => {
  const files = readdirSync(new URL("../n8n/code/", import.meta.url)).filter((f) => f.startsWith("send-"));
  const embedded = new Set(nodes.filter((n) => n.type === "n8n-nodes-base.code").map((n) => n.parameters.jsCode));
  assert.equal(files.length, embedded.size);
  for (const f of files) assert.ok(embedded.has(read(`code/${f}`)), `${f} differs from the JSON`);
});

// ---- Validate payload ---------------------------------------------------

test("a payload built by the dashboard passes validation (initial response and follow-up)", () => {
  const claim: any = { idempotencyKey: KEY, attempt: 2, customerName: "Ann", recipient: "ann@example.invalid", finalResponse: "Hello Ann\r\nSecond line", context: {} };
  const initial = validate(buildWebhookPayload("abc123", claim, "2026-11-17T10:00:00Z"));
  assert.equal(initial.ok, true);
  assert.equal(initial.p.messageBody, "Hello Ann\nSecond line");
  assert.equal(initial.p.attempt, 2);
  const fu = validate(buildFollowUpPayload("abc123", { idempotencyKey: KEY, attempt: 1, customerName: null, recipient: "ann@example.invalid", content: "More info" } as any, "2026-11-17T10:00:00Z"));
  assert.equal(fu.ok, true);
  assert.equal(fu.p.messageType, "follow_up");
});

test("invalid payloads are rejected with 400/failed and the text is never echoed", () => {
  const cases: Record<string, unknown>[] = [
    { ...goodBody, ticketId: "" },
    { ...goodBody, ticketId: "../x" },
    { ...goodBody, idempotencyKey: "short" },
    { ...goodBody, messageType: "other" },
    { ...goodBody, customerEmail: "not-an-email" },
    { ...goodBody, customerEmail: "a@b.com, c@d.com" },
    { ...goodBody, customerEmail: "a@b.com\nBcc: x@y.com" },
    { ...goodBody, customerEmail: "Ann <ann@example.com>" },
    { ...goodBody, subject: "Hi\r\nBcc: x@y.com" },
    { ...goodBody, subject: "" },
    { ...goodBody, messageBody: "   ", finalResponse: "   " },
    { ...goodBody, messageBody: "x".repeat(10001), finalResponse: "x".repeat(10001) },
    { ...goodBody, finalResponse: "Different text" },
  ];
  for (const c of cases) {
    const out = validate(c);
    assert.equal(out.ok, false, JSON.stringify(c).slice(0, 80));
    assert.equal(out.code, 400);
    assert.equal(out.body.status, "failed");
    assert.doesNotMatch(JSON.stringify(out.body), /Bcc|Different text|not-an-email/);
  }
  for (const nonObject of [null, undefined, "x", 5, []]) assert.equal(validate(nonObject).ok, false);
});

// ---- Check ticket -------------------------------------------------------

test("ticket check: approved ticket with matching recipient (case-insensitive) and text passes", () => {
  assert.equal(checkTicket(approved).ok, true);
  assert.equal(checkTicket({ ...approved, finalResponse: "  Hi Ann, we fixed it.\r\n" }).ok, true);
});

test("ticket check refuses missing tickets, wrong recipients, unapproved or altered responses", () => {
  assert.equal(checkTicket({}).code, 404);
  assert.equal(checkTicket({ error: "Not found" }).code, 404);
  assert.equal(checkTicket({ error: "503 backend down" }).code, 502);
  assert.equal(checkTicket({ ...approved, customerEmail: "other@example.invalid" }).code, 409);
  assert.equal(checkTicket({ ...approved, reviewStatus: "pending" }).code, 409);
  assert.equal(checkTicket({ ...approved, finalResponse: "Edited after approval" }).code, 409);
  for (const out of [checkTicket({}), checkTicket({ ...approved, reviewStatus: "draft" })]) assert.equal(out.body.status, "failed");
});

test("a follow-up needs the right recipient but not review approval", () => {
  const p = P({ messageType: "follow_up", messageBody: "More info" });
  assert.equal(checkTicket({ _id: "abc123", customerEmail: "ann@example.invalid" }, p).ok, true);
  assert.equal(checkTicket({ _id: "abc123", customerEmail: "other@example.invalid" }, p).code, 409);
});

// ---- Duplicate protection ----------------------------------------------

test("duplicate protection: a recorded send answers sent and sends nothing", () => {
  const out = decide({ status: "sent", sentAt: "2026-11-17T09:00:00.000Z", gmailId: "old" }, {});
  assert.equal(out.ok, false);
  assert.equal(out.body.status, "sent");
  assert.equal(out.body.deduplicated, true);
  assert.equal(out.body.messageId, "old");
});

test("duplicate protection: an unfinished claim answers unknown and sends nothing", () => {
  const out = decide({}, { status: "sending", startedAt: "2026-11-17T09:00:00.000Z" });
  assert.equal(out.ok, false);
  assert.equal(out.body.status, "unknown");
});

test("duplicate protection: unreadable log means unknown, never a send", () => {
  assert.equal(decide({ error: "503 firestore down" }, {}).ok, false);
  assert.equal(decide({}, { error: "503 firestore down" }).body.status, "unknown");
  assert.equal(decide({ error: "Not found" }, { error: "404 not found" }).ok, true, "missing docs are the normal first-send case");
  assert.equal(decide({}, {}).ok, true, "n8n returns an empty item when nothing exists");
});

test("first send builds the claim document from the validated payload", () => {
  const out = decide({}, {});
  assert.deepEqual({ ...out, startedAt: "x" }, { ok: true, status: "sending", startedAt: "x", ticketId: "abc123", messageType: "initial_response", attempt: 1 });
});

// ---- Outcomes -----------------------------------------------------------

const classify = (error: unknown) => run("send-classify-gmail-error.js", { input: [{ json: { error } }] })[0].json;

test("Gmail outcome classification: only a clear rejection is failed and releases the claim", () => {
  const failed = classify({ httpCode: 400, message: "Invalid To header" });
  assert.equal(failed.body.status, "failed");
  assert.equal(failed.releaseClaim, true);
  assert.equal(classify({ message: "invalid_grant" }).body.status, "failed");
  for (const ambiguous of [{ message: "timeout" }, { httpCode: 500, message: "backend error" }, "socket hang up", { message: "ECONNRESET" }]) {
    const out = classify(ambiguous);
    assert.equal(out.body.status, "unknown");
    assert.equal(out.releaseClaim, false, "an ambiguous error keeps the claim so a repeat cannot email twice");
  }
});

test("sent record and response carry the Gmail message id and are marked sent", () => {
  const rec = run("send-prepare-sent-record.js", { input: [{ json: { id: "gm-1" } }], nodes: { "Validate payload": [P()] } })[0].json;
  assert.equal(rec.status, "sent");
  assert.equal(rec.gmailId, "gm-1");
  const res = run("send-sent-response.js", { nodes: { "Prepare sent record": [{ json: rec }] } })[0].json;
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { status: "sent", sentAt: rec.sentAt, messageId: "gm-1" });
});

test("claim failure answers unknown, never sent", () => {
  assert.equal(run("send-claim-failed.js", {})[0].json.body.status, "unknown");
});

// ---- Contract with the dashboard ---------------------------------------

test("every response this workflow can produce is read correctly by the dashboard", () => {
  const sent = run("send-sent-response.js", { nodes: { "Prepare sent record": [{ json: { sentAt: "2026-11-17T10:00:00.000Z", gmailId: "g" } }] } })[0].json;
  assert.equal(interpretWebhookResponse(sent.code, sent.body).kind, "sent");

  const dup = decide({ status: "sent", sentAt: "2026-11-17T09:00:00.000Z", gmailId: "old" }, {});
  assert.equal(interpretWebhookResponse(dup.code, dup.body).kind, "sent");

  const unfinished = decide({}, { status: "sending" });
  assert.equal(interpretWebhookResponse(unfinished.code, unfinished.body).kind, "unknown");

  const rejected = classify({ httpCode: 403 });
  assert.equal(interpretWebhookResponse(rejected.code, rejected.body).kind, "failed", "502 + status failed is authoritative");

  const invalid = validate({ ...goodBody, ticketId: "" });
  assert.equal(interpretWebhookResponse(invalid.code, invalid.body).kind, "failed");

  const missing = checkTicket({});
  assert.equal(interpretWebhookResponse(missing.code, missing.body).kind, "failed");
});
