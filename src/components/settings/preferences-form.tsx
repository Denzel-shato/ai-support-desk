"use client";

import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useMemo, useReducer } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { saveDashboardSettings } from "@/lib/api/dashboard-settings";
import { TicketsApiError } from "@/lib/api/tickets";
import { DEFAULT_SETTINGS, REFRESH_MINUTES, type DashboardSettings } from "@/lib/dashboard-settings";
import { canSave, initialFormState, isDirty, settingsFormReducer } from "@/lib/settings-form";
import { useDashboardSettings } from "./settings-context";

const FALLBACK_ZONES = ["UTC", "Africa/Harare", "Africa/Johannesburg", "Africa/Lagos", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Asia/Kolkata", "Asia/Singapore", "Australia/Sydney"];

function zoneList(current: string): string[] {
  let zones: string[] = FALLBACK_ZONES;
  try {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone");
    if (all?.length) zones = all;
  } catch {
    /* use the fallback list */
  }
  return current !== "auto" && !zones.includes(current) ? [...zones, current].sort() : zones;
}

function Field({ label, hint, error, htmlFor, children }: { label: string; hint: string; error?: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1.5 py-3 first:pt-0 last:pb-0 sm:grid-cols-[220px_minmax(0,1fr)] sm:gap-4">
      <label htmlFor={htmlFor} className="text-[13px] font-medium sm:pt-1.5">
        {label}
      </label>
      <div>
        {children}
        <p id={`${htmlFor}-hint`} className="mt-1.5 text-xs text-muted-foreground">
          {hint}
        </p>
        {error && (
          <p role="alert" className="mt-1 text-xs text-[#9E2A20]">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

/** The saved preferences. Edits stay in the form until Save succeeds; a failed save keeps them. */
export function PreferencesForm() {
  const { settings, loaded, loadError, reload, applySaved } = useDashboardSettings();
  const [state, dispatch] = useReducer(settingsFormReducer, settings, initialFormState);

  useEffect(() => {
    if (loaded) dispatch({ type: "loaded", value: settings });
  }, [loaded, settings]);

  const zones = useMemo(() => zoneList(state.draft.timeZone), [state.draft.timeZone]);
  const dirty = isDirty(state);
  const saving = state.status === "saving";

  async function save() {
    dispatch({ type: "save-started" });
    try {
      const stored = await saveDashboardSettings(state.draft);
      applySaved(stored);
      dispatch({ type: "save-succeeded", value: stored });
    } catch (error) {
      const e = error instanceof TicketsApiError ? error : null;
      dispatch({ type: "save-failed", message: e?.message ?? "Couldn't save your settings. Your changes are still here.", fields: e?.fields });
    }
  }

  const set = (patch: Partial<DashboardSettings>) => dispatch({ type: "edit", patch });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave(state)) void save();
      }}
      noValidate
    >
      {loadError && !loaded && (
        <div role="alert" className="mb-4 flex flex-wrap items-start gap-2 rounded-md border border-[#F0C9C5] bg-[#FBEAE8] px-3 py-2 text-[13px] text-[#9E2A20]">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1">
            Couldn&apos;t load your saved settings ({loadError.message}) Defaults are in use. Saving will replace whatever is stored.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={reload}>
            Retry
          </Button>
        </div>
      )}

      <div className="divide-y divide-border">
        <Field label="Time zone" htmlFor="pref-tz" error={state.fields.timeZone} hint="Used for the greeting and for every date and time shown in the dashboard. Automatic follows this device.">
          <Select id="pref-tz" className="max-w-sm" value={state.draft.timeZone} onChange={(e) => set({ timeZone: e.target.value })} disabled={saving}>
            <option value="auto">Automatic (this device)</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Refresh ticket lists" htmlFor="pref-refresh" error={state.fields.autoRefreshMinutes} hint="Reloads the overview, tickets and escalations in the background while this tab is visible. Manual Refresh always works.">
          <Select id="pref-refresh" className="max-w-sm" value={String(state.draft.autoRefreshMinutes)} onChange={(e) => set({ autoRefreshMinutes: Number(e.target.value) as DashboardSettings["autoRefreshMinutes"] })} disabled={saving}>
            {REFRESH_MINUTES.map((m) => (
              <option key={m} value={m}>
                {m === 0 ? "Never (manual only)" : `Every ${m} ${m === 1 ? "minute" : "minutes"}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Default ticket order" htmlFor="pref-sort" error={state.fields.defaultSort} hint="The order the All tickets page opens in. You can still change it there at any time.">
          <Select id="pref-sort" className="max-w-sm" value={state.draft.defaultSort} onChange={(e) => set({ defaultSort: e.target.value as DashboardSettings["defaultSort"] })} disabled={saving}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </Select>
        </Field>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button type="submit" disabled={!canSave(state)}>
          {saving && <Loader2 className="animate-spin" aria-hidden />}
          {saving ? "Saving…" : "Save changes"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => dispatch({ type: "discard" })} disabled={!dirty || saving}>
          Discard changes
        </Button>
        <Button type="button" variant="ghost" onClick={() => dispatch({ type: "reset-defaults" })} disabled={saving || JSON.stringify(state.draft) === JSON.stringify(DEFAULT_SETTINGS)}>
          Reset to defaults
        </Button>
        <div aria-live="polite" className="min-w-0 text-[13px]">
          {state.status === "saved" && (
            <span className="inline-flex items-center gap-1.5 text-[#1F6B45]">
              <CheckCircle2 className="size-4" aria-hidden /> {state.message}
            </span>
          )}
          {state.status === "error" && (
            <span role="alert" className="inline-flex items-start gap-1.5 text-[#9E2A20]">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {state.message} Your changes are still here.
            </span>
          )}
          {state.status === "idle" && dirty && <span className="text-muted-foreground">Unsaved changes</span>}
        </div>
      </div>
    </form>
  );
}
