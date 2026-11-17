import test from "node:test";
import assert from "node:assert/strict";
import { FakeFirestore } from "./fake-firestore";
import {
  applyReviewAction,
  claimResponseSend,
  reconcileResponse,
  recordSendOutcome,
} from "@/lib/firestore-ticket-response";
import {
  claimFollowUp,
  listFollowUps,
  recordFollowUpOutcome,
  reconcileFollowUp,
} from "@/lib/firestore-ticket-messages";
import { TicketNotFoundError } from "@/lib/firestore-tickets";
import {
  buildResponseWorkspace,
  interpretWebhookResponse,
  ResponseWorkflowError,
  STALE_SENDING_MS,
} from "@/lib/response-workflow";
import { callSendWebhook } from "@/lib/n8n-send-response";
import { serializeTicket } from "@/lib/ticket-serialization";
import { isAwaitingReview, displayStatus } from "@/lib/overview";
import type { Firestore } from "firebase-admin/firestore";

const NOW = Date.parse("2026-11-16T10:00:00Z");
const TID = "ticket_1";
const T = `support_tickets/${TID}`;
const MID = "11111111-1111-4111-8111-111111111111";

function setup(overrides: Record<string, unknown> = {}) {
  const fake = new FakeFirestore();
  fake.seed(T, {
    customerName: "Ada",
    customerEmail: "ada@example.com",
    message: "App crashes",
    priority: "High",
    category: "Bug",
    summary: "Crash",
    customerResponse: "Original AI reply",
    aiResponse: "Original AI reply",
    status: "pending_review",
    reviewStatus: "awaiting_review",
    ...overrides,
  });
  return { fake, db: fake as unknown as Firestore };
}
const rejects = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof ResponseWorkflowError && e.code === code);

/* ---- review, approval policy, original response ---- */

test("approve stores finalResponse and never touches the original AI response", async () => {
  const { fake, db } = setup();
  await applyReviewAction(TID, "approve", "Edited reply", db, NOW);
  const doc = fake.read(T)!;
  assert.equal(doc.finalResponse, "Edited reply");
  assert.equal(doc.reviewStatus, "approved");
  assert.equal(doc.aiResponse, "Original AI reply");
  assert.equal(doc.customerResponse, "Original AI reply");
  const created = fake.writes.filter((w) => w.op === "create").map((w) => w.path);
  assert.ok(created.every((p) => p.startsWith(`${T}/response_events/`)), "only audit events are created");
  assert.equal(fake.data.size, 1 + created.length);
});

test("Low/Medium tickets refuse approval and sending even with a legacy awaiting_review", async () => {
  for (const priority of ["Low", "Medium"]) {
    const { db } = setup({ priority });
    await rejects(applyReviewAction(TID, "approve", "x", db, NOW), "approval_not_required");
    await rejects(claimResponseSend(TID, db, NOW), "approval_not_required");
  }
});

test("Overview does not count or label Low/Medium legacy awaiting_review as awaiting review", () => {
  const low = serializeTicket("a", { priority: "Low", reviewStatus: "awaiting_review" });
  const high = serializeTicket("b", { priority: "High", reviewStatus: "awaiting_review" });
  assert.equal(isAwaitingReview(low), false);
  assert.equal(displayStatus(low), "open");
  assert.equal(isAwaitingReview(high), true);
});

test("unapproved High response cannot be sent", async () => {
  const { db } = setup();
  await rejects(claimResponseSend(TID, db, NOW), "not_approved");
});

/* ---- idempotent claim ---- */

test("two simultaneous sends: exactly one wins the claim", async () => {
  const { fake, db } = setup();
  await applyReviewAction(TID, "approve", "Edited reply", db, NOW);
  const results = await Promise.allSettled([claimResponseSend(TID, db, NOW), claimResponseSend(TID, db, NOW)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  assert.equal(fake.read(T)!.responseStatus, "sending");
});

test("retry after a known failure reuses the same idempotency key", async () => {
  const { fake, db } = setup();
  await applyReviewAction(TID, "approve", "Edited reply", db, NOW);
  const first = await claimResponseSend(TID, db, NOW);
  await recordSendOutcome(TID, first.idempotencyKey, { kind: "failed", message: "n8n said no" }, db, NOW);
  assert.equal(fake.read(T)!.responseStatus, "failed");
  const second = await claimResponseSend(TID, db, NOW + 1000);
  assert.equal(second.idempotencyKey, first.idempotencyKey);
  assert.equal(second.attempt, 2);
});

/* ---- unknown outcomes ---- */

test("a timeout is recorded as unknown, NOT failed", async () => {
  const { fake, db } = setup();
  await applyReviewAction(TID, "approve", "Edited reply", db, NOW);
  const claim = await claimResponseSend(TID, db, NOW);
  const outcome = await callSendWebhook(
    { url: "https://n8n.example/webhook/x", secret: "s" },
    { ticketId: TID, messageType: "initial_response", idempotencyKey: claim.idempotencyKey, attempt: 1, customerName: null, customerEmail: "a@b.co", subject: "s", messageBody: "b", requestedAt: "", source: "ai-support-desk" },
    { fetchImpl: () => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })) as never },
  );
  assert.equal(outcome.kind, "unknown");
  await recordSendOutcome(TID, claim.idempotencyKey, outcome, db, NOW);
  assert.equal(fake.read(T)!.responseStatus, "unknown");
  assert.notEqual(fake.read(T)!.responseStatus, "failed");
});

test("webhook classification: connect refused = failed; reset / 5xx / 408 = unknown; 4xx = failed", async () => {
  const cfg = { url: "https://n8n.example/w", secret: null };
  const p = { ticketId: "t", messageType: "follow_up", idempotencyKey: "k", attempt: 1, customerName: null, customerEmail: "a@b.co", subject: "s", messageBody: "b", requestedAt: "", source: "ai-support-desk" } as const;
  const err = (code: string) => () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code } })) as never;
  assert.equal((await callSendWebhook(cfg, p, { fetchImpl: err("ECONNREFUSED") })).kind, "failed");
  assert.equal((await callSendWebhook(cfg, p, { fetchImpl: err("ECONNRESET") })).kind, "unknown");
  assert.equal(interpretWebhookResponse(500, null).kind, "unknown");
  assert.equal(interpretWebhookResponse(504, null).kind, "unknown");
  assert.equal(interpretWebhookResponse(408, null).kind, "unknown");
  assert.equal(interpretWebhookResponse(404, null).kind, "failed");
  assert.equal(interpretWebhookResponse(200, { status: "failed", error: "x" }).kind, "failed");
  assert.equal(interpretWebhookResponse(409, { status: "unknown" }).kind, "unknown");
  assert.equal(interpretWebhookResponse(200, null).kind, "accepted");
  assert.equal(interpretWebhookResponse(200, [{ status: "sent" }]).kind, "sent");
});

test("unknown/queued tickets are not resent without an explicit retryUnknown", async () => {
  const { fake, db } = setup();
  await applyReviewAction(TID, "approve", "Edited reply", db, NOW);
  const c = await claimResponseSend(TID, db, NOW);
  await recordSendOutcome(TID, c.idempotencyKey, { kind: "unknown", message: "?" }, db, NOW);
  await rejects(claimResponseSend(TID, db, NOW + 1000), "delivery_unconfirmed");
  await rejects(applyReviewAction(TID, "reject", undefined, db, NOW), "delivery_unconfirmed");
  const again = await claimResponseSend(TID, db, NOW + 2000, { retryUnknown: true });
  assert.equal(again.idempotencyKey, c.idempotencyKey);
  assert.equal(fake.read(T)!.responseAttempts, 2);
});

test("a claim that never recorded an answer becomes unknown after the stale window, never failed", async () => {
  const { fake, db } = setup();
  await applyReviewAction(TID, "approve", "Edited reply", db, NOW);
  await claimResponseSend(TID, db, NOW);
  await rejects(claimResponseSend(TID, db, NOW + 1000), "send_in_progress");
  const later = NOW + STALE_SENDING_MS + 1;
  const view = buildResponseWorkspace(serializeTicket(TID, fake.read(T)!), later);
  assert.equal(view.responseStatus, "unknown");
  assert.equal(view.needsReconciliation, true);
  await rejects(claimResponseSend(TID, db, later), "delivery_unconfirmed");
});

test("a late outcome never overwrites sent or an agent's reconciliation", async () => {
  const { fake, db } = setup();
  await applyReviewAction(TID, "approve", "Edited reply", db, NOW);
  const c = await claimResponseSend(TID, db, NOW);
  await recordSendOutcome(TID, c.idempotencyKey, { kind: "sent", sentAt: null, messageId: null }, db, NOW);
  await recordSendOutcome(TID, c.idempotencyKey, { kind: "failed", message: "late" }, db, NOW + 5);
  assert.equal(fake.read(T)!.responseStatus, "sent");
  await rejects(claimResponseSend(TID, db, NOW + 10), "already_sent");
  await rejects(applyReviewAction(TID, "reject", undefined, db, NOW + 10), "response_already_sent");
});

test("agent reconciliation: delivered -> sent (agent-confirmed); not delivered -> failed, then resend works", async () => {
  const a = setup();
  await applyReviewAction(TID, "approve", "R", a.db, NOW);
  const c = await claimResponseSend(TID, a.db, NOW);
  await recordSendOutcome(TID, c.idempotencyKey, { kind: "accepted" }, a.db, NOW);
  assert.equal(a.fake.read(T)!.responseStatus, "queued");
  await reconcileResponse(TID, "delivered", a.db, NOW + 1);
  assert.equal(a.fake.read(T)!.responseStatus, "sent");
  assert.equal(a.fake.read(T)!.responseConfirmedBy, "agent");
  await rejects(reconcileResponse(TID, "delivered", a.db, NOW + 2), "already_sent");

  const b = setup();
  await applyReviewAction(TID, "approve", "R", b.db, NOW);
  const c2 = await claimResponseSend(TID, b.db, NOW);
  await recordSendOutcome(TID, c2.idempotencyKey, { kind: "unknown", message: "?" }, b.db, NOW);
  await reconcileResponse(TID, "not_delivered", b.db, NOW + 1);
  assert.equal(b.fake.read(T)!.responseStatus, "failed");
  await claimResponseSend(TID, b.db, NOW + 2);
  await rejects(reconcileResponse(TID, "delivered", b.db, NOW + 3), "send_in_progress");
});

/* ---- follow-ups ---- */

async function approvedAndSent() {
  const s = setup();
  await applyReviewAction(TID, "approve", "Final text", s.db, NOW);
  const c = await claimResponseSend(TID, s.db, NOW);
  await recordSendOutcome(TID, c.idempotencyKey, { kind: "sent", sentAt: null, messageId: null }, s.db, NOW);
  return s;
}

test("follow-ups never change the main response status or the stored responses", async () => {
  const { fake, db } = await approvedAndSent();
  const before = structuredClone(fake.read(T));
  const claim = await claimFollowUp(TID, MID, "Hello again", db, NOW);
  await recordFollowUpOutcome(TID, MID, { kind: "failed", message: "boom" }, db, NOW);
  assert.equal(claim.mode, "create");
  assert.deepEqual(fake.read(T), before, "the ticket document is untouched by follow-ups");
  const doc = fake.read(T)!;
  assert.equal(doc.responseStatus, "sent");
  assert.equal(doc.aiResponse, "Original AI reply");
  assert.equal(doc.finalResponse, "Final text");
});

test("repeated follow-up sends create one message record, not two", async () => {
  const { fake, db } = setup();
  const results = await Promise.allSettled([
    claimFollowUp(TID, MID, "Hi", db, NOW),
    claimFollowUp(TID, MID, "Hi", db, NOW),
    claimFollowUp(TID, MID, "Hi", db, NOW),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const msgs = [...fake.data.keys()].filter((k) => k.startsWith(`${T}/messages/`));
  assert.equal(msgs.length, 1);
  assert.equal(fake.writes.filter((w) => w.op === "create" && w.path.includes("/messages/")).length, 1);
});

test("follow-up: timeout -> unknown, no auto retry, explicit retry keeps the same message id", async () => {
  const { fake, db } = setup();
  await claimFollowUp(TID, MID, "Hi", db, NOW);
  await recordFollowUpOutcome(TID, MID, { kind: "unknown", message: "timeout" }, db, NOW);
  assert.equal(fake.read(`${T}/messages/${MID}`)!.status, "unknown");
  await rejects(claimFollowUp(TID, MID, "CHANGED", db, NOW + 1), "delivery_unconfirmed");
  const retry = await claimFollowUp(TID, MID, "CHANGED TEXT IS IGNORED", db, NOW + 2, { retryUnknown: true });
  assert.equal(retry.content, "Hi", "a retry re-sends the stored text, never new browser text");
  assert.equal(retry.attempt, 2);
  assert.equal([...fake.data.keys()].filter((k) => k.includes("/messages/")).length, 1);
});

test("follow-up reconcile and stale sending read as unknown in the history", async () => {
  const { db } = setup();
  await claimFollowUp(TID, MID, "Hi", db, NOW);
  assert.equal((await listFollowUps(TID, db, NOW + 1000))[0].status, "sending");
  const later = NOW + STALE_SENDING_MS + 5;
  assert.equal((await listFollowUps(TID, db, later))[0].status, "unknown", "stale claim reads as unknown, not failed");
  const m = await reconcileFollowUp(TID, MID, "delivered", db, later);
  assert.equal(m.status, "sent");
});

/* ---- late results, audit trail ---- */

const events = (fake: FakeFirestore) =>
  [...fake.data.entries()].filter(([k]) => k.startsWith(`${T}/response_events/`)).map(([, v]) => v);

test("a late answer from an older attempt cannot overwrite a newer attempt's claim", async () => {
  const { fake, db } = setup();
  await applyReviewAction(TID, "approve", "Final text", db, NOW);
  const a1 = await claimResponseSend(TID, db, NOW);
  await recordSendOutcome(TID, a1.idempotencyKey, { kind: "unknown", message: "?" }, db, NOW, a1.attempt);
  const a2 = await claimResponseSend(TID, db, NOW + 1, { retryUnknown: true });
  assert.equal(a2.idempotencyKey, a1.idempotencyKey, "same key on retry");
  assert.equal(a2.attempt, 2);
  // Attempt 1's request finally reports a failure: it must be ignored.
  await recordSendOutcome(TID, a1.idempotencyKey, { kind: "failed", message: "late" }, db, NOW + 2, a1.attempt);
  assert.equal(fake.read(T)!.responseStatus, "sending");
  await recordSendOutcome(TID, a2.idempotencyKey, { kind: "sent", sentAt: null, messageId: null }, db, NOW + 3, a2.attempt);
  assert.equal(fake.read(T)!.responseStatus, "sent");
});

test("a late answer from an older follow-up attempt is ignored the same way", async () => {
  const { fake, db } = setup();
  await claimFollowUp(TID, MID, "Hi", db, NOW);
  await recordFollowUpOutcome(TID, MID, { kind: "unknown", message: "?" }, db, NOW, 1);
  await claimFollowUp(TID, MID, undefined, db, NOW + 1, { retryUnknown: true });
  await recordFollowUpOutcome(TID, MID, { kind: "failed", message: "late" }, db, NOW + 2, 1);
  assert.equal(fake.read(`${T}/messages/${MID}`)!.status, "sending");
});

test("audit trail: edits keep the replaced text; claims, outcomes and reconciliations are recorded", async () => {
  const { fake, db } = setup();
  await applyReviewAction(TID, "approve", "First version", db, NOW, "admin");
  await applyReviewAction(TID, "reopen", "Second version", db, NOW + 1, "admin");
  await applyReviewAction(TID, "approve", undefined, db, NOW + 2, "admin");
  const c = await claimResponseSend(TID, db, NOW + 3, {}, "admin");
  await recordSendOutcome(TID, c.idempotencyKey, { kind: "unknown", message: "timeout" }, db, NOW + 4, c.attempt);
  await reconcileResponse(TID, "delivered", db, NOW + 5, "admin");

  const all = events(fake);
  const types = all.map((e) => e.type);
  for (const t of ["review_approve", "review_reopen", "response_edited", "send_claimed", "send_outcome", "reconciled"]) {
    assert.ok(types.includes(t), `missing ${t} event`);
  }
  const edit = all.find((e) => e.type === "response_edited" && e.finalResponse === "Second version")!;
  assert.equal(edit.previousFinalResponse, "First version");
  assert.equal(all.find((e) => e.type === "reconciled")!.previousStatus, "unknown");
  assert.equal(all.find((e) => e.type === "send_claimed")!.actor, "admin");
  // The original AI response is never modified by any of it.
  assert.equal(fake.read(T)!.aiResponse, "Original AI reply");
  assert.equal(fake.read(T)!.customerResponse, "Original AI reply");
});

test("a refused action leaves no audit event behind", async () => {
  const { fake, db } = setup();
  await rejects(claimResponseSend(TID, db, NOW), "not_approved");
  assert.equal(events(fake).length, 0);
});

/* ---- missing documents, invalid input ---- */

test("missing ticket documents are handled, not created", async () => {
  const { fake, db } = setup();
  await assert.rejects(applyReviewAction("nope", "approve", "x", db, NOW), TicketNotFoundError);
  await assert.rejects(claimResponseSend("nope", db, NOW), TicketNotFoundError);
  await assert.rejects(claimFollowUp("nope", MID, "x", db, NOW), TicketNotFoundError);
  await assert.rejects(reconcileResponse("nope", "delivered", db, NOW), TicketNotFoundError);
  assert.equal(fake.data.size, 1, "nothing was created for the missing ticket");
});

test("invalid requests are rejected", async () => {
  const { db } = setup();
  const { parseReviewRequest, parseReconcileRequest } = await import("@/lib/response-workflow");
  assert.throws(() => parseReviewRequest({ action: "explode" }), ResponseWorkflowError);
  assert.throws(() => parseReviewRequest({ action: "approve", finalResponse: "   " }), ResponseWorkflowError);
  assert.throws(() => parseReviewRequest({ action: "approve", finalResponse: 5 }), ResponseWorkflowError);
  assert.throws(() => parseReconcileRequest({ outcome: "maybe" }), ResponseWorkflowError);
  await assert.rejects(claimFollowUp(TID, MID, "   ", db, NOW), ResponseWorkflowError);
  await assert.rejects(claimFollowUp(TID, MID, "x", setup({ customerEmail: "a@b.co, c@d.co" }).db, NOW), ResponseWorkflowError);
});

test("serializer is an allowlist: internal and unknown fields are not exposed", () => {
  const t = serializeTicket("id1", { customerName: "A", responseSendId: "secret-key", responseAttempts: 3, somethingElse: "x", priority: "High" });
  assert.equal("responseSendId" in t, false);
  assert.equal("somethingElse" in t, false);
  assert.equal(t.id, "id1");
  assert.equal(t.priority, "High");
});
