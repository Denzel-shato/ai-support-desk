import { DEFAULT_ESCALATION_FILTERS, type EscalationFilters } from "./escalations";
import { DEFAULT_FILTERS, type TicketFilters } from "./tickets-list";

/**
 * Validation for the query string of GET /api/tickets. Every value is checked
 * against a closed list or a length cap; nothing from the browser is ever used
 * as a Firestore field name, operator or path. Anything unexpected is a 400.
 */

export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MAX = 100;
export const SEARCH_MAX_CHARS = 200;
const CATEGORY_MAX_CHARS = 120;

export class InvalidListQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidListQueryError";
  }
}

export type ListView = "tickets" | "escalations";

export type ListQuery =
  | { view: "tickets"; limit: number; cursor: string | null; filters: TicketFilters }
  | { view: "escalations"; limit: number; cursor: string | null; filters: EscalationFilters };

const KNOWN_PARAMS = new Set([
  "view",
  "limit",
  "cursor",
  "search",
  "priority",
  "category",
  "status",
  "sort",
]);

function oneOf<T extends string>(name: string, value: string | null, allowed: readonly T[], fallback: T): T {
  if (value === null || value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new InvalidListQueryError(`"${name}" has an unsupported value.`);
}

function text(name: string, value: string | null, max: number): string {
  if (value === null) return "";
  if (value.length > max) throw new InvalidListQueryError(`"${name}" is too long.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new InvalidListQueryError(`"${name}" has invalid characters.`);
  return value;
}

export function parseListQuery(url: URL): ListQuery {
  const p = url.searchParams;
  for (const name of p.keys()) {
    if (!KNOWN_PARAMS.has(name)) throw new InvalidListQueryError(`Unknown parameter "${name}".`);
  }
  for (const name of KNOWN_PARAMS) {
    if (p.getAll(name).length > 1) throw new InvalidListQueryError(`"${name}" may be given only once.`);
  }

  const view = oneOf("view", p.get("view"), ["tickets", "escalations"] as const, "tickets");

  let limit = PAGE_SIZE_DEFAULT;
  const rawLimit = p.get("limit");
  if (rawLimit !== null) {
    if (!/^\d{1,4}$/.test(rawLimit)) throw new InvalidListQueryError('"limit" must be a whole number.');
    limit = Number(rawLimit);
    if (limit < 1 || limit > PAGE_SIZE_MAX) {
      throw new InvalidListQueryError(`"limit" must be between 1 and ${PAGE_SIZE_MAX}.`);
    }
  }

  const rawCursor = p.get("cursor");
  const cursor = rawCursor === null || rawCursor === "" ? null : rawCursor;

  const search = text("search", p.get("search"), SEARCH_MAX_CHARS);
  const category = text("category", p.get("category"), CATEGORY_MAX_CHARS) || "all";
  const sort = oneOf("sort", p.get("sort"), ["newest", "oldest"] as const, "newest");

  if (view === "tickets") {
    const priority = oneOf(
      "priority",
      p.get("priority"),
      ["all", "urgent", "high", "medium", "low"] as const,
      DEFAULT_FILTERS.priority,
    );
    const status = oneOf(
      "status",
      p.get("status"),
      ["all", "new", "open", "awaiting_review", "escalated", "resolved"] as const,
      DEFAULT_FILTERS.status,
    );
    return { view, limit, cursor, filters: { search, priority, category, status, sort } };
  }

  const priority = oneOf(
    "priority",
    p.get("priority"),
    ["all", "urgent", "high"] as const,
    DEFAULT_ESCALATION_FILTERS.priority,
  );
  const status = oneOf(
    "status",
    p.get("status"),
    ["all", "active", "resolved"] as const,
    DEFAULT_ESCALATION_FILTERS.status,
  );
  return { view, limit, cursor, filters: { search, priority, category, status, sort } };
}
