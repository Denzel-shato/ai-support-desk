"use client";

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Info,
  Loader2,
  RotateCcw,
  Send,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { useResponseWorkspace } from "@/hooks/use-response-workspace";
import {
  approvalRequired,
  buildResponseWorkspace,
  MAX_RESPONSE_LENGTH,
  type ResponseStatus,
  type ResponseWorkspaceView,
  type ReviewStatus,
} from "@/lib/response-workflow";
import type { SupportTicketRecord } from "@/lib/types";

const REVIEW_PILL: Record<ReviewStatus | "none", { label: string; bg: string; fg: string }> = {
  awaiting_review: { label: "Awaiting review", bg: "#FDF3DC", fg: "#8A5A00" },
  approved: { label: "Approved", bg: "#E5F2EB", fg: "#1F6B45" },
  rejected: { label: "Rejected", bg: "#FBEAE8", fg: "#9E2A20" },
  none: { label: "Not reviewed", bg: "#EEF0F2", fg: "#4B5563" },
};

const DELIVERY_PILL: Record<ResponseStatus | "none", { label: string; bg: string; fg: string }> = {
  draft: { label: "Draft", bg: "#EEF0F2", fg: "#4B5563" },
  queued: { label: "Sending…", bg: "#FDF3DC", fg: "#8A5A00" },
  sent: { label: "Sent", bg: "#E5F2EB", fg: "#1F6B45" },
  failed: { label: "Failed", bg: "#FBEAE8", fg: "#9E2A20" },
  none: { label: "Not sent", bg: "#EEF0F2", fg: "#4B5563" },
};

function Pill({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return <Badge style={{ backgroundColor: bg, color: fg }}>{label}</Badge>;
}

function Spinner() {
  return <Loader2 className="animate-spin" aria-hidden />;
}

/** Original AI response (and the other field, if different). Read-only. */
function OriginalResponse({ view }: { view: ResponseWorkspaceView }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          Original AI response
        </h3>
        {view.original.source && (
          <span className="text-[11px] text-subtle-foreground">
            From <code>{view.original.source}</code> · read-only, always kept
          </span>
        )}
      </div>
      {view.original.text ? (
        <p className="mt-1.5 whitespace-pre-wrap rounded-md border border-border bg-surface-muted px-3 py-2.5 text-[13px] leading-relaxed">
          {view.original.text}
        </p>
      ) : (
        <p className="mt-1.5 text-[13px] text-subtle-foreground">
          No AI response was recorded for this ticket.
        </p>
      )}
      {view.original.other && (
        <details className="mt-2 text-[13px]">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Additional AI output (<code>{view.original.other.source}</code>)
          </summary>
          <p className="mt-1.5 whitespace-pre-wrap rounded-md border border-border bg-surface-muted px-3 py-2.5 leading-relaxed">
            {view.original.other.text}
          </p>
        </details>
      )}
    </div>
  );
}

/**
 * Low and Medium tickets: no approval step. The AI response is for reference,
 * and any stored `reviewStatus` is deliberately ignored here (the n8n normal
 * branch sets "awaiting_review" on these tickets too).
 */
function AutoHandledResponse({ ticket }: { ticket: SupportTicketRecord }) {
  const view = buildResponseWorkspace(ticket);
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 pb-2">
        <CardTitle>AI response</CardTitle>
        <Pill label="Approval not required" bg="#EEF0F2" fg="#4B5563" />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-2 rounded-md bg-surface-muted px-3 py-2.5 text-[13px]">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <p className="font-medium">Initial acknowledgement: sent automatically</p>
            <p className="text-xs text-muted-foreground">
              The existing n8n workflow sends the acknowledgement email. The AI
              response below is for your reference: this dashboard does not send
              it. To write to the customer, use a follow-up message below.
            </p>
          </div>
        </div>
        <OriginalResponse view={view} />
      </CardContent>
    </Card>
  );
}

/** Adapts to priority: approval workflow for High/Urgent, read-only otherwise. */
export function ResponseWorkspace({
  ticket,
  onTicketChange,
}: {
  ticket: SupportTicketRecord;
  onTicketChange: (ticket: SupportTicketRecord) => void;
}) {
  return approvalRequired(ticket.priority) ? (
    <ApprovalWorkspace ticket={ticket} onTicketChange={onTicketChange} />
  ) : (
    <AutoHandledResponse ticket={ticket} />
  );
}

function ApprovalWorkspace({
  ticket,
  onTicketChange,
}: {
  ticket: SupportTicketRecord;
  onTicketChange: (ticket: SupportTicketRecord) => void;
}) {
  const w = useResponseWorkspace(ticket, onTicketChange);
  const { view } = w;

  const busy = w.busy !== null;
  const editable = !view.locked && !busy;
  const approved = view.reviewStatus === "approved";
  const rejected = view.reviewStatus === "rejected";
  const failed = view.responseStatus === "failed";
  const queued = view.responseStatus === "queued";
  const sent = view.responseStatus === "sent";
  const tooLong = w.text.trim().length > MAX_RESPONSE_LENGTH;

  const noOriginal = view.original.text === null && view.savedFinal === null;
  const canDecide = editable && !w.textError;

  const reviewPill = REVIEW_PILL[view.reviewStatus ?? "none"];
  const deliveryPill = DELIVERY_PILL[view.responseStatus ?? "none"];

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 pb-2">
        <CardTitle>AI response</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Pill {...reviewPill} />
          <Pill {...deliveryPill} />
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <OriginalResponse view={view} />

        {/* Editor */}
        <div>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <label
              htmlFor="final-response"
              className="text-xs font-medium text-muted-foreground"
            >
              Final response (what the customer will receive)
            </label>
            <span className="flex items-center gap-3 text-[11px] text-subtle-foreground">
              {w.dirty && !view.locked && (
                <span className="text-[#8A5A00]">Unsaved changes</span>
              )}
              <span className={tooLong ? "text-[#9E2A20]" : undefined}>
                {w.text.trim().length.toLocaleString("en-US")} /{" "}
                {MAX_RESPONSE_LENGTH.toLocaleString("en-US")}
              </span>
            </span>
          </div>
          <Textarea
            id="final-response"
            className="mt-1.5"
            value={w.text}
            disabled={!editable}
            onChange={(e) => w.setText(e.target.value)}
            aria-invalid={w.textError ? true : undefined}
            aria-describedby={w.textError ? "final-response-error" : undefined}
            placeholder="Write the reply the customer should receive…"
          />
          {w.textError && !view.locked && (
            <p id="final-response-error" className="mt-1 text-xs text-[#9E2A20]">
              {w.textError}
            </p>
          )}
          {!view.locked && view.original.text !== null && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-1.5 -ml-2"
              onClick={w.restoreOriginal}
              disabled={!editable || w.matchesOriginal}
            >
              <RotateCcw />
              Restore original
            </Button>
          )}
        </div>

        {/* Review actions */}
        {!view.locked && (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={w.approve} disabled={!canDecide || noOriginal && !w.text.trim()}>
              {w.busy === "approve" ? <Spinner /> : <Check />}
              {w.busy === "approve"
                ? "Approving…"
                : approved && w.dirty
                  ? "Approve changes"
                  : approved
                    ? "Approved"
                    : "Approve"}
            </Button>
            {!rejected ? (
              <Button type="button" variant="outline" onClick={w.reject} disabled={!editable}>
                {w.busy === "reject" ? <Spinner /> : <X />}
                {w.busy === "reject" ? "Rejecting…" : "Reject"}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={w.reopen}
                disabled={!editable || (w.dirty && !!w.textError)}
              >
                {w.busy === "reopen" ? <Spinner /> : <RotateCcw />}
                {w.busy === "reopen" ? "Submitting…" : "Submit for review again"}
              </Button>
            )}
          </div>
        )}

        {/* Sending */}
        <div className="border-t border-border pt-4">
          {sent ? (
            <div
              role="status"
              className="flex items-start gap-2 rounded-md bg-[#E5F2EB] px-3 py-2.5 text-[13px] text-[#1F6B45]"
            >
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div>
                <p className="font-medium">
                  Sent{view.recipient ? ` to ${view.recipient}` : ""}
                </p>
                <p className="text-xs">
                  {view.sentAtLabel ?? "Time not recorded"}. This response can no
                  longer be edited or sent again.
                </p>
              </div>
            </div>
          ) : queued ? (
            <div className="space-y-2">
              <div
                role="status"
                className="flex items-start gap-2 rounded-md bg-[#FDF3DC] px-3 py-2.5 text-[13px] text-[#8A5A00]"
              >
                <Clock className="mt-0.5 size-4 shrink-0" aria-hidden />
                <p>
                  A send is in progress, or was started and never confirmed. Check
                  the status before sending again, so the customer doesn&apos;t get
                  two emails.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={w.refresh} disabled={busy}>
                  {w.busy === "refresh" ? <Spinner /> : <RotateCcw />}
                  Check status
                </Button>
                {!w.sendBlocked && (
                  <Button type="button" variant="ghost" onClick={w.askToSend} disabled={busy}>
                    Retry send
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {failed && (
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md bg-[#FBEAE8] px-3 py-2.5 text-[13px] text-[#9E2A20]"
                >
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <div>
                    <p className="font-medium">The last send failed</p>
                    {view.error && <p className="text-xs">{view.error}</p>}
                  </div>
                </div>
              )}

              {w.confirmingSend ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-border-strong bg-surface-muted px-3 py-2.5 text-[13px]">
                  <span className="mr-auto">
                    Send this response to <strong className="break-all">{view.recipient}</strong>?
                  </span>
                  <Button type="button" onClick={w.confirmSend} disabled={busy}>
                    <Send />
                    Yes, send
                  </Button>
                  <Button type="button" variant="outline" onClick={w.cancelSend} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    onClick={w.askToSend}
                    disabled={busy || w.sendBlocked !== null}
                  >
                    {w.busy === "send" ? <Spinner /> : <Send />}
                    {w.busy === "send" ? "Sending…" : failed ? "Retry send" : "Send to customer"}
                  </Button>
                  {w.sendBlocked && (
                    <span className="text-xs text-muted-foreground">{w.sendBlocked}</span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Feedback for screen readers and everyone else */}
        <div aria-live="polite">
          {w.feedback && !(w.feedback.kind === "error" && w.feedback.message === view.error) && (
            <p
              className={`flex items-start gap-2 rounded-md px-3 py-2 text-[13px] ${
                w.feedback.kind === "error"
                  ? "bg-[#FBEAE8] text-[#9E2A20]"
                  : w.feedback.kind === "success"
                    ? "bg-[#E5F2EB] text-[#1F6B45]"
                    : "bg-surface-muted text-muted-foreground"
              }`}
            >
              {w.feedback.kind === "error" ? (
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              ) : w.feedback.kind === "success" ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
              ) : (
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
              )}
              {w.feedback.message}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
