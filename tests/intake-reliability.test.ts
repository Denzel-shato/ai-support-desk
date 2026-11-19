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
  const settings = new Function("$input", read("code/rate-limit-settings.js"))({ first: () => ({ json: {} }) })[0].json.settings;
  assert.equal(byName("Form Trigger").type, "n8n-nodes-base.formTrigger");
  assert.doesNotMatch(settings.messages.received, /recorded|saved|created|ticket/i);
  assert.match(settings.messages.received, /submitted/i);
});

// ---- Phase B: deterministic ticket ID ----------------------------------

import { createHash } from "node:crypto";
type Item = { json: Record<string, any> };
const form = { "Your Name": "Ada", "Your Email": "ada@example.com", "What is it you would like us to fix ?": "App crashes" };
const model = (obj: unknown) => [{ json: { content: { parts: [{ text: JSON.stringify(obj) }] } } }];
const classification = (priority = "Low") => model({ category: "Bug", reason: "r", sentiment: "Negative", priority, summary: "s" });
// A real article the evaluation can be grounded in: automatic replies are only built from its own sentences.
const KB_ARTICLES = [{ id: "a1", title: "Crash", content: "Reinstall the app from the store.\nClear the app cache before reopening it." }];
const evaluation = model({ kbStatus: "covered", relevantArticleId: "a1", relevantSection: "Crash", coverageReason: "c", supportedSteps: ["Reinstall the app from the store."], unsupportedParts: [], escalationRequired: false, customerResponse: "Hello Ada" });

function build(f: Record<string, string> = form, opts: { nowMs?: number; executionId?: string | null; priority?: string } = {}): Record<string, any> {
  const nodesData: Record<string, Item[]> = {
    "Validate submission": [{ json: { valid: true, errors: [], ...f } }],
    "Message a model": classification(opts.priority),
    "Select active articles": [{ json: { articleCount: 1, kbUnavailable: false, articles: KB_ARTICLES } }],
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

// ---- Phases C and D: failure, duplicate and notification handling --------

const conn = wf.connections as Record<string, { main: { node: string }[][] }>;
const targets = (n: string, port?: number) => (conn[n]?.main ?? []).flatMap((b, i) => (port === undefined || port === i ? b.map((c) => c.node) : []));

function codeRun(file: string, ctx: { input?: Record<string, any>; nodes?: Record<string, Item[]>; executed?: string[]; executionId?: string }): Record<string, any> {
  const $ = (name: string) => {
    const items = ctx.nodes?.[name];
    return { first: () => { if (!items) throw new Error(`no data for ${name}`); return items[0]; }, all: () => items ?? [], isExecuted: (ctx.executed ?? []).includes(name) };
  };
  return new Function("$", "$input", "$execution", read(`code/${file}`))($, { first: () => ({ json: ctx.input ?? {} }) }, { id: ctx.executionId ?? "exec-1" })[0].json;
}

test("Create retries, then sends failures to the error output; Gmail nodes retry and have error outputs", () => {
  const c = byName("Create a document");
  assert.equal(c.retryOnFail, true);
  assert.ok(c.maxTries! >= 2);
  assert.equal(c.onError, "continueErrorOutput");
  assert.deepEqual(targets("Create a document", 0), ["Prepare email fields"]);
  assert.deepEqual(targets("Create a document", 1), ["Classify create error"]);
  for (const g of ["Send a message", "Send a message1"]) {
    assert.equal(byName(g).retryOnFail, true, g);
    assert.equal(byName(g).onError, "continueErrorOutput", g);
    assert.deepEqual(targets(g, 1), ["Prepare rescue email"], g);
  }
});

function pathsTo(target: string, from = "Form Trigger"): string[][] {
  const out: string[][] = [];
  const walk = (n: string, trail: string[]) => {
    if (trail.includes(n)) return;
    const t = [...trail, n];
    if (n === target) return void out.push(t);
    for (const next of targets(n)) walk(next, t);
  };
  walk(from, []);
  return out;
}

test("no email is reachable unless the ticket was written (or proven to be this run's own earlier write)", () => {
  for (const mail of ["Send a message", "Send a message1"]) {
    const paths = pathsTo(mail);
    assert.ok(paths.length > 0);
    for (const p of paths) {
      assert.ok(p.includes("Create a document") && p.includes("Prepare email fields"), p.join(" > "));
      const i = p.indexOf("Prepare email fields");
      const direct = p[i - 1] === "Create a document";
      const recovered = p.slice(i - 2, i).join(">") === "Check existing ticket>Is our own earlier attempt";
      assert.ok(direct || recovered, `email reachable by an unexpected route: ${p.join(" > ")}`);
    }
  }
  assert.deepEqual(targets("Duplicate submission (stop)"), [], "a duplicate sends nothing");
  // The ONLY ways into the rescue email: Create failure/unclear conflict, a notification email failing,
  // or the rate limiter being unavailable (fail-closed).
  const into = Object.entries(conn).filter(([, c]) => c.main.some((b) => b.some((x) => x.node === "Prepare rescue email"))).map(([n]) => n).sort();
  assert.deepEqual(into, ["Is duplicate submission", "Is write conflict", "Rescue suppressed?", "Send a message", "Send a message1"]);
});

test("rescue email goes to the same staff inbox as escalations, without n8n attribution", () => {
  const esc = byName("Send a message").parameters.sendTo;
  assert.equal(byName("Send rescue email").parameters.sendTo, esc);
  assert.equal(byName("Send rescue email").parameters.options.appendAttribution, false);
  assert.match(String(byName("Send rescue email").parameters.message), /\$json\.html/);
  assert.deepEqual(targets("Prepare rescue email"), ["Send rescue email"]);
});

test("embedded Code nodes equal n8n/code sources for every node touched by reliability work", () => {
  const pairs: [string, string][] = [["Build ticket", "build-ticket.js"], ["Prepare email fields", "prepare-email.js"], ["Classify create error", "classify-create-error.js"], ["Check existing ticket", "check-existing-ticket.js"], ["Prepare rescue email", "prepare-rescue-email.js"]];
  for (const [n, f] of pairs) assert.equal(byName(n).parameters.jsCode, read(`code/${f}`), n);
});

test("create-error classification: only a real already-exists is a conflict", () => {
  const k = (error: unknown) => codeRun("classify-create-error.js", { input: { error } }).kind;
  assert.equal(k({ message: "Document already exists", httpCode: "409" }), "conflict");
  assert.equal(k("ALREADY_EXISTS: Document already exists: projects/x"), "conflict");
  assert.equal(k({ httpCode: 409 }), "conflict");
  assert.equal(k({ message: "The service is currently unavailable", httpCode: "503" }), "failure");
  assert.equal(k({ message: "Permission denied", httpCode: "403" }), "failure");
  assert.equal(k("timeout"), "failure");
  assert.equal(k({ message: "request id 4091 failed" }), "failure", "a stray 409 inside other text is not a conflict");
  assert.ok(codeRun("classify-create-error.js", { input: { error: "x".repeat(1000) } }).error.length <= 300);
});

// A miniature of the failure paths built from the real Code-node sources. Firestore create is atomic and
// fails when the document exists; reads can be made to fail.
class Tickets {
  docs = new Map<string, Record<string, any>>();
  create(id: string, doc: Record<string, any>) {
    if (this.docs.has(id)) return false;
    this.docs.set(id, doc);
    return true;
  }
}
type Outcome = { saved: boolean; stopped?: "duplicate"; emails: string[]; rescue?: { kind: string; subject: string; html: string } };
function intake(store: Tickets, executionId: string, o: { form?: Record<string, string>; priority?: string; createFails?: boolean; lostReply?: boolean; unreadable?: boolean; ackFails?: boolean; escFails?: boolean } = {}): Outcome {
  const ticket = build(o.form ?? form, { executionId, priority: o.priority });
  const res: Outcome = { saved: false, emails: [] };
  const rescue = (input: Record<string, any>, executed: string[] = []) => {
    res.rescue = codeRun("prepare-rescue-email.js", { input, nodes: { "Build ticket": [{ json: ticket }] }, executed, executionId }) as Outcome["rescue"];
  };
  let continueToEmails = false;
  if (o.createFails) {
    rescue(codeRun("classify-create-error.js", { input: { error: { message: "Service unavailable", httpCode: "503" } } }));
    return res;
  }
  const created = store.create(ticket.ticketId, { ...ticket, ticketId: undefined });
  if (created && !o.lostReply) continueToEmails = true;
  else {
    // conflict (or a created document whose reply was lost, so n8n's retry conflicts with our own write)
    const cls = codeRun("classify-create-error.js", { input: { error: { message: "Document already exists", httpCode: "409" } } });
    assert.equal(cls.kind, "conflict");
    const existing = o.unreadable ? { error: "503" } : (store.docs.get(ticket.ticketId) ?? {});
    const chk = codeRun("check-existing-ticket.js", { input: existing, nodes: { "Build ticket": [{ json: ticket }] }, executionId });
    if (chk.route === "ours") continueToEmails = true;
    else if (chk.route === "duplicate") return { ...res, saved: true, stopped: "duplicate" };
    else {
      rescue(chk);
      return res;
    }
  }
  res.saved = true;
  if (continueToEmails) {
    const mail = ticket.escalationStatus === "required" ? "Send a message" : "Send a message1";
    const failed = mail === "Send a message" ? o.escFails : o.ackFails;
    if (failed) rescue({ error: { message: "Gmail unavailable <script>alert(1)</script>" } }, [mail]);
    else res.emails.push(mail);
  }
  return res;
}

test("Firestore failure: nothing is emailed to the customer, and staff get the full submission", () => {
  const r = intake(new Tickets(), "e1", { createFails: true });
  assert.equal(r.saved, false);
  assert.deepEqual(r.emails, []);
  assert.equal(r.rescue!.kind, "ticket_not_saved");
  for (const part of ["ada@example.com", "App crashes", "Ada", "Service unavailable"]) assert.ok(r.rescue!.html.includes(part), part);
  assert.match(r.rescue!.subject, /Ticket NOT saved/);
});

test("simultaneous duplicate submissions: one ticket, one set of emails, the second run stops quietly", () => {
  const store = new Tickets();
  const a = intake(store, "run-A");
  const b = intake(store, "run-B");
  assert.equal(store.docs.size, 1);
  assert.deepEqual(a.emails, ["Send a message1"]);
  assert.equal(b.stopped, "duplicate");
  assert.deepEqual(b.emails, []);
  assert.equal(b.rescue, undefined);
});

test("lost reply: n8n's retry conflicts with this run's own write, so the emails still go out", () => {
  const store = new Tickets();
  const r = intake(store, "run-A", { lostReply: true });
  assert.equal(store.docs.size, 1);
  assert.equal(r.stopped, undefined);
  assert.deepEqual(r.emails, ["Send a message1"]);
});

test("a conflict that cannot be confirmed is reported to staff, not silently dropped", () => {
  const store = new Tickets();
  intake(store, "run-A");
  const r = intake(store, "run-B", { unreadable: true });
  assert.equal(r.rescue!.kind, "ticket_unclear");
  assert.deepEqual(r.emails, []);
});

test("a repeat in a different hour is a new ticket, not a duplicate", () => {
  const store = new Tickets();
  const t1 = build(form, { nowMs: Date.parse("2026-11-18T10:15:00Z") });
  const t2 = build(form, { nowMs: Date.parse("2026-11-18T12:15:00Z") });
  store.create(t1.ticketId, {});
  assert.equal(store.create(t2.ticketId, {}), true);
});

test("notification failures after a successful save: staff are told, the ticket stays", () => {
  const ack = intake(new Tickets(), "e1", { ackFails: true });
  assert.equal(ack.saved, true);
  assert.equal(ack.rescue!.kind, "acknowledgement_failed");
  const esc = intake(new Tickets(), "e2", { priority: "High", escFails: true });
  assert.equal(esc.saved, true);
  assert.equal(esc.rescue!.kind, "escalation_failed");
});

test("High/Urgent still goes to staff only, with no automatic customer acknowledgement", () => {
  for (const priority of ["High", "Urgent"]) {
    const r = intake(new Tickets(), "e", { priority });
    assert.deepEqual(r.emails, ["Send a message"], priority);
  }
  assert.deepEqual(intake(new Tickets(), "e", { priority: "Low" }).emails, ["Send a message1"]);
});

test("rescue email escapes everything, keeps the subject on one line, and bounds the error text", () => {
  const evil = { "Your Name": "A<script>x</script>\nBcc: z@z.z", "Your Email": "ada@example.com", "What is it you would like us to fix ?": "<img src=x onerror=alert(1)> & more" };
  const r = intake(new Tickets(), "e", { form: evil, ackFails: true });
  assert.doesNotMatch(r.rescue!.html, /<script|<img/);
  assert.match(r.rescue!.html, /&lt;img src=x onerror=alert\(1\)&gt; &amp; more/);
  assert.doesNotMatch(r.rescue!.subject, /[\r\n]/);
  assert.doesNotMatch(r.rescue!.html, /<script>alert/);
});

test("the duplicate/recovery path keeps the ticket reference ID for the emails", () => {
  const ticket = build();
  const out = codeRun("check-existing-ticket.js", { input: { intakeExecutionId: "exec-1" }, nodes: { "Build ticket": [{ json: ticket }] } });
  assert.equal(out.route, "ours");
  assert.equal(out.ticketId, ticket.ticketId);
  assert.equal(codeRun("check-existing-ticket.js", { input: { intakeExecutionId: "other" }, nodes: { "Build ticket": [{ json: ticket }] } }).route, "duplicate");
  assert.equal(codeRun("check-existing-ticket.js", { input: {}, nodes: { "Build ticket": [{ json: ticket }] } }).route, "unclear");
});
