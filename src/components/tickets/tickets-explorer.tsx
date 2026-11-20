"use client";

import { useDashboardSettings } from "@/components/settings/settings-context";
import { formatClock } from "@/lib/dashboard-settings";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { RefreshCw, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  OverviewEmpty,
  OverviewError,
  RefreshFailedNotice,
} from "@/components/overview/overview-states";
import { LoadMore } from "@/components/ui/load-more";
import { DataNotice } from "@/components/ui/truncation-notice";
import { useTicketPages } from "@/hooks/use-ticket-pages";
import {
  categoryOptions,
  DEFAULT_FILTERS,
  hasActiveFilters,
  indexTickets,
  type TicketFilters,
} from "@/lib/tickets-list";
import { TicketFiltersBar } from "./ticket-filters";
import { TicketsSkeleton } from "./tickets-skeleton";
import { TicketsTable } from "./tickets-table";

export function TicketsExplorer() {
  const { settings } = useDashboardSettings();
  const { timeZone } = settings;
  const urlSearch = (useSearchParams().get("q") ?? "").slice(0, 200);
  const [filters, setFilters] = useState<TicketFilters>({ ...DEFAULT_FILTERS, search: urlSearch });
  // Search, filters and sort run on the server; this page holds only the pages loaded so far.
  const {
    tickets, error, loadMoreError, loading, refreshing, loadingMore, updatedAt,
    hasMore, scanLimited, total: allTickets, unlisted, refresh, loadMore,
  } = useTicketPages("tickets", filters);
  const sortTouched = useRef(false);

  // The saved default sort applies when it arrives, unless the user already picked an order here.
  useEffect(() => {
    if (!sortTouched.current) setFilters((f) => (f.sort === settings.defaultSort ? f : { ...f, sort: settings.defaultSort }));
  }, [settings.defaultSort]);

  // A search typed in the header (…/tickets?q=) lands here; a different q replaces the box.
  const lastUrlSearch = useRef(urlSearch);
  useEffect(() => {
    if (urlSearch !== lastUrlSearch.current) {
      lastUrlSearch.current = urlSearch;
      setFilters((f) => (f.search === urlSearch ? f : { ...f, search: urlSearch }));
    }
  }, [urlSearch]);

  // Keep the address bar in step with the box (shareable, survives reload) without a server round trip.
  useEffect(() => {
    const q = filters.search.trim().slice(0, 200);
    const url = new URL(window.location.href);
    if ((url.searchParams.get("q") ?? "") === q) return;
    lastUrlSearch.current = q;
    if (q) url.searchParams.set("q", q);
    else url.searchParams.delete("q");
    window.history.replaceState(window.history.state, "", url);
  }, [filters.search]);

  // Rows for the loaded pages (relative times are computed once per fetch).
  const indexed = useMemo(
    () => (tickets && updatedAt ? indexTickets(tickets, updatedAt) : null),
    [tickets, updatedAt],
  );
  const results = useMemo(() => (indexed ? indexed.map((i) => i.row) : []), [indexed]);

  const categories = useMemo(() => {
    const found = indexed ? categoryOptions(indexed) : [];
    // Keep the selected category in the list even if the loaded pages do not include it.
    return filters.category !== "all" && !found.includes(filters.category)
      ? [...found, filters.category].sort((a, b) => a.localeCompare(b))
      : found;
  }, [indexed, filters.category]);

  const total = allTickets ?? 0;
  const clear = () => setFilters({ ...DEFAULT_FILTERS, sort: settings.defaultSort });

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          Search, filter and open every request your support desk has received.
        </p>
        <div className="flex items-center gap-3">
          {updatedAt && (
            <span className="text-xs text-muted-foreground">
              Updated{" "}
              {formatClock(updatedAt, timeZone)}
            </span>
          )}
          <Button
            variant="outline"
            onClick={refresh}
            disabled={loading || refreshing}
          >
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
            Refresh
          </Button>
        </div>
      </section>

      {unlisted > 0 && (
        <DataNotice>
          {unlisted.toLocaleString("en-US")} {unlisted === 1 ? "ticket has" : "tickets have"} no
          usable creation date, so {unlisted === 1 ? "it is" : "they are"} not listed here. They are
          still counted on the Overview.
        </DataNotice>
      )}

      {loading && <TicketsSkeleton />}

      {!loading && !indexed && error && (
        <OverviewError error={error} onRetry={refresh} retrying={refreshing} />
      )}

      {indexed && total === 0 && (
        <OverviewEmpty onRefresh={refresh} refreshing={refreshing} />
      )}

      {indexed && total > 0 && (
        <>
          {error && <RefreshFailedNotice error={error} updatedAt={updatedAt} />}

          <Card className="overflow-hidden">
            <CardHeader>
              <div>
                <CardTitle>Tickets</CardTitle>
                <CardDescription aria-live="polite">
                  {hasActiveFilters(filters)
                    ? `Showing ${results.length.toLocaleString("en-US")} matching ${results.length === 1 ? "ticket" : "tickets"}${hasMore ? " so far" : ""}`
                    : `Showing ${results.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} tickets`}
                </CardDescription>
              </div>
            </CardHeader>

            <TicketFiltersBar
              filters={filters}
              categories={categories}
              onChange={(patch) => {
                if (patch.sort) sortTouched.current = true;
                setFilters((f) => ({ ...f, ...patch }));
              }}
              onClear={clear}
            />

            {results.length > 0 ? (
              <TicketsTable tickets={results} />
            ) : hasMore ? null : (
              <div className="flex flex-col items-center border-t border-border px-6 py-14 text-center">
                <span className="flex size-9 items-center justify-center rounded-md border border-border bg-surface-muted text-muted-foreground">
                  <SearchX className="size-4" aria-hidden />
                </span>
                <h3 className="mt-3 text-sm font-semibold">
                  No tickets match these filters
                </h3>
                <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">
                  Try a different search term, or remove a filter to see more of
                  the {total.toLocaleString("en-US")} tickets.
                </p>
                <Button variant="outline" className="mt-4" onClick={clear}>
                  Clear filters
                </Button>
              </div>
            )}

            <LoadMore
              hasMore={hasMore}
              loading={loadingMore}
              error={loadMoreError?.message ?? null}
              scanLimited={scanLimited}
              onLoadMore={loadMore}
            />
          </Card>
        </>
      )}
    </div>
  );
}
