import { statusMeta } from "@/lib/meta";
import type { TicketStatus } from "@/lib/types";

export function StatusBadge({ status }: { status: TicketStatus }) {
  const meta = statusMeta[status];
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-foreground">
      <span
        aria-hidden
        className="size-2 rounded-full"
        style={{ backgroundColor: meta.color }}
      />
      {meta.label}
    </span>
  );
}
