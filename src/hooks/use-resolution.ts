"use client";

import { useCallback, useMemo, useState } from "react";
import { changeResolution } from "@/lib/api/ticket-response";
import { fetchTicket, TicketsApiError } from "@/lib/api/tickets";
import { buildResolutionView, type ResolutionAction, type ResolutionView } from "@/lib/ticket-resolution";
import type { SupportTicketRecord } from "@/lib/types";

/**
 * State and actions for the "Mark as resolved" / "Reopen" controls.
 *
 * The ticket is owned by the page; every server answer goes back through
 * `onTicketChange`, so the page always shows what is stored. Nothing changes
 * until the agent confirms: the first click only asks.
 */

export interface ResolutionFeedback {
  kind: "success" | "error";
  message: string;
}

export interface ResolutionState {
  view: ResolutionView;
  /** The action awaiting confirmation, or null. */
  confirming: ResolutionAction | null;
  /** The request in flight, or null. */
  busy: ResolutionAction | null;
  feedback: ResolutionFeedback | null;
  ask: (action: ResolutionAction) => void;
  cancel: () => void;
  confirm: () => void;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof TicketsApiError ? error.message : fallback;
}

export function useResolution(
  ticket: SupportTicketRecord,
  onTicketChange: (ticket: SupportTicketRecord) => void,
): ResolutionState {
  const view = useMemo(() => buildResolutionView(ticket), [ticket]);
  const [confirming, setConfirming] = useState<ResolutionAction | null>(null);
  const [busy, setBusy] = useState<ResolutionAction | null>(null);
  const [feedback, setFeedback] = useState<ResolutionFeedback | null>(null);

  const confirm = useCallback(async () => {
    if (!confirming || busy) return;
    const action = confirming;
    setBusy(action);
    setFeedback(null);
    try {
      onTicketChange(await changeResolution(ticket.id, action));
      setConfirming(null);
      setFeedback({
        kind: "success",
        message:
          action === "resolve"
            ? "Ticket marked as resolved. No email was sent to the customer."
            : "Ticket reopened. The earlier resolution stays in the audit history.",
      });
    } catch (error) {
      setConfirming(null);
      setFeedback({
        kind: "error",
        message: messageOf(
          error,
          action === "resolve"
            ? "Couldn't mark the ticket as resolved. Nothing was changed."
            : "Couldn't reopen the ticket. Nothing was changed.",
        ),
      });
      // 404/409 mean the page was out of date (someone else changed the ticket,
      // or it is gone): show what is actually stored.
      if (
        error instanceof TicketsApiError &&
        (error.status === 409 || error.status === 404)
      ) {
        try {
          onTicketChange(await fetchTicket(ticket.id));
        } catch {
          // Keep what's on screen; the message above already explains the failure.
        }
      }
    } finally {
      setBusy(null);
    }
  }, [confirming, busy, ticket.id, onTicketChange]);

  return {
    view,
    confirming,
    busy,
    feedback,
    ask: (action) => {
      if (busy) return;
      setFeedback(null);
      setConfirming(action);
    },
    cancel: () => {
      if (!busy) setConfirming(null);
    },
    confirm: () => void confirm(),
  };
}
