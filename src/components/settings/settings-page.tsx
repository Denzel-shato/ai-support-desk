"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";
import { RefreshFailedNotice } from "@/components/overview/overview-states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { PreferencesForm } from "./preferences-form";
import { useDashboardSettings } from "./settings-context";
import { formatClock } from "@/lib/dashboard-settings";
import { useSettingsStatus } from "@/hooks/use-settings-status";
import type { Integration, Level, Row } from "@/lib/settings-status";

const LEVEL_STYLE: Record<Level, { bg: string; fg: string; dot: string }> = {
  ok: { bg: "#E5F2EB", fg: "#1F6B45", dot: "#1F6B45" },
  warn: { bg: "#FDF3DC", fg: "#8A5A00", dot: "#C98A00" },
  pending: { bg: "#EAEFF8", fg: "#2F4A7A", dot: "#5B7DB8" },
  error: { bg: "#FBEAE8", fg: "#9E2A20", dot: "#C93A2E" },
  info: { bg: "#EEF0F2", fg: "#4B5563", dot: "#9CA3AF" },
};

function Rows({ rows }: { rows: Row[] }) {
  return (
    <dl className="divide-y divide-border">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-1 gap-0.5 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[200px_1fr] sm:gap-4">
          <dt className="text-xs text-muted-foreground sm:pt-0.5">{r.label}</dt>
          <dd className="break-words text-[13px] leading-relaxed">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="block pb-3">
        <CardTitle>{title}</CardTitle>
        <CardDescription className="mt-1">{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function IntegrationItem({ item }: { item: Integration }) {
  const s = LEVEL_STYLE[item.level];
  return (
    <li className="rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold">{item.name}</h3>
        <Badge style={{ backgroundColor: s.bg, color: s.fg }}>
          <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: s.dot }} />
          {item.status}
        </Badge>
      </div>
      <p className="mt-0.5 text-xs text-subtle-foreground">{item.scope}</p>
      <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{item.detail}</p>
      {item.facts.length > 0 && (
        <div className="mt-3 border-t border-border pt-3">
          <Rows rows={item.facts} />
        </div>
      )}
    </li>
  );
}

function SettingsSkeleton() {
  return (
    <div role="status" aria-label="Loading settings" className="space-y-4">
      <span className="sr-only">Loading settings…</span>
      {[0, 1, 2].map((i) => (
        <Card key={i} aria-hidden>
          <CardHeader className="block">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="mt-2 h-3 w-64" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-5/6" />
            <Skeleton className="h-3.5 w-2/3" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function SettingsPage() {
  const { status, error, loading, checking, recheck } = useSettingsStatus();
  const checkedAt = status ? new Date(status.checkedAt) : null;
  const { timeZone } = useDashboardSettings().settings;

  return (
    <div className="space-y-5">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-2xl text-[13px] text-muted-foreground">
          Your dashboard preferences, and how it is set up and connected. The
          system information is read from the running application, never assumed.
        </p>
        <div className="flex items-center gap-3">
          {checkedAt && !Number.isNaN(checkedAt.getTime()) && (
            <span className="text-xs text-muted-foreground">
              Checked{" "}
              {formatClock(checkedAt, timeZone)}
            </span>
          )}
          <Button variant="outline" onClick={recheck} disabled={loading || checking}>
            <RefreshCw className={checking ? "animate-spin" : undefined} />
            Re-check
          </Button>
        </div>
      </section>

      <Section title="Preferences" description="Saved on the server, so they apply on every device you sign in from.">
        <PreferencesForm />
      </Section>

      {loading && <SettingsSkeleton />}

      {!loading && !status && error && (
        <div
          role="alert"
          className="flex min-h-[300px] items-center justify-center rounded-lg border border-border bg-surface p-8"
        >
          <div className="max-w-md text-center">
            <span className="mx-auto flex size-9 items-center justify-center rounded-md bg-[#FBEAE8] text-[#C93A2E]">
              <AlertTriangle className="size-4" aria-hidden />
            </span>
            <h2 className="mt-3 text-sm font-semibold">Couldn&apos;t load the settings</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">{error.message}</p>
            <p className="mt-2 text-xs text-subtle-foreground">
              Error: {error.code}
              {error.status ? ` (HTTP ${error.status})` : ""}
            </p>
            <Button variant="outline" className="mt-4" onClick={recheck} disabled={checking}>
              <RefreshCw className={checking ? "animate-spin" : undefined} />
              Try again
            </Button>
          </div>
        </div>
      )}

      {status && (
        <>
          {error && <RefreshFailedNotice error={error} updatedAt={checkedAt} />}

          <Section title="Workspace" description="What this workspace is and how it stores data.">
            <Rows rows={status.workspace} />
          </Section>

          <Section
            title="Integrations"
            description="Measured from the running server where possible. Nothing is shown as connected unless it was verified."
          >
            <ul className="space-y-3">
              {status.integrations.map((i) => (
                <IntegrationItem key={i.id} item={i} />
              ))}
            </ul>
          </Section>

          <Section
            title="Notifications"
            description="Which emails the system sends, and where each one is controlled. These are not configurable from the dashboard."
          >
            <ul className="divide-y divide-border">
              {status.notifications.map((n) => (
                <li key={n.title} className="grid grid-cols-1 gap-0.5 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[200px_1fr] sm:gap-4">
                  <span className="text-[13px] font-medium">{n.title}</span>
                  <span className="text-[13px] leading-relaxed text-muted-foreground">
                    {n.detail} <span className="text-subtle-foreground">({n.where})</span>
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Application" description="Build and runtime information. No secrets are shown.">
            <Rows rows={status.application} />
          </Section>
        </>
      )}
    </div>
  );
}
