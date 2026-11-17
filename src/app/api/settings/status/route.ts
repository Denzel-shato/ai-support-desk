import { connection, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { buildSettingsStatus } from "@/lib/settings-status";
import { gatherStatusFacts } from "@/lib/system-status";
import { authErrorResponse, errorResponse, NO_STORE } from "@/lib/ticket-api-errors";

/**
 * GET /api/settings/status
 * Read-only. What the Settings page shows: measured Firestore reachability and
 * counts, whether the n8n webhook is configured (never called), and build
 * information. Contains no secrets: no credentials, no webhook URL.
 */
export async function GET(request: Request) {
  await connection();
  try {
    await requireAuth(request);
    const status = buildSettingsStatus(await gatherStatusFacts());
    return NextResponse.json(status, { status: 200, headers: NO_STORE });
  } catch (error) {
    const auth = authErrorResponse(error);
    if (auth) return auth;
    console.error("[api/settings/status] Failed:", error);
    return errorResponse(500, "status_error", "Couldn't gather the system status.");
  }
}
