"use client";

import { useMemo, useState } from "react";
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
import { TruncationNotice } from "@/components/ui/truncation-notice";
import { MAX_TICKETS } from "@/lib/limits";
import { useTickets } from "@/hooks/use-tickets";
import {
  applyFilters,
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
  const { tickets, error, loading, refreshing, updatedAt, truncated, refresh } =
    useTickets();
  const [filters, setFilters] = useState<TicketFilters>(DEFAULT_FILTERS);

  // Index once per fetch; filtering below only re-runs the cheap part.
  const indexed = useMemo(
    () => (tickets && updatedAt ? indexTickets(tickets, updatedAt) : null),
    [tickets, updatedAt],
  );

  const categories = useMemo(() => {
    const found = indexed ? categoryOptions(indexed) : [];
    // Keep the selected category in the list even if a refresh removed it.
    return filters.category !== "all" && !found.includes(filters.category)
      ? [...found, filters.category].sort((a, b) => a.localeCompare(b))
      : found;
  }, [indexed, filters.category]);

  const results = useMemo(
    () => (indexed ? applyFilters(indexed, filters) : []),
    [indexed, filters],
  );

  const total = indexed?.length ?? 0;
  const clear = () => setFilters(DEFAULT_FILTERS);

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
              {updatedAt.toLocaleTimeString("en-GB", {
                hour: "2-digit",
                minute: "2-digit",
              })}
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

      {truncated && <TruncationNotice noun="tickets" limit={MAX_TICKETS} />}

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
                    ? `Showing ${results.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} tickets`
                    : `${total.toLocaleString("en-US")} ${total === 1 ? "ticket" : "tickets"}`}
                </CardDescription>
              </div>
            </CardHeader>

            <TicketFiltersBar
              filters={filters}
              categories={categories}
              onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
              onClear={clear}
            />

            {results.length > 0 ? (
              <TicketsTable tickets={results} />
            ) : (
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
          </Card>
        </>
      )}
    </div>
  );
}
