import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { readAuthConfig } from "./auth/config";

/**
 * Opaque, signed page cursors for GET /api/tickets.
 *
 * A cursor names the LAST document of the previous page (its Firestore ID) and
 * the sort direction. The server turns it back into `startAfter(snapshot)`, so
 * the next page resumes exactly after that document in the
 * (createdAt, document ID) order: no offset, no skipped or repeated tickets,
 * and tickets created meanwhile do not shift anything.
 *
 * It is signed (HMAC-SHA256, key derived from the existing auth secrets) so a
 * browser can only send back a cursor this server issued: it cannot point the
 * query at an arbitrary document or smuggle in any other query parameter.
 * Unsigned, altered, truncated or wrong-direction cursors are rejected.
 */

export type CursorDirection = "asc" | "desc";

export interface PageCursor {
  /** Firestore document ID of the last ticket on the previous page. */
  id: string;
  dir: CursorDirection;
}

export class InvalidCursorError extends Error {
  constructor() {
    super("That page cursor is not valid. Reload the list to start again.");
    this.name = "InvalidCursorError";
  }
}

const VERSION = 1;
const MAX_CURSOR_CHARS = 2048;

function keyFor(): Buffer {
  // Separate key from the session cookie's: a cursor can never be replayed as a session.
  const config = readAuthConfig();
  // requireAuth has already run, so this only happens if the environment changed mid-request: fail closed.
  if (!config) throw new Error("Authentication is not configured, so page cursors cannot be signed.");
  return createHmac("sha256", config.signingKey).update("ticket-page-cursor:v1").digest();
}

function sign(payload: string): string {
  return createHmac("sha256", keyFor()).update(payload).digest("base64url");
}

export function encodeCursor(cursor: PageCursor): string {
  const payload = Buffer.from(
    JSON.stringify({ v: VERSION, d: cursor.dir, i: cursor.id }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

/** Throws InvalidCursorError for anything that is not a cursor we issued for this direction. */
export function decodeCursor(raw: string, expectedDir: CursorDirection): PageCursor {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CURSOR_CHARS) {
    throw new InvalidCursorError();
  }
  const parts = raw.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new InvalidCursorError();
  const [payload, signature] = parts;

  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new InvalidCursorError();
  }

  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError();
  }
  const d = data as { v?: unknown; d?: unknown; i?: unknown } | null;
  if (
    !d ||
    d.v !== VERSION ||
    (d.d !== "asc" && d.d !== "desc") ||
    d.d !== expectedDir ||
    typeof d.i !== "string" ||
    d.i.length === 0
  ) {
    throw new InvalidCursorError();
  }
  return { id: d.i, dir: d.d };
}
