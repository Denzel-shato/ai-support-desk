import test from "node:test";
import assert from "node:assert/strict";
import { FakeFirestore } from "./fake-firestore";
import {
  ArticleConflictError,
  createKnowledgeArticle,
  DuplicateArticleError,
  KnowledgeNotFoundError,
  listKnowledgeArticles,
  RequestIdConflictError,
  updateKnowledgeArticle,
} from "@/lib/firestore-knowledge-base";
import { parseArticleCreate, parseArticleUpdate, validateArticleInput } from "@/lib/knowledge-base";
import type { Firestore } from "firebase-admin/firestore";

const C = "knowledge_base";
const REQ = "22222222-2222-4222-8222-222222222222";
const input = { title: "Crash on start", category: "Bugs", keywords: ["crash"], content: "Reinstall.", active: true };

function setup() {
  const fake = new FakeFirestore();
  fake.seed(`${C}/app_crash_troubleshooting`, {
    title: "App crash", category: "Bugs", keywords: ["crash"], content: "Steps", active: false,
  });
  return { fake, db: fake as unknown as Firestore };
}
const update = (raw: unknown) => {
  const p = parseArticleUpdate(raw);
  assert.ok(p.ok, JSON.stringify(p));
  return p.update;
};

test("editing preserves the document ID and creates no document", async () => {
  const { fake, db } = setup();
  const a = await updateKnowledgeArticle("app_crash_troubleshooting", update({ title: "App crash v2", category: "Bugs", keywords: ["crash", "startup"], content: "New steps" }), db);
  assert.equal(a.id, "app_crash_troubleshooting");
  assert.equal(fake.data.size, 1);
  assert.equal(fake.writes.filter((w) => w.op === "create").length, 0);
  assert.deepEqual(fake.read(`${C}/app_crash_troubleshooting`)!.keywords, ["crash", "startup"]);
});

test("a full edit that omits `active` leaves an inactive article inactive", async () => {
  const { fake, db } = setup();
  await updateKnowledgeArticle("app_crash_troubleshooting", update({ title: "T", category: "Bugs", keywords: [], content: "C" }), db);
  assert.equal(fake.read(`${C}/app_crash_troubleshooting`)!.active, false);
});

test("toggling active changes only `active`; deactivated articles stay listed", async () => {
  const { fake, db } = setup();
  const before = structuredClone(fake.read(`${C}/app_crash_troubleshooting`)!);
  await updateKnowledgeArticle("app_crash_troubleshooting", update({ active: true }), db);
  await updateKnowledgeArticle("app_crash_troubleshooting", update({ active: false }), db);
  assert.deepEqual(fake.read(`${C}/app_crash_troubleshooting`), before);
  const all = await listKnowledgeArticles(db);
  assert.equal(all.length, 1);
  assert.equal(all[0].active, false);
});

test("missing article: 404-style error and nothing created", async () => {
  const { fake, db } = setup();
  await assert.rejects(updateKnowledgeArticle("missing", update({ active: true }), db), KnowledgeNotFoundError);
  assert.equal(fake.data.size, 1);
});

test("stale edit is refused instead of overwriting a concurrent change", async () => {
  const { fake, db } = setup();
  const [loaded] = await listKnowledgeArticles(db);
  await updateKnowledgeArticle("app_crash_troubleshooting", update({ active: true }), db); // someone else
  await assert.rejects(
    updateKnowledgeArticle("app_crash_troubleshooting", update({ title: "Mine", category: "Bugs", keywords: [], content: "C", expectedVersion: loaded.version }), db),
    ArticleConflictError,
  );
  assert.equal(fake.read(`${C}/app_crash_troubleshooting`)!.title, "App crash");
  const [fresh] = await listKnowledgeArticles(db);
  await updateKnowledgeArticle("app_crash_troubleshooting", update({ title: "Mine", category: "Bugs", keywords: [], content: "C", expectedVersion: fresh.version }), db);
  assert.equal(fake.read(`${C}/app_crash_troubleshooting`)!.title, "Mine");
});

test("create: same requestId twice (and concurrently) yields ONE document", async () => {
  const { fake, db } = setup();
  const results = await Promise.all([
    createKnowledgeArticle(input, REQ, db),
    createKnowledgeArticle(input, REQ, db),
  ]);
  assert.equal(results[0].id, REQ);
  assert.equal(results[1].id, REQ);
  const again = await createKnowledgeArticle(input, REQ, db);
  assert.equal(again.id, REQ);
  assert.equal([...fake.data.keys()].filter((k) => k.startsWith(`${C}/`)).length, 2);
  assert.equal(fake.writes.filter((w) => w.op === "create").length, 1);
});

test("create: a requestId reused for a different article is refused", async () => {
  const { db } = setup();
  await createKnowledgeArticle(input, REQ, db);
  await assert.rejects(createKnowledgeArticle({ ...input, content: "Other" }, REQ, db), RequestIdConflictError);
});

test("create/edit: duplicate title in the same category is refused; other category is fine", async () => {
  const { db } = setup();
  await assert.rejects(createKnowledgeArticle({ ...input, title: "  app CRASH ", category: "bugs" }, null, db), DuplicateArticleError);
  await createKnowledgeArticle({ ...input, title: "App crash", category: "Billing" }, null, db);
  await assert.rejects(
    updateKnowledgeArticle("app_crash_troubleshooting", update({ title: "App crash", category: "Billing", keywords: [], content: "C" }), db),
    DuplicateArticleError,
  );
});

test("create writes only the five schema fields", async () => {
  const { fake, db } = setup();
  const a = await createKnowledgeArticle({ ...input, extra: "x" } as never, null, db);
  assert.deepEqual(Object.keys(fake.read(`${C}/${a.id}`)!).sort(), ["active", "category", "content", "keywords", "title"]);
});

test("invalid KB requests are rejected by validation", () => {
  assert.equal(validateArticleInput({ title: "", category: "x", content: "c" }).ok, false);
  assert.equal(validateArticleInput({ title: "t", category: "x", content: "c", keywords: "no" }).ok, false);
  assert.equal(validateArticleInput({ title: "t", category: "x", content: "c", active: "yes" }).ok, false);
  assert.equal(validateArticleInput(null).ok, false);
  assert.equal(parseArticleCreate({ ...input, requestId: "not-a-uuid" }).ok, false);
  assert.equal(parseArticleUpdate({ active: "true" }).ok, false);
  assert.equal(parseArticleUpdate({ title: "t", category: "c", content: "c", expectedVersion: "garbage" }).ok, false);
});
