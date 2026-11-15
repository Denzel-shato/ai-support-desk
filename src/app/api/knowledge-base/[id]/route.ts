import { connection, NextResponse } from "next/server";
import {
  InvalidArticleIdError,
  updateKnowledgeArticle,
} from "@/lib/firestore-knowledge-base";
import { isValidDocumentId } from "@/lib/firestore-tickets";
import { knowledgeErrorResponse } from "@/lib/knowledge-api-errors";
import { parseArticleUpdate } from "@/lib/knowledge-base";
import { readJsonBody } from "@/lib/request-guard";
import { errorResponse, NO_STORE } from "@/lib/ticket-api-errors";

/**
 * PATCH /api/knowledge-base/[id]
 * Body: either `{ active: boolean }` (activate / deactivate) or the full edit
 * `{ title, category, keywords, content, active? }`.
 *
 * Updates the existing document in place: the ID is unchanged, nothing is
 * created (404 `article_not_found` if it doesn't exist) and nothing is deleted.
 * There is intentionally no DELETE: deactivating is the safe alternative.
 * Order of checks: id, request guard, body validation (422 with per-field
 * messages), then Firestore. 200 `{ article }`.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await connection();

  try {
    const { id } = await context.params;
    if (!isValidDocumentId(id)) throw new InvalidArticleIdError();

    const body = await readJsonBody(request);
    const parsed = parseArticleUpdate(body);
    if (!parsed.ok) {
      return errorResponse(
        422,
        "validation_failed",
        "Some fields need attention. Nothing was changed.",
        { fields: parsed.errors as Record<string, string> },
      );
    }
    const article = await updateKnowledgeArticle(id, parsed.update);
    return NextResponse.json({ article }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return knowledgeErrorResponse(error, "api/knowledge-base/[id]", { write: true });
  }
}
