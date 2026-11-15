import { AlertTriangle, BookOpen, RefreshCw, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { TicketsApiError } from "@/lib/api/tickets";

export function KnowledgeSkeleton() {
  return (
    <div role="status" aria-label="Loading knowledge base" className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
      <span className="sr-only">Loading knowledge base…</span>
      <Card aria-hidden className="space-y-3 p-4">
        <Skeleton className="h-8 w-full" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2 rounded-md border border-border p-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </Card>
      <Card aria-hidden>
        <CardHeader>
          <Skeleton className="h-5 w-2/3" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-4 w-1/4" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-5/6" />
        </CardContent>
      </Card>
    </div>
  );
}

export function KnowledgeEmpty({
  onRefresh,
  refreshing,
}: {
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="flex min-h-[360px] items-center justify-center rounded-lg border border-border bg-surface p-8">
      <div className="max-w-md text-center">
        <span className="mx-auto flex size-9 items-center justify-center rounded-md border border-border bg-surface-muted text-muted-foreground">
          <BookOpen className="size-4" aria-hidden />
        </span>
        <h2 className="mt-3 text-sm font-semibold">No articles found</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          The <code>knowledge_base</code> collection has no articles yet. Use
          Add article to create the first one.
        </p>
        <Button variant="outline" className="mt-4" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={refreshing ? "animate-spin" : undefined} />
          Refresh
        </Button>
      </div>
    </div>
  );
}

export function KnowledgeError({
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
    <div
      role="alert"
      className="flex min-h-[360px] items-center justify-center rounded-lg border border-border bg-surface p-8"
    >
      <div className="max-w-md text-center">
        <span className="mx-auto flex size-9 items-center justify-center rounded-md bg-[#FBEAE8] text-[#C93A2E]">
          {offline ? <WifiOff className="size-4" aria-hidden /> : <AlertTriangle className="size-4" aria-hidden />}
        </span>
        <h2 className="mt-3 text-sm font-semibold">
          {notConfigured ? "Firebase isn't configured yet" : "Couldn't load the knowledge base"}
        </h2>
        <p className="mt-1 text-[13px] text-muted-foreground">{error.message}</p>
        {error.missing.length > 0 && (
          <p className="mt-2 text-xs text-subtle-foreground">
            Missing: {error.missing.join(", ")}
          </p>
        )}
        <p className="mt-2 text-xs text-subtle-foreground">
          Error: {error.code}
          {error.status ? ` (HTTP ${error.status})` : ""}
        </p>
        <Button variant="outline" className="mt-4" onClick={onRetry} disabled={retrying}>
          <RefreshCw className={retrying ? "animate-spin" : undefined} />
          Try again
        </Button>
      </div>
    </div>
  );
}
