import { redirectIfSignedOut, requestJson, TicketsApiError } from "@/lib/api/tickets";
import type { ArticleInput } from "@/lib/knowledge-base";
import type { KnowledgeArticle } from "@/lib/types";

/** Browser-side client for GET /api/knowledge-base. Pure fetching. */
export async function fetchKnowledgeArticles(
  signal?: AbortSignal,
): Promise<{ articles: KnowledgeArticle[]; truncated: boolean }> {
  const { body, status, truncated } = await requestJson("/api/knowledge-base", signal);
  if (!Array.isArray(body)) {
    throw new TicketsApiError("The server returned data in an unexpected format.", {
      code: "invalid_response",
      status,
    });
  }
  return { articles: body as KnowledgeArticle[], truncated };
}

async function send(
  url: string,
  method: "POST" | "PATCH",
  payload: unknown,
  unreachable: string,
): Promise<KnowledgeArticle> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch {
    throw new TicketsApiError(unreachable, { code: "network_error" });
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  redirectIfSignedOut(response);
  if (!response.ok) {
    const err = (body as { error?: { code?: string; message?: string; fields?: Record<string, string> } } | null)?.error;
    throw new TicketsApiError(
      err?.message ?? `The server returned an unexpected error (HTTP ${response.status}).`,
      { code: err?.code ?? "unknown_error", status: response.status, fields: err?.fields },
    );
  }
  const article = (body as { article?: KnowledgeArticle } | null)?.article;
  if (!article || typeof article.id !== "string") {
    throw new TicketsApiError("The server returned data in an unexpected format.", {
      code: "invalid_response",
      status: response.status,
    });
  }
  return article;
}

/** Creates an article. Throws TicketsApiError (with `fields` for validation errors). */
export function createKnowledgeArticle(
  input: ArticleInput,
  requestId: string,
): Promise<KnowledgeArticle> {
  return send(
    "/api/knowledge-base",
    "POST",
    { ...input, requestId },
    "Couldn't reach the dashboard server. Your article wasn't saved; check your connection and try again.",
  );
}

/** Saves edits to an existing article (same document ID). */
export function updateKnowledgeArticle(
  id: string,
  input: ArticleInput,
  expectedVersion: string | null,
): Promise<KnowledgeArticle> {
  return send(
    `/api/knowledge-base/${encodeURIComponent(id)}`,
    "PATCH",
    expectedVersion ? { ...input, expectedVersion } : input,
    "Couldn't reach the dashboard server. Your changes weren't saved; check your connection and try again.",
  );
}

/** Activates or deactivates an article. Never deletes anything. */
export function setArticleActive(id: string, active: boolean): Promise<KnowledgeArticle> {
  return send(
    `/api/knowledge-base/${encodeURIComponent(id)}`,
    "PATCH",
    { active },
    "Couldn't reach the dashboard server. The article wasn't changed; check your connection and try again.",
  );
}
