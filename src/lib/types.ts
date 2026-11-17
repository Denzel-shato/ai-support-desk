/* -------------------------------------------------------------------------- */
/*  Firestore / API schema                                                    */
/* -------------------------------------------------------------------------- */

/** A list field that n8n may write as an array or as a single string. */
export type StringOrList = string | string[];

/**
 * One document from the `support_tickets` collection, as returned by
 * GET /api/tickets. Dates are ISO strings (or null when missing/unparseable).
 *
 * Every field except `id` is optional: documents written by different n8n
 * branches, or at different stages of processing, may not have all of them.
 * Values are kept exactly as stored; any interpretation (priority names,
 * status names) happens in `lib/overview.ts`.
 */
export interface SupportTicketRecord {
  /** Firestore document ID. */
  id: string;

  customerName?: string | null;
  customerEmail?: string | null;
  /** The customer's original message. */
  message?: string | null;

  /* AI classification */
  category?: string | null;
  reason?: string | null;
  sentiment?: string | null;
  priority?: string | null;
  summary?: string | null;

  /* Knowledge-base evaluation */
  kbStatus?: string | null;
  relevantSection?: string | null;
  coverageReason?: string | null;
  supportedSteps?: StringOrList | null;
  unsupportedParts?: StringOrList | null;

  /* Responses */
  escalationRequired?: boolean | null;
  customerResponse?: string | null;
  aiResponse?: string | null;

  /* Workflow state */
  status?: string | null;
  createdAt?: string | null;
  escalationStatus?: string | null;
  escalationReason?: string | null;
  escalatedAt?: string | null;
  /** "awaiting_review" | "approved" | "rejected": the agent's decision. */
  reviewStatus?: string | null;

  /* Response review and delivery (written by the dashboard and the n8n send
     workflow; older tickets don't have these). `aiResponse` and
     `customerResponse` are never modified by either. */
  /** The agent's approved (or draft) reply: what gets emailed. */
  finalResponse?: string | null;
  /** "draft" | "sending" | "queued" | "sent" | "failed" | "unknown": email delivery, separate from reviewStatus. */
  responseStatus?: string | null;
  responseSentAt?: string | null;
  responseError?: string | null;
  /** When the current send attempt was claimed; a claim with no recorded answer reads as "unknown". */
  responseQueuedAt?: string | null;
  /** "agent" when a person confirmed delivery by hand (reconciliation). */
  responseConfirmedBy?: string | null;
}

/** Error body returned by GET /api/tickets on any non-2xx response. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** Names (never values) of missing environment variables. */
    missing?: string[];
    /** Per-field validation messages (form submissions). */
    fields?: Record<string, string>;
    /** Short ID that matches this failure to the server log (5xx only). */
    requestId?: string;
    /** ID of the existing document a duplicate clashed with. */
    existingId?: string;
  };
}

/* -------------------------------------------------------------------------- */
/*  UI models                                                                 */
/* -------------------------------------------------------------------------- */

/** Priority as shown in the UI. "unspecified" covers missing/unknown values. */
export type Priority = "urgent" | "high" | "medium" | "low" | "unspecified";

/**
 * Single status shown per ticket in the table. Derived with a fixed
 * precedence (escalated > awaiting review > resolved > new/open) so every
 * ticket has exactly one.
 */
export type TicketStatus =
  | "new"
  | "open"
  | "awaiting_review"
  | "escalated"
  | "resolved";

/** A row in the recent tickets table. */
export interface Ticket {
  id: string;
  /** One-line description of the issue (AI summary, else the message). */
  subject: string;
  customer: string;
  customerEmail: string;
  category: string;
  priority: Priority;
  /** Main AI classification label (sentiment), or "Not classified". */
  aiClassification: string;
  /** Secondary AI detail (knowledge-base coverage), when available. */
  aiDetail?: string;
  status: TicketStatus;
  /** ISO timestamp, or null when the document has no usable date. */
  createdAt: string | null;
  /** Human-readable "12 min ago" style label. */
  submittedLabel: string;
}

export interface Metric {
  id:
    | "total"
    | "open"
    | "escalated"
    | "awaiting_review"
    | "escalations_total"
    | "escalations_urgent"
    | "escalations_high"
    | "escalations_awaiting_attention";
  label: string;
  description: string;
  value: number;
  /** Short context line under the number, derived from the same data. */
  footer: string;
}

export interface ActivityPoint {
  /** Short axis label, e.g. "Fri". */
  day: string;
  /** Full label for tooltips, e.g. "Fri, 13 Nov". */
  dateLabel: string;
  received: number;
  escalated: number;
}

export interface PriorityShare {
  priority: Priority;
  count: number;
}

/** Everything the Overview page needs, derived from the ticket list. */
export interface OverviewData {
  metrics: Metric[];
  activity: ActivityPoint[];
  /** e.g. "13 Nov" or "7 Nov – 13 Nov"; null when no ticket has a date. */
  activityRangeLabel: string | null;
  /** Tickets plotted in the chart (those inside the displayed window). */
  activityTotal: number;
  /** Tickets with no usable creation date, so not on the chart. */
  undatedCount: number;
  priorityDistribution: PriorityShare[];
  priorityTotal: number;
  recent: Ticket[];
  total: number;
}

/* -------------------------------------------------------------------------- */
/*  Knowledge base                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One document from the `knowledge_base` collection, as returned by
 * GET /api/knowledge-base. The document ID is the article ID. Fields mirror
 * the stored schema (`title`, `category`, `active`, `keywords`, `content`);
 * all but `id` and `content` may be missing, and `updatedAt` is only present
 * when the source document has one.
 */
export interface KnowledgeArticle {
  id: string;
  title: string | null;
  category: string | null;
  /** null when the document has no usable `active` value. */
  active: boolean | null;
  keywords: string[];
  /** Markdown-style article text, exactly as stored. */
  content: string;
  updatedAt: string | null;
  /**
   * Firestore's last-write time for the document, as an opaque token. An edit
   * sends it back; if the document changed since, the save is refused (409)
   * instead of silently overwriting someone else's change. Not a schema field.
   */
  version: string | null;
}
