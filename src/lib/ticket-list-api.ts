import "server-only";

import { NextResponse } from "next/server";
import type { Firestore } from "firebase-admin/firestore";
import { requireAuth } from "@/lib/auth/require-auth";
import { listTicketsPage } from "@/lib/firestore-ticket-pages";
import { computeTicketStats, ticketStatsCache, validTimeZone } from "@/lib/firestore-ticket-stats";
import { isSameOriginRequest } from "@/lib/request-guard";
import { InvalidCursorError } from "@/lib/ticket-cursor";
import { InvalidListQueryError, parseListQuery } from "@/lib/ticket-list-query";
import { errorResponse, NO_STORE, ticketsErrorResponse } from "@/lib/ticket-api-errors";
import type { StatsCache } from "@/lib/firestore-ticket-stats";

/**
 * Handlers behind GET /api/tickets and GET /api/overview, kept apart from the
 * route files so tests can run the real code against an in-memory Firestore.
 *
 * Order of checks: authentication (401/503), same-origin (403), then the query
 * string (400), and only then Firestore. The browser can only pick from a
 * closed set of filters; it never supplies a field name, operator or path.
 */

type Deps = { db?: Firestore; nowMs?: number; cache?: StatsCache; ceiling?: number };

function failure(error: unknown, label: string): Response {
  if (error instanceof InvalidListQueryError) {
    return errorResponse(400, "invalid_query", error.message);
  }
  if (error instanceof InvalidCursorError) {
    return errorResponse(400, "invalid_cursor", error.message);
  }
  return ticketsErrorResponse(error, label);
}

function crossSite(): Response {
  return errorResponse(403, "forbidden_origin", "This request came from a different site and was refused.");
}

export async function handleTicketListRequest(request: Request, deps: Deps = {}): Promise<Response> {
  try {
    await requireAuth(request);
    if (!isSameOriginRequest(request)) return crossSite();
    const query = parseListQuery(new URL(request.url));
    const page = await listTicketsPage(query, deps);
    return NextResponse.json(page, { status: 200, headers: NO_STORE });
  } catch (error) {
    return failure(error, "api/tickets");
  }
}

export async function handleOverviewRequest(request: Request, deps: Deps = {}): Promise<Response> {
  try {
    await requireAuth(request);
    if (!isSameOriginRequest(request)) return crossSite();

    const url = new URL(request.url);
    for (const name of url.searchParams.keys()) {
      if (name !== "tz" && name !== "fresh") throw new InvalidListQueryError(`Unknown parameter "${name}".`);
    }
    for (const name of ["tz", "fresh"]) {
      if (url.searchParams.getAll(name).length > 1) throw new InvalidListQueryError(`"${name}" may be given only once.`);
    }
    const rawTz = url.searchParams.get("tz");
    const tz = rawTz === null ? "UTC" : validTimeZone(rawTz);
    if (!tz) throw new InvalidListQueryError('"tz" must be a valid IANA time zone.');
    const fresh = url.searchParams.get("fresh");
    if (fresh !== null && fresh !== "1") throw new InvalidListQueryError('"fresh" must be 1 when given.');

    const cache = deps.cache ?? ticketStatsCache;
    const result = await cache.get(tz, { fresh: fresh === "1", nowMs: deps.nowMs }, () =>
      computeTicketStats(tz, { db: deps.db, nowMs: deps.nowMs, ceiling: deps.ceiling }),
    );
    return NextResponse.json({ ...result, timeZone: tz }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return failure(error, "api/overview");
  }
}
