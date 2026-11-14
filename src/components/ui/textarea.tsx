import * as React from "react";
import { cn } from "@/lib/utils";

export function Textarea({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "min-h-40 w-full resize-y rounded-md border border-border-strong bg-surface px-3 py-2 text-[13px] leading-relaxed placeholder:text-subtle-foreground transition-colors hover:border-subtle-foreground focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent/25 disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-70",
        className,
      )}
      {...props}
    />
  );
}
