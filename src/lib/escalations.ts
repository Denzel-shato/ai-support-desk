import {
  displayStatus,
  formatSubmitted,
  isActiveEscalation,
  isEscalated,
  isResolved,
  normalizePriority,
  toTicketRow,
} from "./overview";
import { cleanText, humanizeValue } from "./ticket-detail";
import type { SortOrder } from "./tickets-list";
import type { Metric, Priority, SupportTicketRecord, TicketStatus } from "./types";

/**
 * Pure logic for the Escalations page. No React and no fetching: it works on
 * the same ticket records /api/tickets already returns.
 *
 * A ticket belongs here when `escalationStatus` is "required" (the n8n
 * workflow's decision; see `isEscalated` in lib/overview.ts). Priority is never
 * used to decide that. Resolving a ticket does not remove it from this page
 * (the escalation really happened); it only stops counting as ACTIVE, see
 * `isActiveEscalation`. Escalation history and current resolution are separate.
 */

/* -------------------------------------------------------------------------- */
/*  Identification                                                            */
/* -------------------------------------------------------------------------- */

export function selectEscalated(
  tickets: SupportTicketRecord[],
): SupportTicketRecord[] {
  return tickets.filter(isEscalated);
}

/* -------------------------------------------------------------------------- */
/*  Rows                                                                      */
/* -------------------------------------------------------------------------- */

export interface EscalationRow {
  id: string;
  customer: string;
  customerEmail: string;
  subject: string;
  category: string;
  priority: Priority;
  /** `escalationReason` as written by the workflow, or null when absent. */
  reason: string | null;
  /** ISO timestamp of `escalatedAt`, or null when absent or unparseable. */
  escalatedAt: string | null;
  /** "12 min ago" style label for `escalatedAt`. */
  escalatedAgo: string | null;
  /** The ticket has been resolved: this escalation is history, not outstanding. */
  resolved: boolean;
  /** The ticket's stored `status`, humanised; null when the document has none. */
  statusLabel: string | null;
  /** Colour for the status dot (see `toEscalationRow`). */
  statusTone: TicketStatus;
}

export function toEscalationRow(
  t: SupportTicketRecord,
  now: Date,
): EscalationRow {
  const base = toTicketRow(t, now);
  const escalatedAt = t.escalatedAt ?? null;
  return {
    id: base.id,
    customer: base.customer,
    customerEmail: base.customerEmail,
    subject: base.subject,
    category: base.category,
    priority: base.priority,
    reason: cleanText(t.escalationReason),
    escalatedAt,
    escalatedAgo: escalatedAt ? formatSubmitted(escalatedAt, now) : null,
    resolved: isResolved(t),
    statusLabel: humanizeValue(t.status),
    // Every row on this page is escalated, so the usual derived status would
    // always say "Escalated". Derive the tone without the escalation flag so
    // the dot reflects where the ticket is otherwise (open, resolved, ...).
    statusTone: displayStatus({ ...t, escalationStatus: null }),
  };
}

/* -------------------------------------------------------------------------- */
/*  Search, filter, sort                                                      */
/* -------------------------------------------------------------------------- */

export interface EscalationFilters {
  search: string;
  /** Only urgent and high are offered, but any escalated ticket is listed. */
  priority: "all" | "urgent" | "high";
  /** "all", or a category label exactly as shown in the table. */
  category: string;
  /**
   * "active" = not yet resolved, "resolved" = escalations that were resolved,
   * "all" (default) = the full history.
   */
  status: "all" | "active" | "resolved";
  /** By escalation date (`escalatedAt`). */
  sort: SortOrder;
}

export const DEFAULT_ESCALATION_FILTERS: EscalationFilters = {
  search: "",
  priority: "all",
  category: "all",
  status: "all",
  sort: "newest",
};

export function hasActiveEscalationFilters(f: EscalationFilters): boolean {
  return (
    f.search.trim() !== "" ||
    f.priority !== "all" ||
    f.category !== "all" ||
    f.status !== "all"
  );
}

export interface IndexedEscalation {
  row: EscalationRow;
  haystack: string;
}

/**
 * Builds the searchable index once per fetch. Search covers ticket ID,
 * customer name, customer email and the summary shown in the table.
 */
export function indexEscalations(
  escalated: SupportTicketRecord[],
  now: Date,
): IndexedEscalation[] {
  return escalated.map((t) => {
    const row = toEscalationRow(t, now);
    const name = typeof t.customerName === "string" ? t.customerName : "";
    const email = typeof t.customerEmail === "string" ? t.customerEmail : "";
    return {
      row,
      haystack: [row.id, name, email, row.subject].join("\n").toLowerCase(),
    };
  });
}

export function escalationCategoryOptions(
  indexed: IndexedEscalation[],
): string[] {
  return [...new Set(indexed.map((i) => i.row.category))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function matchesSearch(haystack: string, search: string): boolean {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  return terms.every((term) => haystack.includes(term));
}

function escalatedMs(row: EscalationRow): number | null {
  if (!row.escalatedAt) return null;
  const ms = Date.parse(row.escalatedAt);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Search, priority and category apply together (all must match), then rows are
 * sorted by escalation date. Rows without a usable `escalatedAt` always sort
 * last; their date is not guessed from any other field.
 */
export function applyEscalationFilters(
  indexed: IndexedEscalation[],
  filters: EscalationFilters,
): EscalationRow[] {
  const search = filters.search.trim();
  const direction = filters.sort === "newest" ? -1 : 1;

  return indexed
    .filter(({ row, haystack }) => {
      if (filters.priority !== "all" && row.priority !== filters.priority) {
        return false;
      }
      if (filters.category !== "all" && row.category !== filters.category) {
        return false;
      }
      if (filters.status === "active" && row.resolved) return false;
      if (filters.status === "resolved" && !row.resolved) return false;
      return search === "" || matchesSearch(haystack, search);
    })
    .map(({ row }) => row)
    .sort((a, b) => {
      const aMs = escalatedMs(a);
      const bMs = escalatedMs(b);
      if (aMs === null && bMs === null) return a.id.localeCompare(b.id);
      if (aMs === null) return 1;
      if (bMs === null) return -1;
      if (aMs !== bMs) return (aMs - bMs) * direction;
      return a.id.localeCompare(b.id);
    });
}

/* -------------------------------------------------------------------------- */
/*  Metrics                                                                   */
/* -------------------------------------------------------------------------- */

function percent(count: number, total: number, of: string): string {
  if (total === 0) return `0% of ${of}`;
  const pct = (count / total) * 100;
  if (count > 0 && pct < 1) return `<1% of ${of}`;
  return `${Math.round(pct)}% of ${of}`;
}

/**
 * Four cards, all computed from the escalated tickets themselves.
 *
 * The first is the HISTORICAL total (every ticket ever escalated, resolved or
 * not). The other three describe CURRENT escalations: escalated and not yet
 * resolved, using the same resolved/closed statuses as the Overview. A ticket
 * resolved from its detail page stops counting in them straight away, while
 * its escalation record stays in the total and in the table.
 */
export function buildEscalationMetrics(
  allTicketCount: number,
  escalated: SupportTicketRecord[],
): Metric[] {
  const total = escalated.length;
  const active = escalated.filter(isActiveEscalation);
  const urgent = active.filter((t) => normalizePriority(t.priority) === "urgent").length;
  const high = active.filter((t) => normalizePriority(t.priority) === "high").length;
  const awaiting = active.length;

  return [
    {
      id: "escalations_total",
      label: "Escalated tickets",
      description: "Flagged for human handling, resolved or not",
      value: total,
      footer: percent(total, allTicketCount, "all tickets"),
    },
    {
      id: "escalations_urgent",
      label: "Urgent escalations",
      description: "Not yet resolved, urgent priority",
      value: urgent,
      footer: percent(urgent, awaiting, "active escalations"),
    },
    {
      id: "escalations_high",
      label: "High-priority escalations",
      description: "Not yet resolved, high priority",
      value: high,
      footer: percent(high, awaiting, "active escalations"),
    },
    {
      id: "escalations_awaiting_attention",
      label: "Awaiting attention",
      description: "Escalated and not yet resolved",
      value: awaiting,
      footer: percent(awaiting, total, "escalations"),
    },
  ];
}
