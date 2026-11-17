import "server-only";

import type { Firestore } from "firebase-admin/firestore";
import { getAdminDb } from "./firebase-admin";
import { MAX_ARTICLES } from "./limits";
import { isValidDocumentId, withTimeout } from "./firestore-tickets";
import {
  compareArticles,
  findDuplicateArticle,
  KNOWLEDGE_COLLECTION,
  toKnowledgeArticle,
  updateFields,
  type ArticleInput,
  type ArticleUpdate,
} from "./knowledge-base";
import type { KnowledgeArticle } from "./types";

export { MAX_ARTICLES };

const QUERY_TIMEOUT_MS = 15_000;

type TimeLike = { toDate(): Date } | null | undefined;

/** Opaque version token: the document's last-write time. */
function versionOf(time: TimeLike): string | null {
  return time ? time.toDate().toISOString() : null;
}

/**
 * Reads the `knowledge_base` collection (the same one the n8n workflow reads),
 * read-only, using the shared Firebase Admin instance. Returns every article,
 * active and inactive, active first; the page distinguishes them.
 */
export async function listKnowledgeArticlesPage(
  db: Firestore = getAdminDb(),
): Promise<{ articles: KnowledgeArticle[]; truncated: boolean }> {
  const snapshot = await withTimeout(
    db.collection(KNOWLEDGE_COLLECTION).limit(MAX_ARTICLES + 1).get(),
    QUERY_TIMEOUT_MS,
  );
  const truncated = snapshot.docs.length > MAX_ARTICLES;
  if (truncated) {
    console.warn(
      `[firestore-knowledge-base] More than ${MAX_ARTICLES} articles exist; only ${MAX_ARTICLES} are shown and checked for duplicates.`,
    );
  }
  const articles = snapshot.docs
    .slice(0, MAX_ARTICLES)
    .map((doc) => toKnowledgeArticle(doc.id, doc.data(), versionOf(doc.updateTime)))
    .sort(compareArticles);
  return { articles, truncated };
}

export async function listKnowledgeArticles(
  db: Firestore = getAdminDb(),
): Promise<KnowledgeArticle[]> {
  return (await listKnowledgeArticlesPage(db)).articles;
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

/** Another article already has this title in this category. */
export class DuplicateArticleError extends Error {
  constructor(
    readonly existingId: string,
    readonly existingTitle: string | null,
  ) {
    super("An article with this title already exists in this category.");
    this.name = "DuplicateArticleError";
  }
}

/** The article changed after the editor loaded it. */
export class ArticleConflictError extends Error {
  constructor() {
    super("This article was changed by someone else after you opened it.");
    this.name = "ArticleConflictError";
  }
}

/** The request ID was already used for a DIFFERENT article. */
export class RequestIdConflictError extends Error {
  constructor() {
    super("That request ID was already used for a different article.");
    this.name = "RequestIdConflictError";
  }
}

const ALREADY_EXISTS = 6;

function sameArticle(stored: Record<string, unknown>, input: ArticleInput): boolean {
  const a = toKnowledgeArticle("", stored);
  return (
    a.title === input.title &&
    a.category === input.category &&
    a.content === input.content &&
    a.active === input.active &&
    a.keywords.length === input.keywords.length &&
    a.keywords.every((k, i) => k === input.keywords[i])
  );
}

/**
 * Creates one article in `knowledge_base`. Writes exactly the existing five
 * fields (title, category, keywords, content, active): no new fields, no new
 * collection. `create()` fails rather than overwrite, so an existing document
 * can never be replaced.
 *
 * Idempotency: when the browser sends a `requestId` (one per form submission)
 * it becomes the document ID. Repeating the request (a double-click, a retry
 * after a dropped connection) finds the document it already created and
 * returns it instead of making a second one. Without a `requestId` the ID is
 * auto-generated, as before. An article with the same title and category as
 * an existing one is refused (DuplicateArticleError).
 */
export async function createKnowledgeArticle(
  input: ArticleInput,
  requestId: string | null = null,
  db: Firestore = getAdminDb(),
): Promise<KnowledgeArticle> {
  const col = db.collection(KNOWLEDGE_COLLECTION);
  const ref = requestId ? col.doc(requestId) : col.doc();

  const replay = async (): Promise<KnowledgeArticle | null> => {
    const snap = await withTimeout(ref.get(), QUERY_TIMEOUT_MS);
    if (!snap.exists) return null;
    if (!sameArticle(snap.data() ?? {}, input)) throw new RequestIdConflictError();
    return toKnowledgeArticle(snap.id, snap.data() ?? {}, versionOf(snap.updateTime));
  };

  if (requestId) {
    const existing = await replay();
    if (existing) return existing;
  }

  const duplicate = findDuplicateArticle(await listKnowledgeArticles(db), input);
  if (duplicate) throw new DuplicateArticleError(duplicate.id, duplicate.title);

  const data = {
    title: input.title,
    category: input.category,
    keywords: input.keywords,
    content: input.content,
    active: input.active,
  };
  try {
    const written = await withTimeout(ref.create(data), QUERY_TIMEOUT_MS);
    return toKnowledgeArticle(ref.id, data, versionOf(written.writeTime));
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === ALREADY_EXISTS && requestId) {
      // A concurrent identical request won the race: return its document.
      const existing = await replay();
      if (existing) return existing;
    }
    throw error;
  }
}

/**
 * Updates an EXISTING article in place. The document ID never changes and no
 * document is created (a missing ID is a 404), only the schema fields in
 * `update` are written, and anything else on the document is left alone.
 * Deleting is deliberately not offered: deactivating (`active: false`) is the
 * safe alternative.
 *
 * A full edit that carries the `version` it was loaded with is refused
 * (ArticleConflictError) when the document changed since, so two editors can't
 * silently overwrite each other. Retitling an article so it collides with
 * another one in the same category is refused (DuplicateArticleError).
 */
export async function updateKnowledgeArticle(
  id: string,
  update: ArticleUpdate,
  db: Firestore = getAdminDb(),
): Promise<KnowledgeArticle> {
  if (!isValidDocumentId(id)) throw new InvalidArticleIdError();
  const ref = db.collection(KNOWLEDGE_COLLECTION).doc(id);
  const fields = updateFields(update);

  if (update.kind === "full") {
    const duplicate = findDuplicateArticle(
      await listKnowledgeArticles(db),
      { title: update.value.title, category: update.value.category },
      id,
    );
    if (duplicate) throw new DuplicateArticleError(duplicate.id, duplicate.title);
  }

  await withTimeout(
    db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new KnowledgeNotFoundError(id);
      if (update.kind === "full" && update.expectedVersion) {
        const current = versionOf(snap.updateTime);
        if (current && Date.parse(current) !== Date.parse(update.expectedVersion)) {
          throw new ArticleConflictError();
        }
      }
      tx.update(ref, fields);
    }),
    QUERY_TIMEOUT_MS,
  );

  const after = await withTimeout(ref.get(), QUERY_TIMEOUT_MS);
  if (!after.exists) throw new KnowledgeNotFoundError(id);
  return toKnowledgeArticle(id, after.data() ?? {}, versionOf(after.updateTime));
}
