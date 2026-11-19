"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { fetchDashboardSettings } from "@/lib/api/dashboard-settings";
import { TicketsApiError } from "@/lib/api/tickets";
import { DEFAULT_SETTINGS, type DashboardSettings } from "@/lib/dashboard-settings";

/**
 * Loads the saved preferences once for the whole dashboard. Until they arrive (or if loading fails)
 * the defaults apply, so no page ever waits on or breaks because of settings.
 */
interface SettingsContextValue {
  settings: DashboardSettings;
  /** True once the saved values (not just the defaults) are in. */
  loaded: boolean;
  loadError: TicketsApiError | null;
  reload: () => void;
  /** Called by the settings page after a successful save. */
  applySaved: (value: DashboardSettings) => void;
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  loadError: null,
  reload: () => undefined,
  applySaved: () => undefined,
});

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<DashboardSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<TicketsApiError | null>(null);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    fetchDashboardSettings(current.signal)
      .then((value) => {
        if (current.signal.aborted) return;
        setSettings(value);
        setLoaded(true);
        setLoadError(null);
      })
      .catch((err: unknown) => {
        if (current.signal.aborted) return;
        setLoadError(
          err instanceof TicketsApiError ? err : new TicketsApiError("Couldn't load your saved settings.", { code: "unknown_error" }),
        );
      });
  }, []);

  useEffect(() => {
    load();
    return () => controller.current?.abort();
  }, [load]);

  const applySaved = useCallback((value: DashboardSettings) => {
    setSettings(value);
    setLoaded(true);
    setLoadError(null);
  }, []);

  const value = useMemo(() => ({ settings, loaded, loadError, reload: load, applySaved }), [settings, loaded, loadError, load, applySaved]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useDashboardSettings(): SettingsContextValue {
  return useContext(SettingsContext);
}
