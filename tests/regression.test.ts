// Existing behaviour that must keep working after the remediation.
import test from "node:test";
import assert from "node:assert/strict";
import { deriveOverview, normalizePriority } from "@/lib/overview";
import { selectEscalated } from "@/lib/escalations";
import { searchArticles, toKnowledgeArticle, compareArticles } from "@/lib/knowledge-base";
import { buildHistory } from "@/lib/communications";
import { buildResponseWorkspace, pickOriginalAiResponse } from "@/lib/response-workflow";
import { serializeTicket } from "@/lib/ticket-serialization";

const NOW = new Date("2026-11-16T10:00:00Z");
const tickets = [
  serializeTicket("1", { priority: "Urgent", escalationStatus: "required", reviewStatus: "awaiting_review", createdAt: "2026-11-16T09:00:00Z", customerResponse: "R1" }),
  serializeTicket("2", { priority: "High", reviewStatus: "approved", createdAt: "2026-11-15T09:00:00Z" }),
  serializeTicket("3", { priority: "Medium", reviewStatus: "awaiting_review", escalationStatus: "not_required", createdAt: "2026-11-15T10:00:00Z" }),
  serializeTicket("4", { priority: "Low", status: "resolved", createdAt: "2026-11-14T10:00:00Z" }),
  serializeTicket("5", { createdAt: null }),
];

test("overview metrics: totals, escalated, and awaiting review counts only High/Urgent", () => {
  const o = deriveOverview(tickets, NOW);
  const m = Object.fromEntries(o.metrics.map((x) => [x.id, x.value]));
  assert.equal(m.total, 5);
  assert.equal(m.escalated, 1);
  assert.equal(m.awaiting_review, 1, "Medium with a legacy awaiting_review is not counted");
  assert.equal(o.priorityTotal, 5);
});

test("priority and escalation selection still work", () => {
  assert.equal(normalizePriority("URGENT"), "urgent");
  assert.equal(normalizePriority(undefined), "unspecified");
  assert.deepEqual(selectEscalated(tickets).map((t) => t.id), ["1"]);
});

test("knowledge search and ordering still work", () => {
  const a = toKnowledgeArticle("a", { title: "Login failure", category: "Auth", keywords: ["password"], content: "Reset it", active: true });
  const b = toKnowledgeArticle("b", { title: "Zed", category: "Other", keywords: [], content: "x", active: false });
  assert.deepEqual(searchArticles([a, b], "password reset").map((h) => h.article.id), ["a"]);
  assert.deepEqual([b, a].sort(compareArticles).map((x) => x.id), ["a", "b"]);
});

test("history keeps the AI response first and unchanged; follow-ups are separate entries", () => {
  const t = serializeTicket("1", { priority: "High", customerResponse: "AI text", finalResponse: "Final text", responseStatus: "sent", responseSentAt: "2026-11-16T10:30:00Z", createdAt: "2026-11-16T09:00:00Z" });
  const h = buildHistory(t, [{ id: "m1", content: "Follow", status: "sent", createdAt: "2026-11-16T11:00:00Z", queuedAt: null, sentAt: "2026-11-16T11:00:00Z", error: null, attempts: 1 }]);
  assert.deepEqual(h.map((e) => e.type), ["ai_response", "agent_response", "follow_up"]);
  assert.equal(h[0].content, "AI text");
  assert.equal(h[1].content, "Final text");
});

test("response workspace view: original text, baseline and Low/Medium read-only behaviour", () => {
  const low = serializeTicket("l", { priority: "Low", customerResponse: "AI", reviewStatus: "awaiting_review", customerEmail: "a@b.co" });
  const v = buildResponseWorkspace(low, NOW.getTime());
  assert.equal(v.approvalRequired, false);
  assert.equal(v.original.text, "AI");
  assert.equal(pickOriginalAiResponse({ customerResponse: null, aiResponse: "only ai" }).text, "only ai");
});
