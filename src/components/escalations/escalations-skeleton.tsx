import { Card, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function EscalationsSkeleton() {
  return (
    <div role="status" aria-label="Loading escalations" className="space-y-5">
      <span className="sr-only">Loading escalations…</span>

      <section
        aria-hidden
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="p-4">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="mt-3 h-8 w-16" />
            <Skeleton className="mt-3 h-3 w-40" />
            <div className="mt-3 border-t border-border pt-3">
              <Skeleton className="h-3 w-28" />
            </div>
          </Card>
        ))}
      </section>

      <Card aria-hidden className="overflow-hidden">
        <CardHeader className="items-center">
          <div className="space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-36" />
          </div>
        </CardHeader>
        <div className="flex gap-2 px-4 pb-4">
          <Skeleton className="h-8 w-full max-w-sm" />
          <Skeleton className="hidden h-8 w-32 sm:block" />
          <Skeleton className="hidden h-8 w-32 sm:block" />
          <Skeleton className="hidden h-8 w-32 sm:block" />
        </div>
        <div className="divide-y divide-border border-t border-border">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3.5">
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="h-3 w-1/4" />
              </div>
              <Skeleton className="hidden h-3.5 w-40 md:block" />
              <Skeleton className="hidden h-5 w-16 sm:block" />
              <Skeleton className="hidden h-4 w-32 md:block" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
