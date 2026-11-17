"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchMessages,
  reconcileFollowUpSend,
  sendFollowUp,
} from "@/lib/api/ticket-response";
import { TicketsApiError } from "@/lib/api/tickets";
import {
  buildHistory,
  type FollowUpMessage,
  type HistoryEntry,
} from "@/lib/communications";
import { validateResponseText, type ReconcileOutcome } from "@/lib/response-workflow";
import type { SupportTicketRecord } from "@/lib/types";
import type { Feedback } from "./use-response-workspace";

/**
 * Follow-up composer and communication history for one ticket.
 *
 * Each draft gets one message ID (the server's idempotency key), created when
 * the agent first presses Send and kept until the server has taken the
 * message. Pressing Send twice, or retrying after a dropped connection,
 * therefore can't produce two emails.
 */

export interface CommunicationsState {
  history: HistoryEntry[];
  loading: boolean;
  /** Set when the follow-up list couldn't be loaded. */
  loadError: string | null;
  text: string;
  setText: (value: string) => void;
  textError: string | null;
  /** "compose", "refresh", or the ID of the message being retried. */
  busy: string | null;
  feedback: Feedback | null;
  send: () => void;
  /** `anyway`: resend an unsettled message after the agent confirmed (duplicate possible). */
  retry: (messageId: string, anyway?: boolean) => void;
  reconcile: (messageId: string, outcome: ReconcileOutcome) => void;
  refresh: () => void;
}

/** Server answers that mean "the message exists on the server": stop re-sending the draft text. */
const MESSAGE_STORED = new Set([
  "delivery_failed",
  "delivery_unknown",
  "delivery_unconfirmed",
  "already_sent",
  "send_in_progress",
]);

function msg(error: unknown, fallback: string): string {
  return error instanceof TicketsApiError ? error.message : fallback;
}

export function useCommunications(ticket: SupportTicketRecord): CommunicationsState {
  const ticketId = ticket.id;
  const [messages, setMessages] = useState<FollowUpMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setTextState] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const draftId = useRef<string | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) =>
      fetchMessages(ticketId, signal)
        .then((list) => {
          if (signal?.aborted) return;
          setMessages(list);
          setLoadError(null);
        })
        .catch((error: unknown) => {
          if (signal?.aborted) return;
          setLoadError(msg(error, "Couldn't load the follow-up history."));
        })
        .finally(() => {
          if (!signal?.aborted) setLoading(false);
        }),
    [ticketId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const history = useMemo(() => buildHistory(ticket, messages), [ticket, messages]);

  const validation = validateResponseText(text);
  const textError =
    validation.ok || text.length === 0
      ? null
      : text.trim().length === 0
        ? "The message can't be empty."
        : validation.message;

  const setText = useCallback((value: string) => {
    setTextState(value);
    setFeedback(null);
  }, []);

  const send = useCallback(async () => {
    const v = validateResponseText(text);
    if (!v.ok) {
      setFeedback({
        kind: "error",
        message: v.code === "empty_response" ? "The message can't be empty." : v.message,
      });
      return;
    }
    draftId.current ??= crypto.randomUUID();
    const id = draftId.current;
    setBusy("compose");
    setFeedback(null);
    try {
      const result = await sendFollowUp(ticketId, id, v.text);
      draftId.current = null;
      setTextState("");
      setFeedback(
        result.result === "sent"
          ? {
              kind: result.warning ? "info" : "success",
              message: result.warning ?? "Follow-up sent. Delivery confirmed.",
            }
          : {
              kind: "info",
              message:
                result.note ??
                "The follow-up was accepted but delivery isn't confirmed. Check its status below before retrying.",
            },
      );
    } catch (error) {
      if (error instanceof TicketsApiError && MESSAGE_STORED.has(error.code)) {
        // The server holds this message now; manage it from the history.
        draftId.current = null;
        setTextState("");
      }
      setFeedback({
        kind: "error",
        message: msg(error, "The follow-up was not sent. You can try again."),
      });
    } finally {
      setBusy(null);
      await load();
    }
  }, [text, ticketId, load]);

  const retry = useCallback(
    async (messageId: string, anyway = false) => {
      setBusy(messageId);
      setFeedback(null);
      try {
        const result = await sendFollowUp(ticketId, messageId, undefined, {
          retryUnknown: anyway,
        });
        setFeedback(
          result.result === "sent"
            ? { kind: "success", message: "Follow-up sent. Delivery confirmed." }
            : { kind: "info", message: result.note ?? "Delivery isn't confirmed yet." },
        );
      } catch (error) {
        setFeedback({ kind: "error", message: msg(error, "The follow-up was not sent.") });
      } finally {
        setBusy(null);
        await load();
      }
    },
    [ticketId, load],
  );

  const reconcile = useCallback(
    async (messageId: string, outcome: ReconcileOutcome) => {
      setBusy(messageId);
      setFeedback(null);
      try {
        await reconcileFollowUpSend(ticketId, messageId, outcome);
        setFeedback({
          kind: "success",
          message:
            outcome === "delivered"
              ? "Recorded as delivered (confirmed by you)."
              : "Recorded as not delivered. You can send it again.",
        });
      } catch (error) {
        setFeedback({ kind: "error", message: msg(error, "Couldn't record that.") });
      } finally {
        setBusy(null);
        await load();
      }
    },
    [ticketId, load],
  );

  const refresh = useCallback(async () => {
    setBusy("refresh");
    setFeedback(null);
    await load();
    setBusy(null);
  }, [load]);

  return {
    history,
    loading,
    loadError,
    text,
    setText,
    textError,
    busy,
    feedback,
    send: () => void send(),
    retry: (id, anyway) => void retry(id, anyway),
    reconcile: (id, outcome) => void reconcile(id, outcome),
    refresh: () => void refresh(),
  };
}
