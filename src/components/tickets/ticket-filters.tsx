import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { priorityMeta, statusMeta } from "@/lib/meta";
import {
  hasActiveFilters,
  type SortOrder,
  type TicketFilters,
} from "@/lib/tickets-list";
import type { TicketStatus } from "@/lib/types";

const PRIORITIES = ["urgent", "high", "medium", "low"] as const;
const STATUSES: TicketStatus[] = [
  "new",
  "open",
  "awaiting_review",
  "escalated",
  "resolved",
];

export function TicketFiltersBar({
  filters,
  categories,
  onChange,
  onClear,
}: {
  filters: TicketFilters;
  categories: string[];
  onChange: (patch: Partial<TicketFilters>) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 pb-4 lg:flex-row lg:items-center">
      <div className="relative min-w-0 lg:max-w-sm lg:flex-1">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={filters.search}
          onChange={(e) => onChange({ search: e.target.value })}
          placeholder="Search name, email, message, ticket ID"
          aria-label="Search tickets by customer name, email, message, summary or ticket ID"
          className="pl-8"
        />
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:flex lg:items-center">
        <Select
          aria-label="Filter by priority"
          value={filters.priority}
          onChange={(e) =>
            onChange({ priority: e.target.value as TicketFilters["priority"] })
          }
        >
          <option value="all">All priorities</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {priorityMeta[p].label}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Filter by category"
          value={filters.category}
          onChange={(e) => onChange({ category: e.target.value })}
        >
          <option value="all">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Filter by status"
          value={filters.status}
          onChange={(e) =>
            onChange({ status: e.target.value as TicketFilters["status"] })
          }
        >
          <option value="all">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusMeta[s].label}
            </option>
          ))}
        </Select>

        <Select
          aria-label="Sort by creation date"
          value={filters.sort}
          onChange={(e) => onChange({ sort: e.target.value as SortOrder })}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </Select>
      </div>

      {hasActiveFilters(filters) && (
        <Button variant="ghost" size="sm" onClick={onClear} className="self-start">
          <X />
          Clear filters
        </Button>
      )}
    </div>
  );
}
