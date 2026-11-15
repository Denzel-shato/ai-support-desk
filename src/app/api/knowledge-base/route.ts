import { connection, NextResponse } from "next/server";
import { createKnowledgeArticle, listKnowledgeArticles } from "@/lib/firestore-knowledge-base";
import { knowledgeErrorResponse } from "@/lib/knowledge-api-errors";
import { validateArticleInput } from "@/lib/knowledge-base";
import { readJsonBody } from "@/lib/request-guard";
import { errorResponse, NO_STORE } from "@/lib/ticket-api-errors";

/**
 * GET /api/knowledge-base
 * Read-only. Returns every `knowledge_base` document as a JSON array (active
 * first), or `{ error: { code, message } }` with a matching status.
 */
export async function GET() {
  await connection();

  try {
    const articles = await listKnowledgeArticles();
    return NextResponse.json(articles, { status: 200, headers: NO_STORE });
  } catch (error) {
    return knowledgeErrorResponse(error, "api/knowledge-base");
  }
}

/**
 * POST /api/knowledge-base
 * Body: { title, category, keywords?, content, active? }
 * Validates on the server, then creates ONE new document with an auto-generated
 * ID. 201 `{ article }`; 422 `validation_failed` with per-field messages;
 * 415/413/400/403 from the request guard. Checks run before Firestore is touched.
 */
export async function POST(request: Request) {
  await connection();

  try {
    const body = await readJsonBody(request);
    const parsed = validateArticleInput(body);
    if (!parsed.ok) {
      return errorResponse(
        422,
        "validation_failed",
        "Some fields need attention. Nothing was saved.",
        { fields: parsed.errors as Record<string, string> },
      );
    }
    const article = await createKnowledgeArticle(parsed.value);
    return NextResponse.json({ article }, { status: 201, headers: NO_STORE });
  } catch (error) {
    return knowledgeErrorResponse(error, "api/knowledge-base", { write: true });
  }
}
