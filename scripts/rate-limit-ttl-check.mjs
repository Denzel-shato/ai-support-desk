// Pure helpers for scripts/check-rate-limit-ttl.mjs (kept separate so they can be unit-tested without Firebase).
//
// Firestore TTL deletes a document only when its TTL field holds a Timestamp ("Date and time" value). A string, a
// number or a missing/null field silently disables TTL for that document. See
// https://cloud.google.com/firestore/docs/ttl for the exact rule.

const DAY_MS = 24 * 60 * 60 * 1000;

/** @returns {"timestamp" | "string" | "number" | "missing" | "other"} */
export function classifyExpireAt(value) {
  if (value === undefined || value === null) return "missing";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "other" : "timestamp";
  if (typeof value === "object" && typeof value.toMillis === "function") return "timestamp";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "other";
}

/**
 * @param {{ expireAt?: unknown }[]} docs  document data as returned by the Admin SDK
 * @param {number} nowMs
 * @param {number} [graceMs] how long after expiry a document may still exist before TTL is considered not working.
 *   Google documents "typically within 24 hours"; the default allows 48 hours of slack.
 */
export function summarizeTtl(docs, nowMs, graceMs = 2 * DAY_MS) {
  const types = { timestamp: 0, string: 0, number: 0, missing: 0, other: 0 };
  let overdue = 0;
  for (const d of docs) {
    const kind = classifyExpireAt(d?.expireAt);
    types[kind]++;
    if (kind === "timestamp") {
      const ms = d.expireAt instanceof Date ? d.expireAt.getTime() : d.expireAt.toMillis();
      if (ms < nowMs - graceMs) overdue++;
    }
  }
  const total = docs.length;
  const notTimestamp = total - types.timestamp;
  /** @type {string[]} */
  const problems = [];
  if (notTimestamp > 0) {
    problems.push(`${notTimestamp} of ${total} documents have an expireAt that is not a Firestore Timestamp (TTL will never delete them)`);
  }
  if (overdue > 0) {
    problems.push(`${overdue} documents expired more than ${Math.round(graceMs / 3600000)} hours ago but still exist (no active TTL policy, or it is still being set up)`);
  }
  return { total, types, overdue, problems, ok: total > 0 && problems.length === 0 };
}
