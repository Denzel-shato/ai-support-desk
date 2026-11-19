import type {
  ActivityPoint,
  Metric,
  OverviewData,
  Priority,
  PriorityShare,
  SupportTicketRecord,
  Ticket,
  TicketStatus,
} from "./types";

/**
 * Pure functions that turn raw Firestore tickets into what the Overview page
 * shows. No React, no fetching, no Date.now(): `now` is always passed in, so
 * everything here is deterministic and easy to test.
 */

/* -------------------------------------------------------------------------- */
/*  Normalisation                                                             */
/* -------------------------------------------------------------------------- */

/** "Awaiting Review" / "awaiting-review" -> "awaiting_review". */
function key(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function humanize(value: string): string {
  const spaced = value.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

/** Statuses that mean the ticket is finished. Anything else counts as open. */
const CLOSED_STATUSES = new Set([
  "resolved",
  "closed",
  "completed",
  "done",
  "auto_resolved",
]);

/** True when a stored `status` value means "finished" (any spelling/case). */
export function isClosedStatus(value: unknown): boolean {
  return CLOSED_STATUSES.has(key(value));
}

const PRIORITY_ALIASES: Record<string, Priority> = {
  urgent: "urgent",
  critical: "urgent",
  high: "high",
  medium: "medium",
  moderate: "medium",
  normal: "medium",
  low: "low",
};

export function normalizePriority(value: unknown): Priority {
  return PRIORITY_ALIASES[key(value)] ?? "unspecified";
}

/* -------------------------------------------------------------------------- */
/*  Ticket predicates (the single source of truth for the metric cards)       */
/* -------------------------------------------------------------------------- */

/**
 * HISTORICAL: the workflow flagged this ticket for a person. It stays true
 * after the ticket is resolved (`escalationStatus` is never rewritten), so
 * "was it ever escalated?" and "is it still outstanding?" stay separate
 * questions. Use `isActiveEscalation` for the latter.
 */
export function isEscalated(t: SupportTicketRecord): boolean {
  return key(t.escalationStatus) === "required";
}

/**
 * The ONE rule for "needs a human before anything is emailed", shared with the
 * n8n intake workflow (n8n/code/build-ticket.js implements the same rule).
 * Only Low and Medium priority tickets may be handled automatically, and only
 * while nothing contradicts it. Human review is required for:
 *  - High, Urgent, missing or unrecognised priority (no aliases: "normal" or
 *    "critical" are NOT accepted as Low/Medium here);
 *  - `escalationRequired: true`, or `kbStatus: "not_covered"`: the knowledge
 *    base doesn't support an automatic answer;
 *  - `intakeIssue` set: automatic processing failed, so there is no trustworthy
 *    classification or response.
 * Never decided by the stored `reviewStatus`: n8n writes "awaiting_review" on
 * every ticket.
 */
export interface ApprovalInput {
  priority?: unknown;
  kbStatus?: unknown;
  escalationRequired?: unknown;
  intakeIssue?: unknown;
}

export function approvalRequired(t: ApprovalInput): boolean {
  const p = key(t.priority);
  if (p !== "low" && p !== "medium") return true;
  if (t.escalationRequired === true || key(t.escalationRequired) === "true") return true;
  if (key(t.kbStatus) === "not_covered") return true;
  if (typeof t.intakeIssue === "string" && t.intakeIssue.trim()) return true;
  return false;
}

/**
 * Waiting on a human decision. Only tickets that need approval can be: a Low
 * or Medium ticket carrying a legacy "awaiting_review" is not waiting for
 * anyone, so it is not counted or labelled as such. A resolved ticket is not
 * waiting for anyone either (its stored `reviewStatus` is kept as history).
 */
export function isAwaitingReview(t: SupportTicketRecord): boolean {
  return (
    approvalRequired(t) &&
    key(t.reviewStatus) === "awaiting_review" &&
    !isResolved(t)
  );
}

export function isResolved(t: SupportTicketRecord): boolean {
  return isClosedStatus(t.status);
}

/** Escalated and not yet resolved: what still needs a person's attention. */
export function isActiveEscalation(t: SupportTicketRecord): boolean {
  return isEscalated(t) && !isResolved(t);
}

/** Not resolved. Includes escalated and awaiting-review tickets. */
export function isOpen(t: SupportTicketRecord): boolean {
  return !isResolved(t);
}

/**
 * One status per ticket for the table, using a fixed precedence. "Resolved"
 * comes first: a finished ticket is finished whether or not it was once
 * escalated or reviewed (those facts are kept on the ticket as history).
 */
export function displayStatus(t: SupportTicketRecord): TicketStatus {
  if (isResolved(t)) return "resolved";
  if (isEscalated(t)) return "escalated";
  if (isAwaitingReview(t)) return "awaiting_review";
  if (key(t.status) === "new") return "new";
  return "open";
}

function createdAtMs(t: SupportTicketRecord): number | null {
  if (!t.createdAt) return null;
  const ms = Date.parse(t.createdAt);
  return Number.isNaN(ms) ? null : ms;
}

/* -------------------------------------------------------------------------- */
/*  Dates                                                                     */
/* -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;
const LOCALE = "en-GB";

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function shortDate(date: Date): string {
  return date.toLocaleDateString(LOCALE, { day: "numeric", month: "short" });
}

export function formatSubmitted(iso: string | null, now: Date): string {
  if (!iso) return "Unknown date";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "Unknown date";

  const diff = now.getTime() - ms;
  if (diff < 60_000) return "Just now";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < DAY_MS) return `${Math.floor(diff / (60 * 60_000))} hr ago`;
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)} d ago`;

  const date = new Date(ms);
  return date.getFullYear() === now.getFullYear()
    ? shortDate(date)
    : `${shortDate(date)} ${date.getFullYear()}`;
}

/* -------------------------------------------------------------------------- */
/*  Table rows                                                                */
/* -------------------------------------------------------------------------- */

const KB_LABELS: Record<string, string> = {
  covered: "KB covered",
  fully_covered: "KB covered",
  partial: "KB partial",
  partially_covered: "KB partial",
  not_covered: "Not in KB",
  uncovered: "Not in KB",
};

/**
 * What we show as the "AI classification": the sentiment the AI detected,
 * with its knowledge-base coverage as secondary detail. Change this one
 * function if you would rather show a different field.
 */
function classify(t: SupportTicketRecord): { label: string; detail?: string } {
  const sentiment = text(t.sentiment);
  const kbRaw = text(t.kbStatus);
  const kb = kbRaw ? (KB_LABELS[key(kbRaw)] ?? humanize(kbRaw)) : undefined;

  if (sentiment) return { label: humanize(sentiment), detail: kb };
  if (kb) return { label: kb };
  return { label: "Not classified" };
}

export function toTicketRow(t: SupportTicketRecord, now: Date): Ticket {
  const { label, detail } = classify(t);
  const message = text(t.message);
  return {
    id: t.id,
    subject: text(t.summary) ?? (message ? truncate(message, 90) : "No summary"),
    customer: text(t.customerName) ?? "Unknown customer",
    customerEmail: text(t.customerEmail) ?? "No email",
    category: text(t.category) ? humanize(text(t.category)!) : "Uncategorised",
    priority: normalizePriority(t.priority),
    aiClassification: label,
    aiDetail: detail,
    status: displayStatus(t),
    createdAt: t.createdAt ?? null,
    submittedLabel: formatSubmitted(t.createdAt ?? null, now),
  };
}

/* -------------------------------------------------------------------------- */
/*  Metrics                                                                   */
/* -------------------------------------------------------------------------- */

function share(count: number, total: number): string {
  if (total === 0) return "0% of all tickets";
  const pct = (count / total) * 100;
  if (count > 0 && pct < 1) return "<1% of all tickets";
  return `${Math.round(pct)}% of all tickets`;
}

export function buildMetrics(
  tickets: SupportTicketRecord[],
  now: Date,
): Metric[] {
  const total = tickets.length;
  const open = tickets.filter(isOpen).length;
  const everEscalated = tickets.filter(isEscalated);
  const escalated = everEscalated.filter(isActiveEscalation).length;
  const resolvedEscalations = everEscalated.length - escalated;
  const awaiting = tickets.filter(isAwaitingReview).length;

  const since = now.getTime() - 7 * DAY_MS;
  const lastWeek = tickets.filter((t) => {
    const ms = createdAtMs(t);
    return ms !== null && ms >= since && ms <= now.getTime();
  }).length;

  return [
    {
      id: "total",
      label: "Total tickets",
      description: "Every ticket in the support desk",
      value: total,
      footer: `${lastWeek.toLocaleString("en-US")} in the last 7 days`,
    },
    {
      id: "open",
      label: "Open tickets",
      description: "Not yet resolved",
      value: open,
      footer: share(open, total),
    },
    {
      id: "escalated",
      // Currently active only: a resolved escalation stays in the history
      // (Escalations page) but is no longer outstanding.
      label: "Active escalations",
      description: "Escalated and not yet resolved",
      value: escalated,
      footer: `${resolvedEscalations.toLocaleString("en-US")} resolved of ${everEscalated.length.toLocaleString("en-US")} escalated`,
    },
    {
      id: "awaiting_review",
      label: "Awaiting review",
      description: "Waiting for a person to review",
      value: awaiting,
      footer: share(awaiting, total),
    },
  ];
}

/* -------------------------------------------------------------------------- */
/*  Priority distribution                                                     */
/* -------------------------------------------------------------------------- */

const PRIORITY_ORDER: Priority[] = [
  "urgent",
  "high",
  "medium",
  "low",
  "unspecified",
];

export function buildPriorityDistribution(
  tickets: SupportTicketRecord[],
): PriorityShare[] {
  const counts = new Map<Priority, number>();
  for (const t of tickets) {
    const p = normalizePriority(t.priority);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return PRIORITY_ORDER.map((priority) => ({
    priority,
    count: counts.get(priority) ?? 0,
  })).filter(
    // Always show the four real priorities; show "unspecified" only if used.
    (row) => row.priority !== "unspecified" || row.count > 0,
  );
}

/* -------------------------------------------------------------------------- */
/*  Activity                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Seven consecutive local days of ticket volume from real creation dates.
 *
 * The window ends today if any ticket is from the last 7 days. Otherwise it
 * ends on the day of the newest ticket, so older demo data still shows its
 * real dates instead of an empty chart. Days with no tickets are genuine zeros.
 */
export function buildActivity(
  tickets: SupportTicketRecord[],
  now: Date,
): {
  points: ActivityPoint[];
  rangeLabel: string | null;
  total: number;
  undated: number;
} {
  const dated = tickets
    .map((t) => ({ t, ms: createdAtMs(t) }))
    .filter((row): row is { t: SupportTicketRecord; ms: number } => row.ms !== null);
  const undated = tickets.length - dated.length;

  if (dated.length === 0) {
    return { points: [], rangeLabel: null, total: 0, undated };
  }

  const newest = Math.max(...dated.map((row) => row.ms));
  const windowStartForNow = startOfLocalDay(now).getTime() - 6 * DAY_MS;
  const anchor =
    newest >= windowStartForNow
      ? new Date(Math.max(newest, now.getTime()))
      : new Date(newest);

  const end = startOfLocalDay(anchor);
  const days: Date[] = [];
  for (let i = 6; i >= 0; i--) {
    days.push(new Date(end.getFullYear(), end.getMonth(), end.getDate() - i));
  }

  const buckets = new Map<string, { received: number; escalated: number }>(
    days.map((d) => [dayKey(d), { received: 0, escalated: 0 }]),
  );

  let total = 0;
  for (const { t, ms } of dated) {
    const bucket = buckets.get(dayKey(new Date(ms)));
    if (!bucket) continue;
    bucket.received += 1;
    if (isEscalated(t)) bucket.escalated += 1;
    total += 1;
  }

  const points = days.map((d) => {
    const bucket = buckets.get(dayKey(d))!;
    return {
      day: d.toLocaleDateString(LOCALE, { weekday: "short" }),
      dateLabel: d.toLocaleDateString(LOCALE, {
        weekday: "short",
        day: "numeric",
        month: "short",
      }),
      received: bucket.received,
      escalated: bucket.escalated,
    };
  });

  return {
    points,
    rangeLabel: `${shortDate(days[0])} – ${shortDate(days[6])}`,
    total,
    undated,
  };
}

/* -------------------------------------------------------------------------- */
/*  Entry point                                                               */
/* -------------------------------------------------------------------------- */

export const RECENT_TICKET_COUNT = 7;

export function deriveOverview(
  tickets: SupportTicketRecord[],
  now: Date,
): OverviewData {
  const activity = buildActivity(tickets, now);
  return {
    metrics: buildMetrics(tickets, now),
    activity: activity.points,
    activityRangeLabel: activity.rangeLabel,
    activityTotal: activity.total,
    undatedCount: activity.undated,
    priorityDistribution: buildPriorityDistribution(tickets),
    priorityTotal: tickets.length,
    // The API already sorts newest-first; keep that order.
    recent: tickets.slice(0, RECENT_TICKET_COUNT).map((t) => toTicketRow(t, now)),
    total: tickets.length,
  };
}
