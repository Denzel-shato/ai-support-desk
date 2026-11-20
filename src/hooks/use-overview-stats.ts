"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDashboardSettings } from "@/components/settings/settings-context";
import { fetchOverviewStats, TicketsApiError, type OverviewStatsResponse } from "@/lib/api/tickets";

/**
 * Loads the aggregate statistics from /api/overview (computed by the server
 * over every ticket, not over a loaded page). Same shape as the other loading
 * hooks: a failed refresh keeps the last real numbers on screen.
 */
export interface UseOverviewStatsResult {
  data: OverviewStatsResponse | null;
  error: TicketsApiError | null;
  loading: boolean;
  refreshing: boolean;
  updatedAt: Date | null;
  refresh: () => void;
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function useOverviewStats(): UseOverviewStatsResult {
  const [data, setData] = useState<OverviewStatsResponse | null>(null);
  const [error, setError] = useState<TicketsApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const controller = useRef<AbortController | null>(null);
  const autoRefreshMinutes = useDashboardSettings().settings.autoRefreshMinutes;

  const request = useCallback((fresh: boolean) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    // The charts bucket days in the browser's own time zone, as they always have.
    fetchOverviewStats(browserTimeZone(), { fresh, signal: current.signal })
      .then((next) => {
        if (current.signal.aborted) return;
        setData(next);
        setUpdatedAt(new Date());
        setError(null);
      })
      .catch((err: unknown) => {
        if (current.signal.aborted) return;
        setError(
          err instanceof TicketsApiError
            ? err
            : new TicketsApiError("Something went wrong while loading tickets.", { code: "unknown_error" }),
        );
      })
      .finally(() => {
        if (current.signal.aborted) return;
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    request(false);
    return () => controller.current?.abort();
  }, [request]);

  useEffect(() => {
    if (!autoRefreshMinutes) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") request(false);
    }, autoRefreshMinutes * 60_000);
    return () => clearInterval(timer);
  }, [autoRefreshMinutes, request]);

  // A manual refresh bypasses the server's short cache.
  const refresh = useCallback(() => {
    setRefreshing(true);
    request(true);
  }, [request]);

  return { data, error, loading, refreshing, updatedAt, refresh };
}
