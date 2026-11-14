import { Card, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function TicketsSkeleton() {
  return (
    <Card role="status" aria-label="Loading tickets" className="overflow-hidden">
      <span className="sr-only">Loading tickets…</span>
      <CardHeader aria-hidden className="items-center">
        <div className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-40" />
        </div>
      </CardHeader>
      <div aria-hidden className="flex gap-2 px-4 pb-4">
        <Skeleton className="h-8 w-full max-w-sm" />
        <Skeleton className="hidden h-8 w-32 sm:block" />
        <Skeleton className="hidden h-8 w-32 sm:block" />
        <Skeleton className="hidden h-8 w-32 sm:block" />
      </div>
      <div aria-hidden className="divide-y divide-border border-t border-border">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3.5">
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-3 w-1/4" />
            </div>
            <Skeleton className="hidden h-3.5 w-40 md:block" />
            <Skeleton className="hidden h-5 w-16 sm:block" />
            <Skeleton className="hidden h-4 w-24 md:block" />
          </div>
        ))}
      </div>
    </Card>
  );
}
