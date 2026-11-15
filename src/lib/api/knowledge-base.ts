import { requestJson, TicketsApiError } from "@/lib/api/tickets";
import type { ArticleInput } from "@/lib/knowledge-base";
import type { KnowledgeArticle } from "@/lib/types";

/** Browser-side client for GET /api/knowledge-base. Pure fetching. */
export async function fetchKnowledgeArticles(
  signal?: AbortSignal,
): Promise<KnowledgeArticle[]> {
  const { body, status } = await requestJson("/api/knowledge-base", signal);
  if (!Array.isArray(body)) {
    throw new TicketsApiError("The server returned data in an unexpected format.", {
      code: "invalid_response",
      status,
    });
  }
  return body as KnowledgeArticle[];
}

/** Creates an article. Throws TicketsApiError (with `fields` for validation errors). */
export async function createKnowledgeArticle(
  input: ArticleInput,
): Promise<KnowledgeArticle> {
  let response: Response;
  try {
    response = await fetch("/api/knowledge-base", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      cache: "no-store",
    });
  } catch {
    throw new TicketsApiError(
      "Couldn't reach the dashboard server. Your article wasn't saved; check your connection and try again.",
      { code: "network_error" },
    );
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
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
