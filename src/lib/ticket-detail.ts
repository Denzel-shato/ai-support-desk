import { displayStatus, isEscalated, normalizePriority } from "./overview";
import type {
  Priority,
  StringOrList,
  SupportTicketRecord,
  TicketStatus,
} from "./types";

/**
 * Turns one raw `support_tickets` document into what the details page shows.
 * Nothing is invented: a field the document lacks becomes null (or an empty
 * list), and the page decides how to present "not recorded".
 */

export function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** "not_required" / "NOT-REQUIRED" -> "Not required". */
export function humanizeValue(value: unknown): string | null {
  const t = cleanText(value);
  if (!t) return null;
  const spaced = t.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * Arrays and strings both become a list of items. A string is split on line
 * breaks, with leading bullets or numbering ("-", "•", "1.") removed.
 */
export function toList(value: StringOrList | null | undefined): string[] {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n/)
      : [];
  return raw
    .map((item) =>
      typeof item === "string" || typeof item === "number"
        ? String(item)
            .trim()
            .replace(/^(?:[-*•]+|\d+[.)])\s+/, "")
            .trim()
        : "",
    )
    .filter(Boolean);
}

/** True/false for booleans and the strings "true"/"false"; null otherwise. */
function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return null;
}

export function formatDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short" });
}

export interface TicketDetailView {
  id: string;
  /** AI summary, else a shortened message, else a plain fallback. */
  title: string;
  customerName: string | null;
  customerEmail: string | null;
  message: string | null;
  createdAt: string | null;
  createdLabel: string | null;
  priority: Priority;
  /** Single derived status, same rules as the Overview and All Tickets table. */
  status: TicketStatus;
  /** The `status` value as stored, when it says something the badge doesn't. */
  storedStatus: string | null;
  category: string | null;
  sentiment: string | null;
  reason: string | null;
  summary: string | null;

  kbStatus: string | null;
  relevantSection: string | null;
  coverageReason: string | null;
  supportedSteps: string[];
  unsupportedParts: string[];

  customerResponse: string | null;
  /** Only set when it exists and differs from the customer response. */
  aiResponse: string | null;

  /** null = not recorded. */
  escalationRequired: boolean | null;
  escalationStatus: string | null;
  escalationReason: string | null;
  escalatedLabel: string | null;
  reviewStatus: string | null;
  /** True when the AI/escalation fields mark this ticket as escalated. */
  escalated: boolean;
}

const STATUS_LABELS: Record<TicketStatus, string> = {
  new: "New",
  open: "Open",
  awaiting_review: "Awaiting review",
  escalated: "Escalated",
  resolved: "Resolved",
};

function sameText(a: string | null, b: string | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.replace(/\s+/g, " ").toLowerCase() === b.replace(/\s+/g, " ").toLowerCase()
  );
}

export function buildTicketDetail(t: SupportTicketRecord): TicketDetailView {
  const message = cleanText(t.message);
  const summary = cleanText(t.summary);
  const customerResponse = cleanText(t.customerResponse);
  const aiResponse = cleanText(t.aiResponse);
  const status = displayStatus(t);
  const stored = humanizeValue(t.status);

  return {
    id: t.id,
    title:
      summary ??
      (message
        ? message.length > 120
          ? `${message.slice(0, 119).trimEnd()}…`
          : message
        : "No summary available"),
    customerName: cleanText(t.customerName),
    customerEmail: cleanText(t.customerEmail),
    message,
    createdAt: t.createdAt ?? null,
    createdLabel: formatDateTime(t.createdAt),
    priority: normalizePriority(t.priority),
    status,
    storedStatus: stored && stored !== STATUS_LABELS[status] ? stored : null,
    category: humanizeValue(t.category),
    sentiment: humanizeValue(t.sentiment),
    reason: cleanText(t.reason),
    summary,

    kbStatus: humanizeValue(t.kbStatus),
    relevantSection: cleanText(t.relevantSection),
    coverageReason: cleanText(t.coverageReason),
    supportedSteps: toList(t.supportedSteps),
    unsupportedParts: toList(t.unsupportedParts),

    customerResponse,
    aiResponse: sameText(aiResponse, customerResponse) ? null : aiResponse,

    escalationRequired: toBoolean(t.escalationRequired),
    escalationStatus: humanizeValue(t.escalationStatus),
    escalationReason: cleanText(t.escalationReason),
    escalatedLabel: formatDateTime(t.escalatedAt),
    reviewStatus: humanizeValue(t.reviewStatus),
    escalated: isEscalated(t),
  };
}
