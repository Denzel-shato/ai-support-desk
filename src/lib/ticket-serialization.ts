import type { SupportTicketRecord } from "./types";

/**
 * Pure helpers that turn raw Firestore document data into JSON-safe values.
 * No Firebase imports here: timestamps are detected structurally so this file
 * can be unit-tested without credentials.
 */

type TimestampLike = { toDate: () => Date };
type SecondsLike = { seconds?: number; _seconds?: number };

function isTimestampLike(value: unknown): value is TimestampLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TimestampLike).toDate === "function"
  );
}

function fromDate(date: Date): string | null {
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Best-effort conversion of any date-ish Firestore value to an ISO string.
 * Handles Timestamps, Dates, ISO/RFC strings, epoch numbers (seconds or
 * milliseconds) and serialized `{seconds}` / `{_seconds}` objects. Anything
 * else returns null instead of throwing.
 */
export function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;

  if (isTimestampLike(value)) {
    try {
      return fromDate(value.toDate());
    } catch {
      return null;
    }
  }
  if (value instanceof Date) return fromDate(value);

  if (typeof value === "number" && Number.isFinite(value)) {
    // Epoch seconds are below ~1e11; milliseconds are above.
    return fromDate(new Date(value < 1e11 ? value * 1000 : value));
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(\.\d+)?$/.test(trimmed)) return toIsoOrNull(Number(trimmed));
    return fromDate(new Date(trimmed));
  }

  if (typeof value === "object") {
    const { seconds, _seconds } = value as SecondsLike;
    const secs = typeof seconds === "number" ? seconds : _seconds;
    if (typeof secs === "number" && Number.isFinite(secs)) {
      return fromDate(new Date(secs * 1000));
    }
  }

  return null;
}

/** Recursively converts Timestamps/Dates anywhere in a value to ISO strings. */
function toJsonSafe(value: unknown): unknown {
  if (value == null) return value;
  if (isTimestampLike(value) || value instanceof Date) return toIsoOrNull(value);
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        toJsonSafe(v),
      ]),
    );
  }
  return value;
}

/**
 * Builds the API representation of one `support_tickets` document.
 * Existing fields keep their names and meanings; only date values are
 * rewritten (to ISO strings, or null when unparseable). The Firestore
 * document ID always wins as `id`.
 */
export function serializeTicket(
  id: string,
  data: Record<string, unknown>,
): SupportTicketRecord {
  const safe = toJsonSafe(data) as Record<string, unknown>;
  return {
    ...safe,
    createdAt: toIsoOrNull(data.createdAt),
    escalatedAt: toIsoOrNull(data.escalatedAt),
    id,
  } as SupportTicketRecord;
}

/** Newest first; tickets without a usable createdAt sort last. */
export function compareByCreatedAtDesc(
  a: SupportTicketRecord,
  b: SupportTicketRecord,
): number {
  const aMs = a.createdAt ? Date.parse(a.createdAt) : Number.NEGATIVE_INFINITY;
  const bMs = b.createdAt ? Date.parse(b.createdAt) : Number.NEGATIVE_INFINITY;
  if (aMs !== bMs) return bMs - aMs;
  return a.id.localeCompare(b.id);
}
