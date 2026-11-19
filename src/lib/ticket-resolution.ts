import { isActiveEscalation, isClosedStatus, isEscalated, isResolved } from "./overview";
import {
  effectiveStatus,
  needsReconciliation,
  normalizeResponseStatus,
  ResponseWorkflowError,
} from "./response-workflow";
import { toIsoOrNull } from "./ticket-serialization";
import type { SupportTicketRecord } from "./types";

/**
 * Rules for explicitly resolving (and reopening) a ticket.
 *
 * Pure: no React, no Firebase, no fetching, no clock (callers pass `nowMs`).
 * The server (API route, Firestore transaction) and the browser (the ticket
 * page) both import it, so they always agree on what is allowed.
 *
 * Data model. Resolving a ticket writes ONLY these fields:
 *   status                  "resolved"
 *   statusBeforeResolution  the `status` it had (internal; used to restore it on reopen)
 *   resolvedAt / resolvedBy when, and the signed-in user who did it
 * Reopening writes:
 *   status                  restored from statusBeforeResolution ("open" if unknown)
 *   statusBeforeResolution  null
 *   resolvedAt / resolvedBy null (the ticket is no longer resolved)
 *   reopenedAt / reopenedBy when, and who (kept after a later re-resolve)
 * Everything else on the ticket is left exactly as it was: escalationStatus,
 * escalationReason, escalatedAt, reviewStatus, finalResponse and every
 * response* field, aiResponse and customerResponse. "Was it escalated?" (history)
 * and "is it resolved?" (current state) are therefore independent facts.
 *
 * Audit. Each change also appends one immutable event to
 * `support_tickets/{id}/response_events` (`ticket_resolved` / `ticket_reopened`)
 * in the SAME transaction. Reopening never edits or deletes the resolve event,
 * so the resolution history cannot be lost by clearing `resolvedAt` on the ticket.
 */

export type ResolutionAction = "resolve" | "reopen";
export const RESOLUTION_ACTIONS: readonly ResolutionAction[] = ["resolve", "reopen"];

/** The status a reopened ticket falls back to when nothing better is recorded. */
export const FALLBACK_REOPEN_STATUS = "open";

/** A raw Firestore document (may contain Timestamps). */
type RawDoc = Record<string, unknown>;

/**
 * The shared status predicates are written for the API shape; a raw document
 * has the same field names (dates aside, which they don't read), so view it as one.
 */
const asTicket = (raw: RawDoc): SupportTicketRecord => raw as unknown as SupportTicketRecord;

/**
 * Validates a resolution request body. Only `action` is read: any other field
 * the browser sends is ignored, so nothing in the body can reach the ticket.
 * Throws before any Firestore access.
 */
export function parseResolutionRequest(body: unknown): ResolutionAction {
  const obj = (typeof body === "object" && body !== null ? body : {}) as RawDoc;
  const action = RESOLUTION_ACTIONS.find((a) => a === obj.action);
  if (!action) {
    throw new ResponseWorkflowError(
      400,
      "invalid_action",
      "The action must be one of: resolve, reopen.",
    );
  }
  return action;
}

export const SEND_IN_PROGRESS_MESSAGE =
  "A response is being sent right now. Wait for that to finish before resolving this ticket.";
export const DELIVERY_UNCONFIRMED_MESSAGE =
  "An earlier attempt to email the customer may have been delivered. Mark it as delivered, or confirm it wasn't, before resolving this ticket.";
export const ALREADY_RESOLVED_MESSAGE = "This ticket is already resolved.";
export const NOT_RESOLVED_MESSAGE = "This ticket isn't resolved, so there is nothing to reopen.";

/**
 * Why a ticket can't be resolved right now because of its email state, or null.
 * An email that is mid-send, or whose delivery nobody has confirmed, must be
 * settled first: resolving would hide a delivery question that still needs an
 * answer. (Same rule and codes the review actions use.)
 */
function deliveryBlock(
  raw: RawDoc,
  nowMs: number,
): { code: "send_in_progress" | "delivery_unconfirmed"; message: string } | null {
  const status = effectiveStatus(
    normalizeResponseStatus(raw.responseStatus),
    toIsoOrNull(raw.responseQueuedAt),
    nowMs,
  );
  if (status === "sending") {
    return { code: "send_in_progress", message: SEND_IN_PROGRESS_MESSAGE };
  }
  if (needsReconciliation(status)) {
    return { code: "delivery_unconfirmed", message: DELIVERY_UNCONFIRMED_MESSAGE };
  }
  return null;
}

export interface ResolutionDecision {
  /** Fields to write. Dates are ISO strings; the Firestore layer stores them as Timestamps. */
  fields: Record<string, unknown>;
  /** The audit event describing the change. */
  event: {
    type: "ticket_resolved" | "ticket_reopened";
    details: Record<string, unknown>;
  };
}

function storedStatus(raw: RawDoc): string | null {
  return typeof raw.status === "string" && raw.status.trim() ? raw.status : null;
}

function actorName(actor: string): string {
  const a = typeof actor === "string" ? actor.trim() : "";
  // A resolution without a person behind it would make `resolvedBy` meaningless.
  if (!a) throw new Error("A resolution needs the signed-in user's name.");
  return a;
}

/**
 * Decides one transition from the ticket as stored. Throws a
 * ResponseWorkflowError (409) for a transition that isn't valid from the
 * current state; nothing is written in that case.
 *
 *   resolve  not resolved -> resolved.   Refused when already resolved (the
 *            original `resolvedAt` / `resolvedBy` are never overwritten), and
 *            while an email is sending or its delivery is unconfirmed.
 *   reopen   resolved -> not resolved.   Refused when the ticket isn't resolved.
 */
export function decideResolution(
  raw: RawDoc,
  action: ResolutionAction,
  nowMs: number,
  actor: string,
): ResolutionDecision {
  const by = actorName(actor);
  const nowIso = new Date(nowMs).toISOString();
  const resolved = isResolved(asTicket(raw));

  if (action === "resolve") {
    if (resolved) {
      throw new ResponseWorkflowError(409, "already_resolved", ALREADY_RESOLVED_MESSAGE);
    }
    const block = deliveryBlock(raw, nowMs);
    if (block) throw new ResponseWorkflowError(409, block.code, block.message);

    return {
      fields: {
        status: "resolved",
        statusBeforeResolution: storedStatus(raw),
        resolvedAt: nowIso,
        resolvedBy: by,
      },
      event: {
        type: "ticket_resolved",
        details: {
          previousStatus: storedStatus(raw),
          // A snapshot of what the ticket looked like when it was resolved.
          escalated: isEscalated(asTicket(raw)),
          escalationStatus: typeof raw.escalationStatus === "string" ? raw.escalationStatus : null,
          reviewStatus: typeof raw.reviewStatus === "string" ? raw.reviewStatus : null,
          responseStatus: typeof raw.responseStatus === "string" ? raw.responseStatus : null,
        },
      },
    };
  }

  // reopen
  if (!resolved) {
    throw new ResponseWorkflowError(409, "not_resolved", NOT_RESOLVED_MESSAGE);
  }
  const before = storedStatus(raw);
  const remembered =
    typeof raw.statusBeforeResolution === "string" && raw.statusBeforeResolution.trim()
      ? raw.statusBeforeResolution
      : null;
  // Never "restore" to a finished status: that would reopen into a closed ticket.
  const restored =
    remembered !== null && !isClosedStatus(remembered) ? remembered : FALLBACK_REOPEN_STATUS;

  return {
    fields: {
      status: restored,
      statusBeforeResolution: null,
      resolvedAt: null,
      resolvedBy: null,
      reopenedAt: nowIso,
      reopenedBy: by,
    },
    event: {
      type: "ticket_reopened",
      details: {
        previousStatus: before,
        restoredStatus: restored,
        // Carried into the reopen event too, so it reads on its own.
        previousResolvedAt: toIsoOrNull(raw.resolvedAt),
        previousResolvedBy: typeof raw.resolvedBy === "string" ? raw.resolvedBy : null,
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  View model for the ticket page                                            */
/* -------------------------------------------------------------------------- */

export interface ResolutionView {
  resolved: boolean;
  resolvedAt: string | null;
  resolvedBy: string | null;
  /** Last reopening, if the ticket has ever been reopened. */
  reopenedAt: string | null;
  reopenedBy: string | null;
  /** Escalated at some point (history; unaffected by resolving). */
  wasEscalated: boolean;
  /** Escalated and not resolved: still needs attention. */
  activeEscalation: boolean;
  canResolve: boolean;
  canReopen: boolean;
  /** Why "Mark as resolved" is unavailable even though the ticket is open, or null. */
  resolveBlockedReason: string | null;
}

export function buildResolutionView(
  t: SupportTicketRecord,
  nowMs: number = Date.now(),
): ResolutionView {
  const resolved = isResolved(t);
  const block = resolved ? null : deliveryBlock(t as unknown as RawDoc, nowMs);
  return {
    resolved,
    resolvedAt: toIsoOrNull(t.resolvedAt),
    resolvedBy: typeof t.resolvedBy === "string" && t.resolvedBy.trim() ? t.resolvedBy : null,
    reopenedAt: toIsoOrNull(t.reopenedAt),
    reopenedBy: typeof t.reopenedBy === "string" && t.reopenedBy.trim() ? t.reopenedBy : null,
    wasEscalated: isEscalated(t),
    activeEscalation: isActiveEscalation(t),
    canResolve: !resolved && block === null,
    canReopen: resolved,
    resolveBlockedReason: block?.message ?? null,
  };
}
