import { Badge } from "@/components/ui/badge";
import { priorityMeta } from "@/lib/meta";
import type { Priority } from "@/lib/types";

export function PriorityBadge({ priority }: { priority: Priority }) {
  const meta = priorityMeta[priority];
  return (
    <Badge style={{ backgroundColor: meta.soft, color: meta.text }}>
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ backgroundColor: meta.color }}
      />
      {meta.label}
    </Badge>
  );
}
