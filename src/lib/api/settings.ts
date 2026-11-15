import { requestJson, TicketsApiError } from "@/lib/api/tickets";
import type { SettingsStatus } from "@/lib/settings-status";

/** Browser-side client for GET /api/settings/status. Pure fetching. */
export async function fetchSettingsStatus(signal?: AbortSignal): Promise<SettingsStatus> {
  const { body, status } = await requestJson("/api/settings/status", signal);
  const b = body as Partial<SettingsStatus> | null;
  if (
    !b ||
    !Array.isArray(b.workspace) ||
    !Array.isArray(b.integrations) ||
    !Array.isArray(b.application) ||
    !Array.isArray(b.notifications)
  ) {
    throw new TicketsApiError("The server returned data in an unexpected format.", {
      code: "invalid_response",
      status,
    });
  }
  return b as SettingsStatus;
}
