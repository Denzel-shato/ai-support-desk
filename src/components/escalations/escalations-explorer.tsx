"use client";

import { useDashboardSettings } from "@/components/settings/settings-context";
import { formatClock } from "@/lib/dashboard-settings";
import { useMemo, useState } from "react";
import { RefreshCw, SearchX, ShieldCheck } from "lucide-react";
import { MetricCard } from "@/components/overview/metric-card";
import {
  OverviewEmpty,
  OverviewError,
  RefreshFailedNotice,
} from "@/components/overview/overview-states";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LoadMore } from "@/components/ui/load-more";
import { DataNotice } from "@/components/ui/truncation-notice";
import { useOverviewStats } from "@/hooks/use-overview-stats";
import { useTicketPages } from "@/hooks/use-ticket-pages";
import {
  DEFAULT_ESCALATION_FILTERS,
  escalationCategoryOptions,
  escalationMetricsFromStats,
  hasActiveEscalationFilters,
  indexEscalations,
  type EscalationFilters,
} from "@/lib/escalations";
import { EscalationFiltersBar } from "./escalation-filters";
import { EscalationsSkeleton } from "./escalations-skeleton";
import { EscalationsTable } from "./escalations-table";

export function EscalationsExplorer() {
  const { timeZone } = useDashboardSettings().settings;
  const [filters, setFilters] = useState<EscalationFilters>(
    DEFAULT_ESCALATION_FILTERS,
  );

  // The list is paged and filtered on the server (escalated tickets only); the four
  // metric cards come from aggregates over every ticket, not from the loaded rows.
  const list = useTicketPages("escalations", filters);
  const overview = useOverviewStats();
  const { tickets, updatedAt, loadMoreError, loadingMore, hasMore, scanLimited } = list;
  const loading = list.loading || overview.loading;
  const error = list.error ?? overview.error;
  const refreshing = list.refreshing || overview.refreshing;
  const refresh = () => {
    list.refresh();
    overview.refresh();
  };

  const indexed = useMemo(
    () => (tickets && updatedAt ? indexEscalations(tickets, updatedAt) : null),
    [tickets, updatedAt],
  );

  const stats = overview.data?.stats ?? null;
  const metrics = useMemo(() => (stats ? escalationMetricsFromStats(stats) : null), [stats]);

  const categories = useMemo(() => {
    const found = indexed ? escalationCategoryOptions(indexed) : [];
    // Keep the selected category listed even if the loaded pages do not include it.
    return filters.category !== "all" && !found.includes(filters.category)
      ? [...found, filters.category].sort((a, b) => a.localeCompare(b))
      : found;
  }, [indexed, filters.category]);

  const results = useMemo(() => (indexed ? indexed.map((i) => i.row) : []), [indexed]);

  const allTickets = stats?.total ?? 0;
  const everEscalated = stats?.everEscalated ?? 0;
  const clear = () => setFilters(DEFAULT_ESCALATION_FILTERS);
  const noTickets = !!stats && stats.total === 0;
  const noEscalations = !!stats && everEscalated === 0 && !hasActiveEscalationFilters(filters);

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          Tickets your workflow has flagged for a person to handle. This view is
          read-only.
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

      {overview.data?.partial && (
        <DataNotice>
          This desk has more tickets than the dashboard will count in one pass, so the figures above are a lower bound.
        </DataNotice>
      )}

      {loading && <EscalationsSkeleton />}

      {!loading && (!tickets || !stats) && error && (
        <OverviewError error={error} onRetry={refresh} retrying={refreshing} />
      )}

      {tickets && noTickets && <OverviewEmpty onRefresh={refresh} refreshing={refreshing} />}

      {tickets && stats && !noTickets && noEscalations && (
        <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-border bg-surface p-8">
          <div className="max-w-md text-center">
            <span className="mx-auto flex size-9 items-center justify-center rounded-md border border-border bg-surface-muted text-muted-foreground">
              <ShieldCheck className="size-4" aria-hidden />
            </span>
            <h2 className="mt-3 text-sm font-semibold">No escalations right now</h2>
            <div className="mt-1 space-y-2 text-[13px] text-muted-foreground">
              <p>
                None of the {allTickets.toLocaleString("en-US")} tickets is
                marked as needing escalation.
              </p>
              <p>
                Tickets appear here when the workflow sets their escalation status
                to required.
              </p>
            </div>
            <div className="mt-4 flex justify-center">
              <Button variant="outline" onClick={refresh} disabled={refreshing}>
                <RefreshCw className={refreshing ? "animate-spin" : undefined} />
                Check again
              </Button>
            </div>
          </div>
        </div>
      )}

      {indexed && metrics && !noTickets && !noEscalations && (
        <>
          {error && <RefreshFailedNotice error={error} updatedAt={updatedAt} />}

          <section
            aria-label="Escalation metrics"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
          >
            {metrics.map((m) => (
              <MetricCard key={m.id} metric={m} />
            ))}
          </section>

          <Card className="overflow-hidden">
            <CardHeader>
              <div>
                <CardTitle>Escalated tickets</CardTitle>
                <CardDescription aria-live="polite">
                  {hasActiveEscalationFilters(filters)
                    ? `Showing ${results.length.toLocaleString("en-US")} matching ${results.length === 1 ? "escalation" : "escalations"}${hasMore ? " so far" : ""}`
                    : `Showing ${results.length.toLocaleString("en-US")} of ${everEscalated.toLocaleString("en-US")} ${everEscalated === 1 ? "escalation" : "escalations"}`}
                </CardDescription>
              </div>
            </CardHeader>

            <EscalationFiltersBar
              filters={filters}
              categories={categories}
              onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
              onClear={clear}
            />

            {results.length > 0 ? (
              <EscalationsTable rows={results} />
            ) : hasMore ? null : (
              <div className="flex flex-col items-center border-t border-border px-6 py-14 text-center">
                <span className="flex size-9 items-center justify-center rounded-md border border-border bg-surface-muted text-muted-foreground">
                  <SearchX className="size-4" aria-hidden />
                </span>
                <h3 className="mt-3 text-sm font-semibold">
                  No escalations match these filters
                </h3>
                <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">
                  Try a different search term, or remove a filter to see all{" "}
                  {everEscalated.toLocaleString("en-US")} escalations.
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
              onLoadMore={list.loadMore}
            />
          </Card>
        </>
      )}
    </div>
  );
}
