"use client";

import { useMemo } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TruncationNotice } from "@/components/ui/truncation-notice";
import { MAX_TICKETS } from "@/lib/limits";
import { useTickets } from "@/hooks/use-tickets";
import { deriveOverview } from "@/lib/overview";
import { MetricCard } from "./metric-card";
import { OverviewSkeleton } from "./overview-skeleton";
import {
  OverviewEmpty,
  OverviewError,
  RefreshFailedNotice,
} from "./overview-states";
import { PriorityDistribution } from "./priority-distribution";
import { RecentTicketsTable } from "./recent-tickets-table";
import { TicketActivityChart } from "./ticket-activity-chart";

export function OverviewDashboard() {
  const { tickets, error, loading, refreshing, updatedAt, truncated, refresh } =
    useTickets();

  // Relative times ("12 min ago") are computed once per fetch.
  const overview = useMemo(
    () => (tickets && updatedAt ? deriveOverview(tickets, updatedAt) : null),
    [tickets, updatedAt],
  );

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            Good afternoon
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Here&apos;s what&apos;s happening across your support desk today.
          </p>
        </div>
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

      {loading && <OverviewSkeleton />}

      {!loading && !overview && error && (
        <OverviewError error={error} onRetry={refresh} retrying={refreshing} />
      )}

      {overview && overview.total === 0 && (
        <OverviewEmpty onRefresh={refresh} refreshing={refreshing} />
      )}

      {overview && overview.total > 0 && (
        <>
          {error && <RefreshFailedNotice error={error} updatedAt={updatedAt} />}

          <section
            aria-label="Key metrics"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
          >
            {overview.metrics.map((m) => (
              <MetricCard key={m.id} metric={m} />
            ))}
          </section>

          <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <TicketActivityChart
                data={overview.activity}
                rangeLabel={overview.activityRangeLabel}
                total={overview.activityTotal}
                undated={overview.undatedCount}
              />
            </div>
            <PriorityDistribution data={overview.priorityDistribution} />
          </section>

          <section>
            <RecentTicketsTable tickets={overview.recent} />
          </section>
        </>
      )}
    </div>
  );
}
