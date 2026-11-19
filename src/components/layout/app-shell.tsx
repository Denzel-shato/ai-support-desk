"use client";

import { Suspense, useState } from "react";
import { SettingsProvider } from "@/components/settings/settings-context";
import { Header } from "./header";
import { MobileDrawer, Sidebar } from "./sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <SettingsProvider>
    <div className="min-h-screen">
      {/* Sidebar, drawer and header read the current pathname. On dynamic
          routes such as /tickets/[id] it isn't known while prerendering, so
          each sits in Suspense with a same-size placeholder. */}
      <Suspense
        fallback={
          <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-border bg-background lg:block" />
        }
      >
        <Sidebar />
      </Suspense>
      <Suspense fallback={null}>
        <MobileDrawer open={navOpen} onClose={() => setNavOpen(false)} />
      </Suspense>
      <div className="lg:pl-60">
        <Suspense
          fallback={
            <header className="sticky top-0 z-20 h-14 border-b border-border bg-background/90" />
          }
        >
          <Header onOpenNav={() => setNavOpen(true)} />
        </Suspense>
        <main className="mx-auto w-full max-w-[1280px] px-4 py-6 lg:px-6">
          {children}
        </main>
      </div>
    </div>
    </SettingsProvider>
  );
}
