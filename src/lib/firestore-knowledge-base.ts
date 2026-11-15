import "server-only";

import type { Firestore } from "firebase-admin/firestore";
import { getAdminDb } from "./firebase-admin";
import { isValidDocumentId, withTimeout } from "./firestore-tickets";
import {
  compareArticles,
  KNOWLEDGE_COLLECTION,
  toKnowledgeArticle,
  updateFields,
  type ArticleInput,
  type ArticleUpdate,
} from "./knowledge-base";
import type { KnowledgeArticle } from "./types";

/** Safety cap. The collection is small; revisit if it grows. */
export const MAX_ARTICLES = 200;

const QUERY_TIMEOUT_MS = 15_000;

/**
 * Reads the `knowledge_base` collection (the same one the n8n workflow reads),
 * read-only, using the shared Firebase Admin instance. Returns every article,
 * active and inactive, active first; the page distinguishes them.
 */
export async function listKnowledgeArticles(): Promise<KnowledgeArticle[]> {
  const snapshot = await withTimeout(
    getAdminDb().collection(KNOWLEDGE_COLLECTION).limit(MAX_ARTICLES).get(),
    QUERY_TIMEOUT_MS,
  );
  return snapshot.docs
    .map((doc) => toKnowledgeArticle(doc.id, doc.data()))
    .sort(compareArticles);
}

/**
 * Creates one article in `knowledge_base` with an auto-generated document ID.
 * Writes exactly the existing five fields (title, category, keywords, content,
 * active): no new fields, no new collection. `create()` fails rather than
 * overwrite, so an existing document can never be replaced.
 */
export async function createKnowledgeArticle(
  input: ArticleInput,
  db: Firestore = getAdminDb(),
): Promise<KnowledgeArticle> {
  const ref = db.collection(KNOWLEDGE_COLLECTION).doc();
  const data = {
    title: input.title,
    category: input.category,
    keywords: input.keywords,
    content: input.content,
    active: input.active,
  };
  await withTimeout(ref.create(data), QUERY_TIMEOUT_MS);
  return toKnowledgeArticle(ref.id, data);
}

/** Thrown when no `knowledge_base` document has the requested ID. */
export class KnowledgeNotFoundError extends Error {
  constructor(readonly articleId: string) {
    super("Article not found.");
    this.name = "KnowledgeNotFoundError";
  }
}

/** Thrown when an ID could never be a valid Firestore document ID. */
export class InvalidArticleIdError extends Error {
  constructor() {
    super("That article ID is not valid.");
    this.name = "InvalidArticleIdError";
  }
}

/**
 * Updates an EXISTING article in place. The document ID never changes and no
 * document is created (a missing ID is a 404), only the schema fields in
 * `update` are written, and anything else on the document is left alone.
 * Deleting is deliberately not offered: deactivating (`active: false`) is the
 * safe alternative.
 */
export async function updateKnowledgeArticle(
  id: string,
  update: ArticleUpdate,
  db: Firestore = getAdminDb(),
): Promise<KnowledgeArticle> {
  if (!isValidDocumentId(id)) throw new InvalidArticleIdError();
  const ref = db.collection(KNOWLEDGE_COLLECTION).doc(id);
  const fields = updateFields(update);

  const merged = await withTimeout(
    db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new KnowledgeNotFoundError(id);
      tx.update(ref, fields);
      return { ...(snap.data() ?? {}), ...fields };
    }),
    QUERY_TIMEOUT_MS,
  );
  return toKnowledgeArticle(id, merged);
}
