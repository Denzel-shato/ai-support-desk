"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { PriorityBadge } from "@/components/overview/priority-badge";
import { StatusBadge } from "@/components/overview/status-badge";
import { formatCreatedShort } from "@/lib/tickets-list";
import type { Ticket } from "@/lib/types";

const th =
  "whitespace-nowrap px-4 py-2 text-left text-xs font-medium text-muted-foreground";

function href(id: string) {
  return `/tickets/${encodeURIComponent(id)}`;
}

/** Table from md up, stacked list below it. Every row opens the ticket. */
export function TicketsTable({ tickets }: { tickets: Ticket[] }) {
  const router = useRouter();

  return (
    <>
      <div className="hidden overflow-x-auto border-t border-border md:block">
        <table className="w-full min-w-[960px] border-collapse">
          <thead className="bg-surface-muted">
            <tr className="border-b border-border">
              <th scope="col" className={th}>
                Customer
              </th>
              <th scope="col" className={th}>
                Subject
              </th>
              <th scope="col" className={th}>
                Ticket ID
              </th>
              <th scope="col" className={th}>
                Category
              </th>
              <th scope="col" className={th}>
                Priority
              </th>
              <th scope="col" className={th}>
                Status
              </th>
              <th scope="col" className={`${th} text-right`}>
                Created
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {tickets.map((t) => (
              <tr
                key={t.id}
                onClick={() => router.push(href(t.id))}
                className="cursor-pointer transition-colors hover:bg-surface-muted"
              >
                <td className="max-w-[240px] px-4 py-3">
                  <p className="truncate text-[13px] font-medium">
                    {t.customer}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {t.customerEmail}
                  </p>
                </td>
                <td className="max-w-[300px] px-4 py-3">
                  <Link
                    href={href(t.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="block truncate rounded text-[13px] font-medium hover:text-accent"
                  >
                    {t.subject}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                  {t.id}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-[13px] text-muted-foreground">
                  {t.category}
                </td>
                <td className="px-4 py-3">
                  <PriorityBadge priority={t.priority} />
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <StatusBadge status={t.status} />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  <p className="text-[13px]">
                    {formatCreatedShort(t.createdAt) ?? "Unknown date"}
                  </p>
                  {t.createdAt && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t.submittedLabel}
                    </p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-border border-t border-border md:hidden">
        {tickets.map((t) => (
          <li key={t.id}>
            <Link
              href={href(t.id)}
              className="block px-4 py-3 transition-colors hover:bg-surface-muted"
            >
              <p className="text-[13px] font-medium">{t.subject}</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {t.customer} · {t.customerEmail}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <PriorityBadge priority={t.priority} />
                <StatusBadge status={t.status} />
                <span className="text-xs text-muted-foreground">
                  {t.category}
                </span>
              </div>
              <p className="mt-2 break-all text-xs text-subtle-foreground">
                {t.id} · {formatCreatedShort(t.createdAt) ?? "Unknown date"}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
