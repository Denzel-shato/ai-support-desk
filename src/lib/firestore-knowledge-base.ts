import "server-only";

import { getAdminDb } from "./firebase-admin";
import { withTimeout } from "./firestore-tickets";
import {
  compareArticles,
  KNOWLEDGE_COLLECTION,
  toKnowledgeArticle,
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
