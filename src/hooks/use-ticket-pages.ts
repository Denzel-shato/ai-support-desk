"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useDashboardSettings } from "@/components/settings/settings-context";
import { fetchTicketPage, TicketsApiError, type TicketPageResponse } from "@/lib/api/tickets";
import type { ListView } from "@/lib/ticket-list-query";
import type { SupportTicketRecord } from "@/lib/types";

/**
 * Loads tickets one page at a time from /api/tickets. Search, filters and sort
 * are evaluated on the server (a page of tickets is not the whole data set), so
 * changing any of them starts again from page one; "Load more" follows the
 * server's cursor. A failed request keeps whatever is already on screen.
 */
export interface ListFilters {
  search: string;
  priority: string;
  category: string;
  status: string;
  sort: string;
}

export interface UseTicketPagesResult {
  tickets: SupportTicketRecord[] | null;
  error: TicketsApiError | null;
  loadMoreError: TicketsApiError | null;
  /** First load, before anything has been shown. */
  loading: boolean;
  /** A manual refresh or a filter change is in flight (the old list stays visible). */
  refreshing: boolean;
  loadingMore: boolean;
  updatedAt: Date | null;
  hasMore: boolean;
  /** The last page stopped at the server's read budget: it may be shorter than asked. */
  scanLimited: boolean;
  /** Documents in the whole collection (not the matches); from the first page. */
  total: number | null;
  /** Documents with no usable createdAt: they cannot be listed. */
  unlisted: number;
  refresh: () => void;
  loadMore: () => void;
}

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 300;

function toApiError(error: unknown): TicketsApiError {
  return error instanceof TicketsApiError
    ? error
    : new TicketsApiError("Something went wrong while loading tickets.", { code: "unknown_error" });
}

function paramsFor(view: ListView, f: ListFilters, cursor: string | null): URLSearchParams {
  const p = new URLSearchParams({ view, limit: String(PAGE_SIZE), sort: f.sort });
  if (f.search.trim()) p.set("search", f.search.trim());
  if (f.priority !== "all") p.set("priority", f.priority);
  if (f.category !== "all") p.set("category", f.category);
  if (f.status !== "all") p.set("status", f.status);
  if (cursor) p.set("cursor", cursor);
  return p;
}

export function useTicketPages(view: ListView, filters: ListFilters): UseTicketPagesResult {
  const [tickets, setTickets] = useState<SupportTicketRecord[] | null>(null);
  const [page, setPage] = useState<Pick<TicketPageResponse, "nextCursor" | "hasMore" | "scanLimited">>({
    nextCursor: null,
    hasMore: false,
    scanLimited: false,
  });
  const [total, setTotal] = useState<number | null>(null);
  const [unlisted, setUnlisted] = useState(0);
  const [error, setError] = useState<TicketsApiError | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<TicketsApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [manualRefresh, setManualRefresh] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  // The filters the data on screen belongs to; differs from `applied` while a new page one is on its way.
  const [loadedFor, setLoadedFor] = useState<ListFilters | null>(null);
  const controller = useRef<AbortController | null>(null);
  const pagesLoaded = useRef(0);
  const { settings } = useDashboardSettings();
  const autoRefreshMinutes = settings.autoRefreshMinutes;

  // Typing is debounced so each keystroke is not a request; every other change applies at once.
  const [applied, setApplied] = useState(filters);
  useEffect(() => {
    if (filters === applied) return;
    const searchOnly =
      filters.search !== applied.search &&
      filters.priority === applied.priority &&
      filters.category === applied.category &&
      filters.status === applied.status &&
      filters.sort === applied.sort;
    const timer = setTimeout(() => setApplied(filters), searchOnly ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [filters, applied]);

  // No state is set synchronously here (effects call this); everything is set when the response arrives.
  const loadFirst = useCallback(
    (f: ListFilters) => {
      controller.current?.abort();
      const current = new AbortController();
      controller.current = current;

      fetchTicketPage(paramsFor(view, f, null), current.signal)
        .then((data) => {
          if (current.signal.aborted) return;
          pagesLoaded.current = 1;
          setTickets(data.tickets);
          setPage({ nextCursor: data.nextCursor, hasMore: data.hasMore, scanLimited: data.scanLimited });
          if (typeof data.total === "number") setTotal(data.total);
          setUnlisted(data.unlisted ?? 0);
          setUpdatedAt(new Date());
          setError(null);
        })
        .catch((err: unknown) => {
          if (current.signal.aborted) return;
          setError(toApiError(err));
        })
        .finally(() => {
          if (current.signal.aborted) return;
          setLoadMoreError(null);
          setLoadingMore(false);
          setLoadedFor(f);
          setLoading(false);
          setManualRefresh(false);
        });
    },
    [view],
  );

  // First load, and again whenever the (debounced) filters change.
  useEffect(() => {
    loadFirst(applied);
    return () => controller.current?.abort();
  }, [applied, loadFirst]);

  const loadMore = useCallback(() => {
    if (!page.hasMore || !page.nextCursor || loadingMore) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setLoadingMore(true);
    setLoadMoreError(null);
    fetchTicketPage(paramsFor(view, applied, page.nextCursor), current.signal)
      .then((data) => {
        if (current.signal.aborted) return;
        pagesLoaded.current += 1;
        // Append, skipping any id already shown (a defensive guard; keyset paging does not repeat rows).
        setTickets((prev) => {
          const seen = new Set((prev ?? []).map((t) => t.id));
          return [...(prev ?? []), ...data.tickets.filter((t) => !seen.has(t.id))];
        });
        setPage({ nextCursor: data.nextCursor, hasMore: data.hasMore, scanLimited: data.scanLimited });
      })
      .catch((err: unknown) => {
        if (current.signal.aborted) return;
        setLoadMoreError(toApiError(err));
      })
      .finally(() => {
        if (current.signal.aborted) return;
        setLoadingMore(false);
      });
  }, [applied, page, loadingMore, view]);

  // Optional background reload. Only while the first page is all that is shown, so it never throws away pages the user loaded.
  useEffect(() => {
    if (!autoRefreshMinutes) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && pagesLoaded.current <= 1) loadFirst(applied);
    }, autoRefreshMinutes * 60_000);
    return () => clearInterval(timer);
  }, [autoRefreshMinutes, loadFirst, applied]);

  const refresh = useCallback(() => {
    setManualRefresh(true);
    loadFirst(applied);
  }, [applied, loadFirst]);

  // A refresh is in flight when asked for by hand, or while page one for newly chosen filters is loading (old rows stay visible).
  const refreshing = !loading && (manualRefresh || loadedFor !== applied);

  return {
    tickets,
    error,
    loadMoreError,
    loading,
    refreshing,
    loadingMore,
    updatedAt,
    hasMore: page.hasMore,
    scanLimited: page.scanLimited,
    total,
    unlisted,
    refresh,
    loadMore,
  };
}
