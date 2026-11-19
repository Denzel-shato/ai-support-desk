import { connection, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { parseSettingsUpdate } from "@/lib/dashboard-settings";
import { readDashboardSettings, writeDashboardSettings } from "@/lib/firestore-settings";
import { readJsonBody } from "@/lib/request-guard";
import { responseErrorResponse } from "@/lib/response-api-errors";
import { errorResponse, NO_STORE } from "@/lib/ticket-api-errors";

/**
 * GET /api/settings   -> { settings }   (defaults fill anything missing or invalid)
 * PUT /api/settings   Body: { timeZone, autoRefreshMinutes, defaultSort }
 *
 * Dashboard preferences only. Secrets and server configuration are never read or written here
 * (see /api/settings/status for the read-only system status). Same-origin JSON, signed-in users,
 * strict validation (422 with per-field messages, nothing is saved when anything is invalid).
 */
export async function GET(request: Request) {
  await connection();
  try {
    await requireAuth(request);
    return NextResponse.json({ settings: await readDashboardSettings() }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return responseErrorResponse(error, "api/settings");
  }
}

export async function PUT(request: Request) {
  await connection();
  try {
    const session = await requireAuth(request);
    const parsed = parseSettingsUpdate(await readJsonBody(request, { maxBytes: 2048 }));
    if (!parsed.ok) {
      return errorResponse(422, "validation_failed", "Some settings need attention. Nothing was saved.", {
        fields: parsed.errors as Record<string, string>,
      });
    }
    const settings = await writeDashboardSettings(parsed.value, session.sub);
    return NextResponse.json({ settings }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return responseErrorResponse(error, "api/settings");
  }
}
