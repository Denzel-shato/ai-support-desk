import { connection, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { createKnowledgeArticle, listKnowledgeArticlesPage } from "@/lib/firestore-knowledge-base";
import { knowledgeErrorResponse } from "@/lib/knowledge-api-errors";
import { parseArticleCreate } from "@/lib/knowledge-base";
import { readJsonBody } from "@/lib/request-guard";
import { errorResponse, NO_STORE, TRUNCATED_HEADER } from "@/lib/ticket-api-errors";

/**
 * GET /api/knowledge-base
 * Read-only. Returns every `knowledge_base` document as a JSON array (active
 * first), or `{ error: { code, message } }` with a matching status.
 */
export async function GET(request: Request) {
  await connection();

  try {
    await requireAuth(request);
    const { articles, truncated } = await listKnowledgeArticlesPage();
    return NextResponse.json(articles, {
      status: 200,
      headers: truncated ? { ...NO_STORE, [TRUNCATED_HEADER]: "true" } : NO_STORE,
    });
  } catch (error) {
    return knowledgeErrorResponse(error, "api/knowledge-base");
  }
}

/**
 * POST /api/knowledge-base
 * Body: { title, category, keywords?, content, active?, requestId? }
 * Validates on the server, then creates ONE new document. With a `requestId`
 * (a UUID per form submission) that is the document ID, so repeating the same
 * request returns the same article instead of creating another; otherwise the
 * ID is auto-generated. 409 `duplicate_article` when the same title already
 * exists in the category. 201 `{ article }`; 422 `validation_failed` with per-field messages;
 * 415/413/400/403 from the request guard. Checks run before Firestore is touched.
 */
export async function POST(request: Request) {
  await connection();

  try {
    await requireAuth(request);
    const body = await readJsonBody(request);
    const parsed = parseArticleCreate(body);
    if (!parsed.ok) {
      return errorResponse(
        422,
        "validation_failed",
        "Some fields need attention. Nothing was saved.",
        { fields: parsed.errors as Record<string, string> },
      );
    }
    const article = await createKnowledgeArticle(parsed.value, parsed.requestId);
    return NextResponse.json({ article }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return knowledgeErrorResponse(error, "api/knowledge-base", { write: true });
  }
}
