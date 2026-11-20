import { connection } from "next/server";
import { handleTicketListRequest } from "@/lib/ticket-list-api";

/**
 * GET /api/tickets?view=&limit=&cursor=&search=&priority=&category=&status=&sort=
 * Read-only, one page at a time: `{ tickets, nextCursor, hasMore, scanLimited,
 * total?, unlisted? }` or `{ error: { code, message } }`. See ticket-list-api.ts.
 */
export async function GET(request: Request) {
  // Opt out of build-time prerendering: this must run on every request.
  await connection();
  return handleTicketListRequest(request);
}
