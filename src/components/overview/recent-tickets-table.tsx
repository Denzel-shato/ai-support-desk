import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Ticket } from "@/lib/types";
import { PriorityBadge } from "./priority-badge";
import { StatusBadge } from "./status-badge";

const th =
  "whitespace-nowrap px-4 py-2 text-left text-xs font-medium text-muted-foreground";

export function RecentTicketsTable({ tickets }: { tickets: Ticket[] }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="items-center">
        <div>
          <CardTitle>Recent tickets</CardTitle>
          <CardDescription>
            Latest requests, classified by AI as they arrive
          </CardDescription>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/tickets">
            View all tickets
            <ArrowRight />
          </Link>
        </Button>
      </CardHeader>

      <div className="overflow-x-auto border-t border-border">
        <table className="w-full min-w-[860px] border-collapse">
          <thead className="bg-surface-muted">
            <tr className="border-b border-border">
              <th scope="col" className={th}>
                Ticket / Customer
              </th>
              <th scope="col" className={th}>
                Category
              </th>
              <th scope="col" className={th}>
                Priority
              </th>
              <th scope="col" className={th}>
                AI classification
              </th>
              <th scope="col" className={th}>
                Status
              </th>
              <th scope="col" className={`${th} text-right`}>
                Submitted
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {tickets.map((t) => (
              <tr
                key={t.id}
                className="transition-colors hover:bg-surface-muted"
              >
                <td className="max-w-[340px] px-4 py-3">
                  <p className="truncate text-[13px] font-medium">
                    {t.subject}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {t.customer}
                    {" · "}
                    {t.customerEmail}
                  </p>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-[13px] text-muted-foreground">
                  {t.category}
                </td>
                <td className="px-4 py-3">
                  <PriorityBadge priority={t.priority} />
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <span className="inline-flex items-center gap-1.5 text-[13px]">
                    <Sparkles
                      className="size-3.5 text-accent"
                      aria-hidden
                    />
                    {t.aiClassification}
                    {t.aiDetail && (
                      <span className="text-xs text-subtle-foreground">
                        {t.aiDetail}
                      </span>
                    )}
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <StatusBadge status={t.status} />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right text-[13px] text-muted-foreground">
                  {t.submittedLabel}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
