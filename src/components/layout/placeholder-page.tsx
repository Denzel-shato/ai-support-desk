import type { LucideIcon } from "lucide-react";

export function PlaceholderPage({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex min-h-[420px] items-center justify-center rounded-lg border border-dashed border-border-strong bg-surface-muted p-8">
      <div className="max-w-sm text-center">
        <span className="mx-auto flex size-9 items-center justify-center rounded-md border border-border bg-surface text-muted-foreground">
          <Icon className="size-4" aria-hidden />
        </span>
        <h2 className="mt-3 text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
