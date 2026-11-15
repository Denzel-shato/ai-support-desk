"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSettingsStatus } from "@/lib/api/settings";
import { TicketsApiError } from "@/lib/api/tickets";
import type { SettingsStatus } from "@/lib/settings-status";

/**
 * Loads the measured system status. Same pattern as `useTickets`: `status`
 * stays null until a real load succeeds, and a failed re-check keeps the last
 * real data.
 */
export interface UseSettingsStatusResult {
  status: SettingsStatus | null;
  error: TicketsApiError | null;
  loading: boolean;
  /** True while a manual re-check is in flight. */
  checking: boolean;
  recheck: () => void;
}

function toApiError(error: unknown): TicketsApiError {
  return error instanceof TicketsApiError
    ? error
    : new TicketsApiError("Something went wrong while checking the system.", {
        code: "unknown_error",
      });
}

export function useSettingsStatus(): UseSettingsStatusResult {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [error, setError] = useState<TicketsApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const request = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;

    fetchSettingsStatus(current.signal)
      .then((data) => {
        if (current.signal.aborted) return;
        setStatus(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (current.signal.aborted) return;
        setError(toApiError(err));
      })
      .finally(() => {
        if (current.signal.aborted) return;
        setLoading(false);
        setChecking(false);
      });
  }, []);

  useEffect(() => {
    request();
    return () => controller.current?.abort();
  }, [request]);

  const recheck = useCallback(() => {
    setChecking(true);
    request();
  }, [request]);

  return { status, error, loading, checking, recheck };
}
