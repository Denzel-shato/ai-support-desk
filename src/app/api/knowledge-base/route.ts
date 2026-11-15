import { connection, NextResponse } from "next/server";
import { listKnowledgeArticles } from "@/lib/firestore-knowledge-base";
import { knowledgeErrorResponse } from "@/lib/knowledge-api-errors";
import { NO_STORE } from "@/lib/ticket-api-errors";

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
