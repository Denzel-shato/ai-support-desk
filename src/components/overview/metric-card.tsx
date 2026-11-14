import { Card } from "@/components/ui/card";
import type { Metric } from "@/lib/types";

export function MetricCard({ metric }: { metric: Metric }) {
  return (
    <Card className="p-4 transition-colors hover:border-border-strong">
      <p className="text-[13px] font-medium text-muted-foreground">
        {metric.label}
      </p>
      <p className="tabular mt-2 text-3xl font-semibold leading-none tracking-tight">
        {metric.value.toLocaleString("en-US")}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">{metric.description}</p>
      <div className="mt-3 border-t border-border pt-3 text-xs text-subtle-foreground">
        {metric.footer}
      </div>
    </Card>
  );
}
