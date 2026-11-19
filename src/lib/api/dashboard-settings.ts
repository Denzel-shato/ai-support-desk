import { redirectIfSignedOut, requestJson, TicketsApiError } from "@/lib/api/tickets";
import { settingsFromStored, type DashboardSettings } from "@/lib/dashboard-settings";

/** Browser-side client for /api/settings. Pure fetching. */

function readSettings(body: unknown, status: number): DashboardSettings {
  const s = (body as { settings?: unknown } | null)?.settings;
  if (typeof s !== "object" || s === null) {
    throw new TicketsApiError("The server returned data in an unexpected format.", { code: "invalid_response", status });
  }
  return settingsFromStored(s as Record<string, unknown>);
}

export async function fetchDashboardSettings(signal?: AbortSignal): Promise<DashboardSettings> {
  const { body, status } = await requestJson("/api/settings", signal);
  return readSettings(body, status);
}

export async function saveDashboardSettings(value: DashboardSettings): Promise<DashboardSettings> {
  let response: Response;
  try {
    response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
      cache: "no-store",
    });
  } catch {
    throw new TicketsApiError("Couldn't reach the dashboard server. Your changes are still here; try saving again.", { code: "network_error" });
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  redirectIfSignedOut(response);
  if (!response.ok) {
    const err = (body as { error?: { message?: unknown; code?: unknown; fields?: unknown } } | null)?.error;
    throw new TicketsApiError(typeof err?.message === "string" ? err.message : `The server returned an unexpected error (HTTP ${response.status}).`, {
      code: typeof err?.code === "string" ? err.code : "unknown_error",
      status: response.status,
      fields: typeof err?.fields === "object" && err.fields !== null ? (err.fields as Record<string, string>) : {},
    });
  }
  return readSettings(body, response.status);
}
