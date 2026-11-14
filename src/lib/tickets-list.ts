import { toTicketRow } from "./overview";
import type { Priority, SupportTicketRecord, Ticket, TicketStatus } from "./types";

/**
 * Pure search / filter / sort logic for the All Tickets page. No React and no
 * fetching. Rows reuse `toTicketRow` from lib/overview.ts, so priority,
 * category and status mean exactly what they mean on the Overview.
 */

export type SortOrder = "newest" | "oldest";

export interface TicketFilters {
  search: string;
  /** "all", or one of the four real priorities. */
  priority: Exclude<Priority, "unspecified"> | "all";
  /** "all", or a category label exactly as shown in the table. */
  category: string;
  /** "all", or a displayed (derived) ticket status. */
  status: TicketStatus | "all";
  sort: SortOrder;
}

export const DEFAULT_FILTERS: TicketFilters = {
  search: "",
  priority: "all",
  category: "all",
  status: "all",
  sort: "newest",
};

export function hasActiveFilters(f: TicketFilters): boolean {
  return (
    f.search.trim() !== "" ||
    f.priority !== "all" ||
    f.category !== "all" ||
    f.status !== "all"
  );
}

/** A table row plus the lowercase text we search against. */
export interface IndexedTicket {
  row: Ticket;
  haystack: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Builds the searchable index once per fetch. Search covers customer name,
 * email, original message, AI summary and the Firestore document ID.
 */
export function indexTickets(
  records: SupportTicketRecord[],
  now: Date,
): IndexedTicket[] {
  return records.map((t) => ({
    row: toTicketRow(t, now),
    haystack: [t.customerName, t.customerEmail, t.message, t.summary, t.id]
      .map(str)
      .join("\n")
      .toLowerCase(),
  }));
}

/** Distinct category labels present in the data, A to Z. */
export function categoryOptions(indexed: IndexedTicket[]): string[] {
  return [...new Set(indexed.map((i) => i.row.category))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function matchesSearch(haystack: string, search: string): boolean {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  // Every word must appear somewhere, so "priya northwind" narrows the list.
  return terms.every((term) => haystack.includes(term));
}

function createdMs(row: Ticket): number | null {
  if (!row.createdAt) return null;
  const ms = Date.parse(row.createdAt);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Applies search, priority, category and status together (all must match),
 * then sorts by creation date. Tickets without a usable date always sort last
 * so they never crowd the top of "oldest first".
 */
export function applyFilters(
  indexed: IndexedTicket[],
  filters: TicketFilters,
): Ticket[] {
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
      if (filters.status !== "all" && row.status !== filters.status) {
        return false;
      }
      return search === "" || matchesSearch(haystack, search);
    })
    .map(({ row }) => row)
    .sort((a, b) => {
      const aMs = createdMs(a);
      const bMs = createdMs(b);
      if (aMs === null && bMs === null) return a.id.localeCompare(b.id);
      if (aMs === null) return 1;
      if (bMs === null) return -1;
      if (aMs !== bMs) return (aMs - bMs) * direction;
      return a.id.localeCompare(b.id);
    });
}

/** Compact absolute date for table cells, e.g. "14 Nov 2026, 09:40". */
export function formatCreatedShort(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
