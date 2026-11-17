"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Info,
  Loader2,
  RotateCcw,
  Send,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useCommunications } from "@/hooks/use-communications";
import type { HistoryEntry } from "@/lib/communications";
import { formatDateTime } from "@/lib/ticket-detail";
import {
  MAX_RESPONSE_LENGTH,
  type ReconcileOutcome,
  type ResponseStatus,
} from "@/lib/response-workflow";
import type { SupportTicketRecord } from "@/lib/types";

const STATUS_PILL: Record<ResponseStatus, { label: string; bg: string; fg: string }> = {
  draft: { label: "Draft", bg: "#EEF0F2", fg: "#4B5563" },
  sending: { label: "Sending…", bg: "#FDF3DC", fg: "#8A5A00" },
  queued: { label: "Awaiting confirmation", bg: "#FDF3DC", fg: "#8A5A00" },
  sent: { label: "Sent", bg: "#E5F2EB", fg: "#1F6B45" },
  failed: { label: "Failed", bg: "#FBEAE8", fg: "#9E2A20" },
  unknown: { label: "Delivery unknown", bg: "#FDF3DC", fg: "#8A5A00" },
};

function HistoryItem({
  entry,
  busy,
  onRetry,
  onReconcile,
  onRefresh,
}: {
  entry: HistoryEntry;
  busy: string | null;
  onRetry: (id: string, anyway?: boolean) => void;
  onReconcile: (id: string, outcome: ReconcileOutcome) => void;
  onRefresh: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const pill = entry.status ? STATUS_PILL[entry.status] : null;
  const when = formatDateTime(entry.sentAt ?? entry.createdAt);
  const isFollowUp = entry.type === "follow_up";
  const retrying = busy === entry.id;

  return (
    <li className="rounded-md border border-border px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-medium text-foreground">{entry.label}</span>
          <span className="text-subtle-foreground">
            {entry.source === "ai" ? "AI" : "Agent"}
          </span>
          {pill && <Badge style={{ backgroundColor: pill.bg, color: pill.fg }}>{pill.label}</Badge>}
          {entry.type === "ai_response" && (
            <span className="text-subtle-foreground">Not emailed by this dashboard</span>
          )}
        </div>
        <span className="text-[11px] text-subtle-foreground">
          {entry.sentAt && when ? `Sent ${when}` : when ? `Created ${when}` : "Time not recorded"}
        </span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed">{entry.content}</p>
      {(entry.status === "failed" || entry.status === "unknown" || entry.status === "queued") &&
        entry.error && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-[#9E2A20]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {entry.error}
        </p>
      )}
      {isFollowUp && entry.status === "sending" && (
        <p className="mt-2 flex items-center gap-1 text-xs text-[#8A5A00]">
          <Clock className="size-3.5" aria-hidden />
          Being sent right now.
          <Button type="button" size="sm" variant="ghost" onClick={onRefresh} disabled={busy !== null}>
            <RotateCcw />
            Check status
          </Button>
        </p>
      )}
      {isFollowUp && entry.status === "failed" && (
        <div className="mt-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onRetry(entry.id)}
            disabled={busy !== null}
          >
            {retrying ? <Loader2 className="animate-spin" aria-hidden /> : <Send />}
            {retrying ? "Sending…" : "Retry send"}
          </Button>
        </div>
      )}
      {isFollowUp && (entry.status === "queued" || entry.status === "unknown") && (
        <div className="mt-2 space-y-2">
          <p className="flex items-start gap-1.5 text-xs text-[#8A5A00]">
            <Clock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {entry.status === "queued"
              ? "Accepted, but delivery isn't confirmed."
              : "We can't tell whether this was delivered."}{" "}
            Check the customer&apos;s mail, then record what happened. Sending again
            without checking could deliver it twice.
          </p>
          {confirming ? (
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="mr-auto">The customer may receive this twice. Send again?</span>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setConfirming(false);
                  onRetry(entry.id, true);
                }}
                disabled={busy !== null}
              >
                <Send />
                Yes, send again
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={onRefresh} disabled={busy !== null}>
                <RotateCcw />
                Check status
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onReconcile(entry.id, "delivered")}
                disabled={busy !== null}
              >
                {retrying ? <Loader2 className="animate-spin" aria-hidden /> : <CheckCircle2 />}
                It was delivered
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onReconcile(entry.id, "not_delivered")}
                disabled={busy !== null}
              >
                It was not delivered
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setConfirming(true)}
                disabled={busy !== null}
              >
                Send again anyway…
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Follow-up composer and communication history. Shown for every ticket. */
export function CommunicationsPanel({ ticket }: { ticket: SupportTicketRecord }) {
  const c = useCommunications(ticket);
  const sending = c.busy === "compose";
  const disabled = c.busy !== null;
  const trimmed = c.text.trim().length;
  const hasEmail =
    typeof ticket.customerEmail === "string" && ticket.customerEmail.trim().length > 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>Follow-up and communication history</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <label htmlFor="follow-up" className="text-xs font-medium text-muted-foreground">
              New follow-up message
            </label>
            <span
              className={`text-[11px] ${trimmed > MAX_RESPONSE_LENGTH ? "text-[#9E2A20]" : "text-subtle-foreground"}`}
            >
              {trimmed.toLocaleString("en-US")} / {MAX_RESPONSE_LENGTH.toLocaleString("en-US")}
            </span>
          </div>
          <Textarea
            id="follow-up"
            className="mt-1.5 min-h-28"
            value={c.text}
            disabled={disabled}
            onChange={(e) => c.setText(e.target.value)}
            aria-invalid={c.textError ? true : undefined}
            aria-describedby={c.textError ? "follow-up-error" : undefined}
            placeholder="Write a message to the customer…"
          />
          {c.textError && (
            <p id="follow-up-error" className="mt-1 text-xs text-[#9E2A20]">
              {c.textError}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button
              type="button"
              onClick={c.send}
              disabled={disabled || trimmed === 0 || trimmed > MAX_RESPONSE_LENGTH || !hasEmail}
            >
              {sending ? <Loader2 className="animate-spin" aria-hidden /> : <Send />}
              {sending ? "Sending…" : "Send follow-up"}
            </Button>
            <span className="text-xs text-muted-foreground">
              {hasEmail
                ? "Sent from the server to the customer email on this ticket. This is always a new message."
                : "This ticket has no customer email address."}
            </span>
          </div>
        </div>

        <div aria-live="polite">
          {c.feedback && (
            <p
              className={`flex items-start gap-2 rounded-md px-3 py-2 text-[13px] ${
                c.feedback.kind === "error"
                  ? "bg-[#FBEAE8] text-[#9E2A20]"
                  : c.feedback.kind === "success"
                    ? "bg-[#E5F2EB] text-[#1F6B45]"
                    : "bg-surface-muted text-muted-foreground"
              }`}
            >
              {c.feedback.kind === "error" ? (
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              ) : c.feedback.kind === "success" ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
              ) : (
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              )}
              {c.feedback.message}
            </p>
          )}
        </div>

        <div className="border-t border-border pt-4">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">Communication history</h3>
          {c.loading ? (
            <p className="text-[13px] text-subtle-foreground">Loading history…</p>
          ) : (
            <>
              {c.loadError && (
                <div
                  role="alert"
                  className="mb-2 flex flex-wrap items-center gap-2 rounded-md bg-[#FBEAE8] px-3 py-2 text-[13px] text-[#9E2A20]"
                >
                  <AlertTriangle className="size-4 shrink-0" aria-hidden />
                  <span className="mr-auto">
                    Follow-ups couldn&apos;t be loaded: {c.loadError}
                  </span>
                  <Button type="button" size="sm" variant="outline" onClick={c.refresh} disabled={disabled}>
                    Retry
                  </Button>
                </div>
              )}
              {c.history.length === 0 ? (
                <p className="text-[13px] text-subtle-foreground">No messages yet.</p>
              ) : (
                <ol className="space-y-2">
                  {c.history.map((entry) => (
                    <HistoryItem
                      key={entry.id}
                      entry={entry}
                      busy={c.busy}
                      onRetry={c.retry}
                      onReconcile={c.reconcile}
                      onRefresh={c.refresh}
                    />
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
