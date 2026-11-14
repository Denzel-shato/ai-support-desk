import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function OverviewSkeleton() {
  return (
    <div role="status" aria-label="Loading tickets" className="space-y-5">
      <span className="sr-only">Loading tickets…</span>

      <section
        aria-hidden
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i} className="p-4">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="mt-3 h-8 w-20" />
            <Skeleton className="mt-3 h-3 w-40" />
            <div className="mt-3 border-t border-border pt-3">
              <Skeleton className="h-3 w-28" />
            </div>
          </Card>
        ))}
      </section>

      <section aria-hidden className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-3 w-52" />
            </div>
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[240px] w-full" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="space-y-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-44" />
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-2.5 w-full rounded-full" />
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </CardContent>
        </Card>
      </section>

      <Card aria-hidden className="overflow-hidden">
        <CardHeader className="items-center">
          <div className="space-y-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-7 w-32" />
        </CardHeader>
        <div className="divide-y divide-border border-t border-border">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3.5">
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-3/5" />
                <Skeleton className="h-3 w-2/5" />
              </div>
              <Skeleton className="hidden h-5 w-16 sm:block" />
              <Skeleton className="hidden h-4 w-24 md:block" />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
