"use client";

import { useState } from "react";
import { Header } from "./header";
import { MobileDrawer, Sidebar } from "./sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="min-h-screen">
      <Sidebar />
      <MobileDrawer open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="lg:pl-60">
        <Header onOpenNav={() => setNavOpen(true)} />
        <main className="mx-auto w-full max-w-[1280px] px-4 py-6 lg:px-6">
          {children}
        </main>
      </div>
    </div>
  );
}
