"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, Menu, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isActive, navItems } from "./nav-config";

export function Header({ onOpenNav }: { onOpenNav: () => void }) {
  const pathname = usePathname();
  const current =
    navItems.find((item) => isActive(pathname, item.href)) ?? navItems[0];
  // /tickets/<id> gets an extra breadcrumb level back to the list.
  const isTicketDetail = /^\/tickets\/[^/]+/.test(pathname);

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/90 px-4 backdrop-blur lg:px-6">
      <Button
        variant="ghost"
        size="icon"
        className="lg:hidden"
        onClick={onOpenNav}
        aria-label="Open navigation"
      >
        <Menu />
      </Button>

      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
        <Link
          href="/"
          className="hidden text-[13px] text-muted-foreground transition-colors hover:text-foreground sm:inline"
        >
          Support Desk
        </Link>
        <ChevronRight
          className="hidden size-3.5 text-subtle-foreground sm:inline"
          aria-hidden
        />
        {isTicketDetail && (
          <>
            <Link
              href="/tickets"
              className="hidden text-[13px] text-muted-foreground transition-colors hover:text-foreground sm:inline"
            >
              All tickets
            </Link>
            <ChevronRight
              className="hidden size-3.5 text-subtle-foreground sm:inline"
              aria-hidden
            />
          </>
        )}
        <h1 className="truncate text-[15px] font-semibold tracking-tight">
          {isTicketDetail ? "Ticket details" : current.title}
        </h1>
      </nav>

      <div className="ml-auto flex items-center gap-2">
        <div className="relative hidden w-64 md:block">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle-foreground"
            aria-hidden
          />
          <Input
            type="search"
            placeholder="Search tickets, customers"
            aria-label="Search tickets and customers"
            className="pl-8"
          />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label="Search"
        >
          <Search />
        </Button>
      </div>
    </header>
  );
}
