"use client";

import { useDashboardSettings } from "@/components/settings/settings-context";
import { formatDateTime } from "@/lib/ticket-detail";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { PriorityBadge } from "@/components/overview/priority-badge";
import { StatusBadge } from "@/components/overview/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTicket } from "@/hooks/use-ticket";
import { approvalRequired } from "@/lib/response-workflow";
import { buildTicketDetail, type TicketDetailView } from "@/lib/ticket-detail";
import type { SupportTicketRecord } from "@/lib/types";
import { CommunicationsPanel } from "./communications-panel";
import { ResponseWorkspace } from "./response-workspace";
import { TicketDetailError, TicketDetailSkeleton } from "./ticket-detail-states";

/* -------------------------------------------------------------------------- */
/*  Small presentational helpers                                              */
/* -------------------------------------------------------------------------- */

function NotRecorded({ children = "Not recorded" }: { children?: string }) {
  return <span className="text-subtle-foreground">{children}</span>;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-[13px] leading-relaxed">{children}</dd>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function TextBlock({ value }: { value: string | null }) {
  return value ? (
    <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{value}</p>
  ) : (
    <NotRecorded />
  );
}

function BulletList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <NotRecorded>{empty}</NotRecorded>;
  return (
    <ul className="list-disc space-y-1 pl-4 marker:text-subtle-foreground">
      {items.map((item, i) => (
        <li key={i} className="whitespace-pre-wrap">
          {item}
        </li>
      ))}
    </ul>
  );
}

function YesNo({ value }: { value: boolean | null }) {
  if (value === null) return <NotRecorded />;
  return value ? (
    <Badge style={{ backgroundColor: "#FBEAE8", color: "#9E2A20" }}>Yes</Badge>
  ) : (
    <Badge style={{ backgroundColor: "#E5F2EB", color: "#1F6B45" }}>No</Badge>
  );
}

/* -------------------------------------------------------------------------- */
/*  Page content                                                              */
/* -------------------------------------------------------------------------- */

function TicketDetailBody({
  t,
  ticket,
  onTicketChange,
}: {
  t: TicketDetailView;
  ticket: SupportTicketRecord;
  onTicketChange: (ticket: SupportTicketRecord) => void;
}) {
  const { timeZone } = useDashboardSettings().settings;
  const createdLabel = formatDateTime(t.createdAt, timeZone);
  const escalatedLabel = formatDateTime(t.escalatedAt, timeZone);
  const hasKb =
    t.kbStatus ||
    t.relevantSection ||
    t.coverageReason ||
    t.supportedSteps.length > 0 ||
    t.unsupportedParts.length > 0;

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <h2 className="max-w-3xl text-xl font-semibold leading-snug tracking-tight">
          {t.title}
        </h2>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <PriorityBadge priority={t.priority} />
          <StatusBadge status={t.status} />
          <span className="text-xs text-muted-foreground">
            {createdLabel ? `Created ${createdLabel}` : "Creation date not recorded"}
          </span>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Section title="Customer message">
            <TextBlock value={t.message} />
          </Section>

          <ResponseWorkspace ticket={ticket} onTicketChange={onTicketChange} />

          <CommunicationsPanel ticket={ticket} />

          <Section title="AI analysis">
            <dl className="space-y-4">
              <Field label="Summary">
                <TextBlock value={t.summary} />
              </Field>
              <Field label="Classification reason">
                <TextBlock value={t.reason} />
              </Field>
            </dl>
          </Section>

          <Section title="Knowledge-base evaluation">
            {hasKb ? (
              <dl className="space-y-4">
                <Field label="KB status">
                  {t.kbStatus ?? <NotRecorded />}
                </Field>
                <Field label="Relevant section">
                  <TextBlock value={t.relevantSection} />
                </Field>
                <Field label="Coverage reason">
                  <TextBlock value={t.coverageReason} />
                </Field>
                <Field label="Supported troubleshooting steps">
                  <BulletList
                    items={t.supportedSteps}
                    empty="None recorded"
                  />
                </Field>
                <Field label="Unsupported parts">
                  <BulletList items={t.unsupportedParts} empty="None recorded" />
                </Field>
              </dl>
            ) : (
              <NotRecorded>
                No knowledge-base evaluation was recorded for this ticket.
              </NotRecorded>
            )}
          </Section>

        </div>

        <div className="space-y-4">
          <Section title="Customer">
            <dl className="space-y-4">
              <Field label="Name">{t.customerName ?? <NotRecorded />}</Field>
              <Field label="Email">
                {t.customerEmail ? (
                  <a
                    href={`mailto:${t.customerEmail}`}
                    className="break-all hover:text-accent"
                  >
                    {t.customerEmail}
                  </a>
                ) : (
                  <NotRecorded />
                )}
              </Field>
            </dl>
          </Section>

          <Section title="Ticket">
            <dl className="space-y-4">
              <Field label="Ticket ID">
                <span className="break-all">{t.id}</span>
              </Field>
              <Field label="Created">
                {createdLabel ?? <NotRecorded />}
              </Field>
              <Field label="Status">
                <StatusBadge status={t.status} />
                {t.storedStatus && (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Stored status: {t.storedStatus}
                  </span>
                )}
              </Field>
              <Field label="Priority">
                <PriorityBadge priority={t.priority} />
              </Field>
              <Field label="Category">{t.category ?? <NotRecorded />}</Field>
              <Field label="Sentiment">{t.sentiment ?? <NotRecorded />}</Field>
            </dl>
          </Section>

          <Section title="Escalation and review">
            <dl className="space-y-4">
              <Field label="Escalation required">
                <YesNo value={t.escalationRequired} />
              </Field>
              <Field label="Escalation status">
                {t.escalationStatus ?? <NotRecorded />}
              </Field>
              <Field label="Escalation reason">
                <TextBlock value={t.escalationReason} />
              </Field>
              {escalatedLabel && (
                <Field label="Escalated at">{escalatedLabel}</Field>
              )}
              {/* Low/Medium ignore any stored reviewStatus (n8n sets it on those too). */}
              {!approvalRequired(t) ? (
                <Field label="Review status">Not required</Field>
              ) : (
                t.reviewStatus && <Field label="Review status">{t.reviewStatus}</Field>
              )}
            </dl>
          </Section>
        </div>
      </div>
    </div>
  );
}

function TicketDetailContent({ id }: { id: string }) {
  const { ticket: loaded, error, loading, retrying, retry } = useTicket(id);
  // Newer copy returned by the review/send routes; wins over the first load.
  const [override, setOverride] = useState<SupportTicketRecord | null>(null);
  const ticket = override ?? loaded;
  const view = useMemo(() => (ticket ? buildTicketDetail(ticket) : null), [ticket]);

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2.5">
        <Link href="/tickets">
          <ArrowLeft />
          All tickets
        </Link>
      </Button>

      {loading && <TicketDetailSkeleton />}
      {!loading && !view && error && (
        <TicketDetailError error={error} onRetry={retry} retrying={retrying} />
      )}
      {view && ticket && (
        <TicketDetailBody t={view} ticket={ticket} onTicketChange={setOverride} />
      )}
    </div>
  );
}

/** Reads the [id] segment, then renders under a key so each ticket starts clean. */
export function TicketDetail() {
  const params = useParams<{ id: string }>();
  const raw = params.id;
  let id = raw;
  try {
    id = decodeURIComponent(raw);
  } catch {
    // Keep the raw segment if it isn't valid percent-encoding.
  }
  return <TicketDetailContent key={id} id={id} />;
}
