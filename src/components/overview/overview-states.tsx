import { AlertTriangle, Inbox, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TicketsApiError } from "@/lib/api/tickets";

function StateCard({
  icon,
  title,
  children,
  action,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  action: React.ReactNode;
  tone?: "neutral" | "error";
}) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className="flex min-h-[420px] items-center justify-center rounded-lg border border-border bg-surface p-8"
    >
      <div className="max-w-md text-center">
        <span
          className={
            tone === "error"
              ? "mx-auto flex size-9 items-center justify-center rounded-md bg-[#FBEAE8] text-[#C93A2E]"
              : "mx-auto flex size-9 items-center justify-center rounded-md border border-border bg-surface-muted text-muted-foreground"
          }
        >
          {icon}
        </span>
        <h2 className="mt-3 text-sm font-semibold">{title}</h2>
        <div className="mt-1 space-y-2 text-[13px] text-muted-foreground">
          {children}
        </div>
        <div className="mt-4 flex justify-center">{action}</div>
      </div>
    </div>
  );
}

/** The request succeeded, but the collection has no documents. */
export function OverviewEmpty({
  onRefresh,
  refreshing,
}: {
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <StateCard
      icon={<Inbox className="size-4" aria-hidden />}
      title="No tickets yet"
      action={
        <Button variant="outline" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={refreshing ? "animate-spin" : undefined} />
          Check again
        </Button>
      }
    >
      <p>
        The connection to Firestore is working, but the support_tickets
        collection is empty.
      </p>
      <p>
        New requests will appear here as soon as your n8n workflow writes them.
      </p>
    </StateCard>
  );
}

/** The request failed. Nothing is shown in place of the real data. */
export function OverviewError({
  error,
  onRetry,
  retrying,
}: {
  error: TicketsApiError;
  onRetry: () => void;
  retrying: boolean;
}) {
  const notConfigured = error.code === "firebase_not_configured";
  const offline = error.code === "network_error";

  return (
    <StateCard
      tone="error"
      icon={
        offline ? (
          <WifiOff className="size-4" aria-hidden />
        ) : (
          <AlertTriangle className="size-4" aria-hidden />
        )
      }
      title={
        notConfigured
          ? "Firebase isn't configured yet"
          : "Couldn't load tickets"
      }
      action={
        <Button variant="outline" onClick={onRetry} disabled={retrying}>
          <RefreshCw className={retrying ? "animate-spin" : undefined} />
          Try again
        </Button>
      }
    >
      <p>{error.message}</p>
      {notConfigured && (
        <p>
          Add the values to <code className="font-medium">.env.local</code> (see{" "}
          <code className="font-medium">.env.example</code>) and restart the
          dev server.
        </p>
      )}
      <p className="text-xs text-subtle-foreground">
        Error: {error.code}
        {error.status ? ` (HTTP ${error.status})` : ""}
      </p>
    </StateCard>
  );
}

/** Shown above stale-but-real data when a refresh fails. */
export function RefreshFailedNotice({
  error,
  updatedAt,
}: {
  error: TicketsApiError;
  updatedAt: Date | null;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-[#F0C9C5] bg-[#FBEAE8] px-3 py-2 text-[13px] text-[#9E2A20]"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p>
        Couldn&apos;t refresh: {error.message}
        {updatedAt &&
          ` Showing the data from ${updatedAt.toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
          })}.`}
      </p>
    </div>
  );
}
