import * as React from "react";
import { cn } from "@/lib/utils";

export function Input({
  className,
  type = "text",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type={type}
      className={cn(
        "h-8 w-full rounded-md border border-border-strong bg-surface px-3 text-[13px] placeholder:text-subtle-foreground transition-colors hover:border-subtle-foreground focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent/25",
        className,
      )}
      {...props}
    />
  );
}
