"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchTicket, TicketsApiError } from "@/lib/api/tickets";
import type { SupportTicketRecord } from "@/lib/types";

/**
 * Loads a single ticket from /api/tickets/[id]. Mirrors `useTickets`:
 * `ticket` stays null until a real load succeeds, and errors (including
 * `ticket_not_found`) are reported rather than replaced with placeholder data.
 * Render with `key={id}` so a different ID starts from a clean state.
 */
export interface UseTicketResult {
  ticket: SupportTicketRecord | null;
  error: TicketsApiError | null;
  loading: boolean;
  retrying: boolean;
  retry: () => void;
}

function toApiError(error: unknown): TicketsApiError {
  return error instanceof TicketsApiError
    ? error
    : new TicketsApiError("Something went wrong while loading this ticket.", {
        code: "unknown_error",
      });
}

export function useTicket(id: string): UseTicketResult {
  const [ticket, setTicket] = useState<SupportTicketRecord | null>(null);
  const [error, setError] = useState<TicketsApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const request = useCallback(() => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;

    fetchTicket(id, current.signal)
      .then((data) => {
        if (current.signal.aborted) return;
        setTicket(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (current.signal.aborted) return;
        setError(toApiError(err));
      })
      .finally(() => {
        if (current.signal.aborted) return;
        setLoading(false);
        setRetrying(false);
      });
  }, [id]);

  useEffect(() => {
    request();
    return () => controller.current?.abort();
  }, [request]);

  const retry = useCallback(() => {
    setRetrying(true);
    request();
  }, [request]);

  return { ticket, error, loading, retrying, retry };
}
