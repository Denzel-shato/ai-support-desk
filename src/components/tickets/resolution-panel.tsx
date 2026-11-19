"use client";

import { CheckCircle2, Loader2, RotateCcw, AlertTriangle } from "lucide-react";
import { useDashboardSettings } from "@/components/settings/settings-context";
import { Button } from "@/components/ui/button";
import { useResolution } from "@/hooks/use-resolution";
import { formatDateTime } from "@/lib/ticket-detail";
import type { SupportTicketRecord } from "@/lib/types";

/**
 * "Mark as resolved" / "Reopen ticket" for the ticket page. Explicit, confirmed,
 * and never emails the customer. Whether the ticket WAS escalated is shown in
 * the escalation section; this only reflects whether it is resolved now.
 */
export function ResolutionPanel({
  ticket,
  onTicketChange,
}: {
  ticket: SupportTicketRecord;
  onTicketChange: (ticket: SupportTicketRecord) => void;
}) {
  const { timeZone } = useDashboardSettings().settings;
  const r = useResolution(ticket, onTicketChange);
  const { view } = r;
  const busy = r.busy !== null;
  const when = (iso: string | null) => formatDateTime(iso, timeZone);

  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4">
      {view.resolved ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md bg-[#E5F2EB] px-3 py-2.5 text-[13px] text-[#1F6B45]"
        >
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">Resolved</p>
            <p className="text-xs">
              {view.resolvedAt ? `On ${when(view.resolvedAt)}` : "Resolution date not recorded"}
              {view.resolvedBy ? ` by ${view.resolvedBy}` : ""}.
              {view.wasEscalated ? " This ticket was escalated; that history is kept." : ""}
            </p>
          </div>
        </div>
      ) : view.resolveBlockedReason ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md bg-[#FDF3DC] px-3 py-2.5 text-[13px] text-[#8A5A00]"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>{view.resolveBlockedReason}</p>
        </div>
      ) : null}

      {r.confirming ? (
        <div
          role="group"
          aria-label={r.confirming === "resolve" ? "Confirm resolving this ticket" : "Confirm reopening this ticket"}
          className="flex flex-wrap items-center gap-2 rounded-md border border-border-strong bg-surface-muted px-3 py-2.5 text-[13px]"
        >
          <span className="mr-auto">
            {r.confirming === "resolve"
              ? "Mark this ticket as resolved? No email will be sent to the customer."
              : "Reopen this ticket? The earlier resolution stays in the history."}
          </span>
          <Button type="button" onClick={r.confirm} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : r.confirming === "resolve" ? <CheckCircle2 /> : <RotateCcw />}
            {busy
              ? r.confirming === "resolve"
                ? "Resolving…"
                : "Reopening…"
              : r.confirming === "resolve"
                ? "Yes, mark as resolved"
                : "Yes, reopen"}
          </Button>
          <Button type="button" variant="outline" onClick={r.cancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      ) : view.resolved ? (
        <Button type="button" variant="outline" onClick={() => r.ask("reopen")} disabled={busy || !view.canReopen}>
          <RotateCcw />
          Reopen ticket
        </Button>
      ) : (
        <Button type="button" onClick={() => r.ask("resolve")} disabled={busy || !view.canResolve}>
          <CheckCircle2 />
          Mark as resolved
        </Button>
      )}

      {r.feedback && (
        <p
          role={r.feedback.kind === "error" ? "alert" : "status"}
          className={
            r.feedback.kind === "error"
              ? "text-[13px] text-[#9E2A20]"
              : "text-[13px] text-[#1F6B45]"
          }
        >
          {r.feedback.message}
        </p>
      )}
    </div>
  );
}
