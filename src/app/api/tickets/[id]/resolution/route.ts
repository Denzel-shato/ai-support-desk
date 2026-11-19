import { connection } from "next/server";
import { handleResolutionRequest } from "@/lib/ticket-resolution-api";

/**
 * POST /api/tickets/[id]/resolution
 * Body: { action: "resolve" | "reopen" }
 *
 * Explicitly resolves a ticket, or reopens a resolved one, and returns
 * `{ ticket }`. Only `action` is read from the body. It never sends an email,
 * never calls n8n, and never touches the escalation, review or response
 * records (see lib/ticket-resolution.ts for exactly what it writes).
 *
 * Errors: 401/503 not signed in, 400 bad ID or action, 403 cross-site,
 * 404 no such ticket, 409 not a valid transition (already resolved, not
 * resolved, email mid-send or unconfirmed), 5xx Firestore.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  await connection();
  const { id } = await context.params;
  return handleResolutionRequest(request, id);
}
