import "server-only";

import type { Firestore } from "firebase-admin/firestore";
import { getAdminDb } from "./firebase-admin";
import { withTimeout } from "./firestore-tickets";
import {
  compareArticles,
  KNOWLEDGE_COLLECTION,
  toKnowledgeArticle,
  type ArticleInput,
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
