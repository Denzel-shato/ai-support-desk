"use client";

import { useMemo, useSyncExternalStore } from "react";
import { RefreshCw } from "lucide-react";
import { useDashboardSettings } from "@/components/settings/settings-context";
import { Button } from "@/components/ui/button";
import { DataNotice } from "@/components/ui/truncation-notice";
import { useOverviewStats } from "@/hooks/use-overview-stats";
import { formatClock, greetingFor } from "@/lib/dashboard-settings";
import { deriveOverviewFromStats } from "@/lib/overview";
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

/** Minute-granular clock as an external store: the greeting re-checks every minute, so it changes at 12:00 and 17:00 without a reload. */
function subscribeMinute(onChange: () => void) {
  const timer = setInterval(onChange, 30_000);
  return () => clearInterval(timer);
}
const currentMinute = () => Math.floor(Date.now() / 60_000);

function useGreeting(timeZone: string): string {
  // The server snapshot is null, so the server HTML says "Welcome back" and the browser swaps in the real greeting.
  const minute = useSyncExternalStore(subscribeMinute, currentMinute, () => null);
  return minute === null ? "Welcome back" : greetingFor(new Date(minute * 60_000), timeZone);
}

export function OverviewDashboard() {
  const { timeZone } = useDashboardSettings().settings;
  const greeting = useGreeting(timeZone);
  const { data, error, loading, refreshing, updatedAt, refresh } = useOverviewStats();

  // Every number comes from server-side aggregates over ALL tickets; only the "recent" table lists tickets.
  // Relative times ("12 min ago") are computed once per fetch.
  const overview = useMemo(
    () => (data && updatedAt ? deriveOverviewFromStats(data.stats, data.recent, updatedAt) : null),
    [data, updatedAt],
  );

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">
            {greeting}
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Here&apos;s what&apos;s happening across your support desk today.
          </p>
        </div>
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

      {data?.partial && (
        <DataNotice>
          This desk has more tickets than the dashboard will count in one pass, so these figures are a lower bound.
        </DataNotice>
      )}

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
