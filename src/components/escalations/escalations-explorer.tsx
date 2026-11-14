"use client";

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
import { useTickets } from "@/hooks/use-tickets";
import {
  applyEscalationFilters,
  buildEscalationMetrics,
  DEFAULT_ESCALATION_FILTERS,
  escalationCategoryOptions,
  hasActiveEscalationFilters,
  indexEscalations,
  selectEscalated,
  type EscalationFilters,
} from "@/lib/escalations";
import { EscalationFiltersBar } from "./escalation-filters";
import { EscalationsSkeleton } from "./escalations-skeleton";
import { EscalationsTable } from "./escalations-table";

export function EscalationsExplorer() {
  const { tickets, error, loading, refreshing, updatedAt, refresh } =
    useTickets();
  const [filters, setFilters] = useState<EscalationFilters>(
    DEFAULT_ESCALATION_FILTERS,
  );

  // Escalations come from the same /api/tickets data as every other page.
  const escalated = useMemo(
    () => (tickets ? selectEscalated(tickets) : null),
    [tickets],
  );

  const indexed = useMemo(
    () => (escalated && updatedAt ? indexEscalations(escalated, updatedAt) : null),
    [escalated, updatedAt],
  );

  const metrics = useMemo(
    () =>
      tickets && escalated ? buildEscalationMetrics(tickets.length, escalated) : null,
    [tickets, escalated],
  );

  const categories = useMemo(() => {
    const found = indexed ? escalationCategoryOptions(indexed) : [];
    // Keep the selected category listed even if a refresh removed it.
    return filters.category !== "all" && !found.includes(filters.category)
      ? [...found, filters.category].sort((a, b) => a.localeCompare(b))
      : found;
  }, [indexed, filters.category]);

  const results = useMemo(
    () => (indexed ? applyEscalationFilters(indexed, filters) : []),
    [indexed, filters],
  );

  const total = indexed?.length ?? 0;
  const clear = () => setFilters(DEFAULT_ESCALATION_FILTERS);
  const noTickets = tickets !== null && tickets.length === 0;

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

      {loading && <EscalationsSkeleton />}

      {!loading && !tickets && error && (
        <OverviewError error={error} onRetry={refresh} retrying={refreshing} />
      )}

      {noTickets && <OverviewEmpty onRefresh={refresh} refreshing={refreshing} />}

      {tickets && !noTickets && total === 0 && (
        <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-border bg-surface p-8">
          <div className="max-w-md text-center">
            <span className="mx-auto flex size-9 items-center justify-center rounded-md border border-border bg-surface-muted text-muted-foreground">
              <ShieldCheck className="size-4" aria-hidden />
            </span>
            <h2 className="mt-3 text-sm font-semibold">No escalations right now</h2>
            <div className="mt-1 space-y-2 text-[13px] text-muted-foreground">
              <p>
                None of the {tickets.length.toLocaleString("en-US")} tickets is
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

      {indexed && metrics && total > 0 && (
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
                    ? `Showing ${results.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} escalations`
                    : `${total.toLocaleString("en-US")} ${total === 1 ? "escalation" : "escalations"}`}
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
            ) : (
              <div className="flex flex-col items-center border-t border-border px-6 py-14 text-center">
                <span className="flex size-9 items-center justify-center rounded-md border border-border bg-surface-muted text-muted-foreground">
                  <SearchX className="size-4" aria-hidden />
                </span>
                <h3 className="mt-3 text-sm font-semibold">
                  No escalations match these filters
                </h3>
                <p className="mt-1 max-w-sm text-[13px] text-muted-foreground">
                  Try a different search term, or remove a filter to see all{" "}
                  {total.toLocaleString("en-US")} escalations.
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
