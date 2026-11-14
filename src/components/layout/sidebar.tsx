"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LifeBuoy, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { currentUser } from "@/lib/mock-data";
import { Avatar } from "./avatar";
import { isActive, navItems } from "./nav-config";

export function Wordmark() {
  return (
    <Link href="/" className="flex items-center gap-2 rounded-md">
      <span className="flex size-7 items-center justify-center rounded-md bg-accent text-white">
        <LifeBuoy className="size-4" aria-hidden />
      </span>
      <span className="text-[15px] font-semibold tracking-tight">
        AI Support Desk
      </span>
    </Link>
  );
}

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center px-4">
        <Wordmark />
      </div>

      <nav aria-label="Main" className="flex-1 px-2 py-2">
        <ul className="space-y-0.5">
          {navItems.map((item) => {
            const active = isActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
                    active
                      ? "bg-surface text-foreground shadow-[0_0_0_1px_var(--border)]"
                      : "text-muted-foreground hover:bg-black/5 hover:text-foreground",
                  )}
                >
                  {active && (
                    <span
                      aria-hidden
                      className="absolute -left-2 top-1.5 h-5 w-0.5 rounded-full bg-accent"
                    />
                  )}
                  <Icon
                    className={cn(
                      "size-4",
                      active ? "text-accent" : "text-subtle-foreground",
                    )}
                    aria-hidden
                  />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-border p-3">
        <div className="flex items-center gap-2.5 rounded-md px-1 py-1">
          <Avatar initials={currentUser.initials} />
          <div className="min-w-0 leading-tight">
            <p className="truncate text-[13px] font-medium">
              {currentUser.name}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {currentUser.role}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-border bg-background lg:block">
      <SidebarContent />
    </aside>
  );
}

export function MobileDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        "fixed inset-0 z-40 lg:hidden",
        open ? "visible" : "invisible",
      )}
      aria-hidden={!open}
    >
      <div
        onClick={onClose}
        className={cn(
          "absolute inset-0 bg-black/30 transition-opacity",
          open ? "opacity-100" : "opacity-0",
        )}
      />
      <aside
        className={cn(
          "absolute inset-y-0 left-0 w-64 border-r border-border bg-background transition-transform",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close navigation"
          className="absolute right-2 top-3 rounded-md p-1.5 text-muted-foreground hover:bg-black/5"
        >
          <X className="size-4" />
        </button>
        <SidebarContent onNavigate={onClose} />
      </aside>
    </div>
  );
}
