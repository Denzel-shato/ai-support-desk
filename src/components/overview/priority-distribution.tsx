import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { priorityMeta } from "@/lib/meta";
import type { PriorityShare } from "@/lib/types";

export function PriorityDistribution({ data }: { data: PriorityShare[] }) {
  const total = data.reduce((sum, d) => sum + d.count, 0);
  const ratio = (count: number) => (total > 0 ? count / total : 0);

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div>
          <CardTitle>Priority distribution</CardTitle>
          <CardDescription>
            <span className="tabular">{total.toLocaleString("en-US")}</span>{" "}
            tickets by AI-assigned priority
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <div
          className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full"
          role="img"
          aria-label={data
            .map((d) => `${priorityMeta[d.priority].label} ${d.count}`)
            .join(", ")}
        >
          {data.map((d) => (
            <div
              key={d.priority}
              style={{
                width: `${ratio(d.count) * 100}%`,
                backgroundColor: priorityMeta[d.priority].color,
              }}
            />
          ))}
        </div>

        <ul className="flex flex-1 flex-col divide-y divide-border">
          {data.map((d) => {
            const meta = priorityMeta[d.priority];
            const pct = ratio(d.count) * 100;
            return (
              <li
                key={d.priority}
                className="flex flex-1 items-center gap-3 text-[13px]"
              >
                <span
                  aria-hidden
                  className="size-2.5 rounded-sm"
                  style={{ backgroundColor: meta.color }}
                />
                <span className="flex-1 font-medium">{meta.label}</span>
                <span className="tabular w-12 text-right text-muted-foreground">
                  {pct.toFixed(0)}%
                </span>
                <span className="tabular w-12 text-right font-medium">
                  {d.count.toLocaleString("en-US")}
                </span>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
