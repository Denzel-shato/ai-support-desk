import Link from "next/link";
import { AlertTriangle, ArrowLeft, FileQuestion, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { TicketsApiError } from "@/lib/api/tickets";

export function TicketDetailSkeleton() {
  return (
    <div role="status" aria-label="Loading ticket" className="space-y-5">
      <span className="sr-only">Loading ticket…</span>
      <Card aria-hidden className="space-y-3 p-5">
        <Skeleton className="h-6 w-2/3" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-5 w-24" />
        </div>
        <Skeleton className="h-3 w-64" />
      </Card>
      <div aria-hidden className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {[0, 1, 2].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-40" />
              </CardHeader>
              <CardContent className="space-y-2">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-11/12" />
                <Skeleton className="h-3.5 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="space-y-4">
          {[0, 1].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-4 w-28" />
              </CardHeader>
              <CardContent className="space-y-3">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3.5 w-1/2" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Not found, invalid ID, or a failed request. Never shows placeholder data. */
export function TicketDetailError({
  error,
  onRetry,
  retrying,
}: {
  error: TicketsApiError;
  onRetry: () => void;
  retrying: boolean;
}) {
  const missing = error.code === "ticket_not_found" || error.code === "invalid_ticket_id";
  const notConfigured = error.code === "firebase_not_configured";
  const offline = error.code === "network_error";

  return (
    <div
      role="alert"
      className="flex min-h-[360px] items-center justify-center rounded-lg border border-border bg-surface p-8"
    >
      <div className="max-w-md text-center">
        <span
          className={
            missing
              ? "mx-auto flex size-9 items-center justify-center rounded-md border border-border bg-surface-muted text-muted-foreground"
              : "mx-auto flex size-9 items-center justify-center rounded-md bg-[#FBEAE8] text-[#C93A2E]"
          }
        >
          {missing ? (
            <FileQuestion className="size-4" aria-hidden />
          ) : offline ? (
            <WifiOff className="size-4" aria-hidden />
          ) : (
            <AlertTriangle className="size-4" aria-hidden />
          )}
        </span>
        <h2 className="mt-3 text-sm font-semibold">
          {error.code === "ticket_not_found"
            ? "Ticket not found"
            : error.code === "invalid_ticket_id"
              ? "That ticket link isn't valid"
              : notConfigured
                ? "Firebase isn't configured yet"
                : "Couldn't load this ticket"}
        </h2>
        <p className="mt-1 text-[13px] text-muted-foreground">{error.message}</p>
        {!missing && (
          <p className="mt-2 text-xs text-subtle-foreground">
            Error: {error.code}
            {error.status ? ` (HTTP ${error.status})` : ""}
          </p>
        )}
        <div className="mt-4 flex justify-center gap-2">
          {!missing && (
            <Button variant="outline" onClick={onRetry} disabled={retrying}>
              <RefreshCw className={retrying ? "animate-spin" : undefined} />
              Try again
            </Button>
          )}
          <Button asChild variant={missing ? "default" : "ghost"}>
            <Link href="/tickets">
              <ArrowLeft />
              Back to all tickets
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
