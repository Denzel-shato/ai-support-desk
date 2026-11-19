import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  hasActiveEscalationFilters,
  type EscalationFilters,
} from "@/lib/escalations";
import type { SortOrder } from "@/lib/tickets-list";

export function EscalationFiltersBar({
  filters,
  categories,
  onChange,
  onClear,
}: {
  filters: EscalationFilters;
  categories: string[];
  onChange: (patch: Partial<EscalationFilters>) => void;
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
          placeholder="Search name, email, summary, ticket ID"
          aria-label="Search escalations by customer name, email, summary or ticket ID"
          className="pl-8"
        />
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:items-center">
        <Select
          aria-label="Filter by priority"
          value={filters.priority}
          onChange={(e) =>
            onChange({ priority: e.target.value as EscalationFilters["priority"] })
          }
        >
          <option value="all">All priorities</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
        </Select>

        <Select
          aria-label="Filter by resolution"
          value={filters.status}
          onChange={(e) =>
            onChange({ status: e.target.value as EscalationFilters["status"] })
          }
        >
          <option value="all">All escalations</option>
          <option value="active">Active</option>
          <option value="resolved">Resolved</option>
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
          aria-label="Sort by escalation date"
          value={filters.sort}
          onChange={(e) => onChange({ sort: e.target.value as SortOrder })}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </Select>
      </div>

      {hasActiveEscalationFilters(filters) && (
        <Button variant="ghost" size="sm" onClick={onClear} className="self-start">
          <X />
          Clear filters
        </Button>
      )}
    </div>
  );
}
