"use client";

import { useState, type FormEvent } from "react";
import { LifeBuoy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { safeNextPath } from "@/lib/auth/next-path";

export function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        const next = safeNextPath(new URLSearchParams(window.location.search).get("next"));
        window.location.href = next;
        return;
      }
      const body = (await res.json().catch(() => null)) as {
        error?: { message?: string; missing?: string[] };
      } | null;
      const missing = body?.error?.missing?.length
        ? ` Missing: ${body.error.missing.join(", ")}.`
        : "";
      setError((body?.error?.message ?? "Sign-in failed. Try again.") + missing);
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-surface p-6 shadow-sm"
      >
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-md bg-accent text-white">
            <LifeBuoy className="size-4" aria-hidden />
          </span>
          <h1 className="text-[15px] font-semibold tracking-tight">AI Support Desk</h1>
        </div>
        <p className="text-[13px] text-muted-foreground">Sign in to continue.</p>

        <div className="space-y-1.5">
          <label htmlFor="username" className="text-xs font-medium text-muted-foreground">
            Username
          </label>
          <Input
            id="username"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="password" className="text-xs font-medium text-muted-foreground">
            Password
          </label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        {error && (
          <p role="alert" className="text-[13px] text-[#C93A2E]">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" disabled={busy}>
          {busy && <Loader2 className="animate-spin" aria-hidden />}
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </main>
  );
}
