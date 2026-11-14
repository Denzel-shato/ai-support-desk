"use client";

import { useCallback, useMemo, useState } from "react";
import { reviewResponse, sendResponse } from "@/lib/api/ticket-response";
import { fetchTicket, TicketsApiError } from "@/lib/api/tickets";
import {
  buildResponseWorkspace,
  MAX_RESPONSE_LENGTH,
  normalizeResponseText,
  sendBlockedReason,
  validateResponseText,
  type ResponseWorkspaceView,
} from "@/lib/response-workflow";
import type { SupportTicketRecord } from "@/lib/types";

/**
 * State and actions for the response editor on the ticket page.
 *
 * The ticket itself is owned by the parent; this hook reports every server
 * answer through `onTicketChange`, so the page always shows what is stored.
 * The editor text is local. It follows the stored baseline (saved final
 * response, else the original AI response) unless the agent has unsaved edits.
 */

export type BusyAction = "approve" | "reject" | "reopen" | "send" | "refresh";

export interface Feedback {
  kind: "success" | "error" | "info";
  message: string;
}

export interface ResponseWorkspaceState {
  view: ResponseWorkspaceView;
  text: string;
  setText: (value: string) => void;
  /** Editor text differs from the stored baseline. */
  dirty: boolean;
  /** Editor text is the original AI response (nothing to restore). */
  matchesOriginal: boolean;
  textError: string | null;
  busy: BusyAction | null;
  feedback: Feedback | null;
  confirmingSend: boolean;
  /** Why sending is unavailable right now, or null. */
  sendBlocked: string | null;
  approve: () => void;
  reject: () => void;
  reopen: () => void;
  restoreOriginal: () => void;
  askToSend: () => void;
  cancelSend: () => void;
  confirmSend: () => void;
  refresh: () => void;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof TicketsApiError ? error.message : fallback;
}

export function useResponseWorkspace(
  ticket: SupportTicketRecord,
  onTicketChange: (ticket: SupportTicketRecord) => void,
): ResponseWorkspaceState {
  const view = useMemo(() => buildResponseWorkspace(ticket), [ticket]);

  const [text, setText] = useState(view.baseline);
  const [syncedBaseline, setSyncedBaseline] = useState(view.baseline);
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [confirmingSend, setConfirmingSend] = useState(false);

  // Follow the stored baseline (adjust state during render, not in an effect).
  // Unsaved edits are kept unless the text was untouched or the ticket is locked.
  if (view.baseline !== syncedBaseline) {
    setSyncedBaseline(view.baseline);
    if (view.locked || normalizeResponseText(text) === normalizeResponseText(syncedBaseline)) {
      setText(view.baseline);
    }
  }

  const dirty = normalizeResponseText(text) !== normalizeResponseText(view.baseline);
  const matchesOriginal =
    view.original.text !== null &&
    normalizeResponseText(text) === normalizeResponseText(view.original.text);

  const validation = validateResponseText(text);
  const textError = validation.ok
    ? null
    : text.length > 0 && text.trim().length === 0
      ? "The response can't be empty."
      : text.length === 0
        ? "The response can't be empty."
        : validation.message;

  const sendBlocked = sendBlockedReason(view, text);

  const refetch = useCallback(async () => {
    try {
      onTicketChange(await fetchTicket(ticket.id));
    } catch {
      // Keep what's on screen; the feedback message already explains the failure.
    }
  }, [ticket.id, onTicketChange]);

  const run = useCallback(
    async (action: BusyAction, task: () => Promise<void>) => {
      setBusy(action);
      setFeedback(null);
      try {
        await task();
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const review = useCallback(
    (action: "approve" | "reject" | "reopen") =>
      run(action, async () => {
        const sendText =
          action === "approve" ? text : action === "reopen" && dirty ? text : undefined;
        if (sendText !== undefined) {
          const v = validateResponseText(sendText);
          if (!v.ok) {
            setFeedback({ kind: "error", message: v.message });
            return;
          }
        }
        try {
          const updated = await reviewResponse(ticket.id, action, sendText);
          onTicketChange(updated);
          setConfirmingSend(false);
          setFeedback({
            kind: "success",
            message:
              action === "approve"
                ? "Response approved. It has not been sent yet."
                : action === "reject"
                  ? "Response rejected. Nothing was sent, and the original AI response is unchanged."
                  : "Response submitted for review again.",
          });
        } catch (error) {
          setFeedback({
            kind: "error",
            message: messageOf(error, "Couldn't save your decision. Nothing was changed."),
          });
          if (error instanceof TicketsApiError && error.status === 409) await refetch();
        }
      }),
    [run, text, dirty, ticket.id, onTicketChange, refetch],
  );

  const confirmSend = useCallback(
    () =>
      run("send", async () => {
        setConfirmingSend(false);
        try {
          const result = await sendResponse(ticket.id);
          if (result.ticket) onTicketChange(result.ticket);
          else await refetch();
          setFeedback(
            result.result === "sent"
              ? {
                  kind: result.warning ? "info" : "success",
                  message: result.warning ?? "Delivery confirmed. The response was sent to the customer.",
                }
              : {
                  kind: "info",
                  message:
                    result.message ??
                    "The send was accepted but delivery isn't confirmed yet. Use Check status before retrying.",
                },
          );
        } catch (error) {
          setFeedback({
            kind: "error",
            message: messageOf(error, "The response was not sent. You can try again."),
          });
          // The server may have recorded "failed" or "queued"; show what's stored.
          await refetch();
        }
      }),
    [run, ticket.id, onTicketChange, refetch],
  );

  const refresh = useCallback(
    () =>
      run("refresh", async () => {
        try {
          onTicketChange(await fetchTicket(ticket.id));
          setFeedback({ kind: "info", message: "Status refreshed." });
        } catch (error) {
          setFeedback({
            kind: "error",
            message: messageOf(error, "Couldn't refresh the status."),
          });
        }
      }),
    [run, ticket.id, onTicketChange],
  );

  const setEditorText = useCallback((value: string) => {
    setText(value.slice(0, MAX_RESPONSE_LENGTH + 1));
    setFeedback(null);
    setConfirmingSend(false);
  }, []);

  return {
    view,
    text,
    setText: setEditorText,
    dirty,
    matchesOriginal,
    textError,
    busy,
    feedback,
    confirmingSend,
    sendBlocked,
    approve: () => void review("approve"),
    reject: () => void review("reject"),
    reopen: () => void review("reopen"),
    restoreOriginal: () => {
      if (view.original.text !== null) setEditorText(view.original.text);
    },
    askToSend: () => setConfirmingSend(true),
    cancelSend: () => setConfirmingSend(false),
    confirmSend: () => void confirmSend(),
    refresh: () => void refresh(),
  };
}
