import { connection } from "next/server";
import { handleOverviewRequest } from "@/lib/ticket-list-api";

/**
 * GET /api/overview?tz=Area/City[&fresh=1]
 * Read-only aggregate statistics over every ticket (not the loaded page), plus
 * the newest few tickets. See firestore-ticket-stats.ts.
 */
export async function GET(request: Request) {
  await connection();
  return handleOverviewRequest(request);
}
