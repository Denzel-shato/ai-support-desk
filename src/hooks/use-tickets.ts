"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTickets, TicketsApiError } from "@/lib/api/tickets";
import type { SupportTicketRecord } from "@/lib/types";

/**
 * Loads tickets from /api/tickets and exposes a refresh action.
 *
 * - `tickets` is null until the first successful load. It never holds mock
 *   data: when a request fails, the error is reported instead.
 * - A failed refresh keeps the last real data (and `updatedAt`) so the page
 *   can say "couldn't refresh" without blanking out.
 */
export interface UseTicketsResult {
  tickets: SupportTicketRecord[] | null;
  error: TicketsApiError | null;
  /** True during the very first load. */
  loading: boolean;
  /** True while a manual refresh is in flight. */
  refreshing: boolean;
  /** When the current data was fetched. */
  updatedAt: Date | null;
  refresh: () => void;
}

function toApiError(error: unknown): TicketsApiError {
  return error instanceof TicketsApiError
    ? error
    : new TicketsApiError("Something went wrong while loading tickets.", {
        code: "unknown_error",
      });
}

export function useTickets(): UseTicketsResult {
  const [tickets, setTickets] = useState<SupportTicketRecord[] | null>(null);
  const [error, setError] = useState<TicketsApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const controller = useRef<AbortController | null>(null);

  /** Starts a request, cancelling any one still in flight. */
  const request = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;

    fetchTickets(current.signal)
      .then((data) => {
        if (current.signal.aborted) return;
        setTickets(data);
        setUpdatedAt(new Date());
        setError(null);
      })
      .catch((err: unknown) => {
        if (current.signal.aborted) return;
        setError(toApiError(err));
      })
      .finally(() => {
        if (current.signal.aborted) return;
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    request();
    return () => controller.current?.abort();
  }, [request]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    request();
  }, [request]);

  return { tickets, error, loading, refreshing, updatedAt, refresh };
}
