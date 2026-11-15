import { requestJson, TicketsApiError } from "@/lib/api/tickets";
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
