"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { PriorityBadge } from "@/components/overview/priority-badge";
import type { EscalationRow } from "@/lib/escalations";
import { statusMeta } from "@/lib/meta";
import { useDashboardSettings } from "@/components/settings/settings-context";
import { formatCreatedShort } from "@/lib/tickets-list";

const th =
  "whitespace-nowrap px-4 py-2 text-left text-xs font-medium text-muted-foreground";

function href(id: string) {
  return `/tickets/${encodeURIComponent(id)}`;
}

/** The ticket's stored status, with a dot coloured by where it stands. */
function StoredStatus({ row }: { row: EscalationRow }) {
  if (!row.statusLabel) {
    return <span className="text-[13px] text-subtle-foreground">Not recorded</span>;
  }
  return (
    <span className="inline-flex items-center gap-2 text-[13px]">
      <span
        aria-hidden
        className="size-2 rounded-full"
        style={{ backgroundColor: statusMeta[row.statusTone].color }}
      />
      {row.statusLabel}
    </span>
  );
}

function Reason({ reason }: { reason: string | null }) {
  return reason ? (
    <span title={reason} className="line-clamp-2 text-[13px] leading-snug">
      {reason}
    </span>
  ) : (
    <span className="text-[13px] text-subtle-foreground">Not recorded</span>
  );
}

/** Table from md up, stacked list below it. Every row opens the ticket. */
export function EscalationsTable({ rows }: { rows: EscalationRow[] }) {
  const router = useRouter();
  const { timeZone } = useDashboardSettings().settings;

  return (
    <>
      <div className="hidden overflow-x-auto border-t border-border md:block">
        <table className="w-full min-w-[1100px] border-collapse">
          <thead className="bg-surface-muted">
            <tr className="border-b border-border">
              <th scope="col" className={th}>
                Customer
              </th>
              <th scope="col" className={th}>
                Summary
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
                Escalation reason
              </th>
              <th scope="col" className={th}>
                Escalated
              </th>
              <th scope="col" className={th}>
                Status
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => router.push(href(r.id))}
                className="cursor-pointer align-top transition-colors hover:bg-surface-muted"
              >
                <td className="max-w-[220px] px-4 py-3">
                  <p className="truncate text-[13px] font-medium">{r.customer}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {r.customerEmail}
                  </p>
                </td>
                <td className="max-w-[260px] px-4 py-3">
                  <Link
                    href={href(r.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="block truncate rounded text-[13px] font-medium hover:text-accent"
                  >
                    {r.subject}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                  {r.id}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-[13px] text-muted-foreground">
                  {r.category}
                </td>
                <td className="px-4 py-3">
                  <PriorityBadge priority={r.priority} />
                </td>
                <td className="w-[260px] max-w-[260px] px-4 py-3">
                  <Reason reason={r.reason} />
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  {r.escalatedAt ? (
                    <>
                      <p className="text-[13px]">
                        {formatCreatedShort(r.escalatedAt, timeZone) ?? "Unknown date"}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {r.escalatedAgo}
                      </p>
                    </>
                  ) : (
                    <span className="text-[13px] text-subtle-foreground">
                      Not recorded
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-3">
                  <StoredStatus row={r} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-border border-t border-border md:hidden">
        {rows.map((r) => (
          <li key={r.id}>
            <Link
              href={href(r.id)}
              className="block px-4 py-3 transition-colors hover:bg-surface-muted"
            >
              <p className="text-[13px] font-medium">{r.subject}</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {r.customer} · {r.customerEmail}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <PriorityBadge priority={r.priority} />
                <StoredStatus row={r} />
                <span className="text-xs text-muted-foreground">{r.category}</span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                <span className="text-subtle-foreground">Reason: </span>
                {r.reason ?? "Not recorded"}
              </p>
              <p className="mt-2 break-all text-xs text-subtle-foreground">
                {r.id} · Escalated{" "}
                {r.escalatedAt
                  ? (formatCreatedShort(r.escalatedAt, timeZone) ?? "date unknown")
                  : "date not recorded"}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
