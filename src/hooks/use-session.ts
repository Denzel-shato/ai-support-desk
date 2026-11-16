"use client";

import { useCallback, useEffect, useState } from "react";

export interface SessionState {
  username: string | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

/** The signed-in user, from the server. Never trusts anything stored in the browser. */
export function useSession(): SessionState {
  const [username, setUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/session", { cache: "no-store" })
      .then(async (res) => {
        if (res.status === 401) {
          // Session expired or cleared: go to the sign-in page.
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload on purpose: clears client state and re-runs the sign-in gate
          window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
          return null;
        }
        return res.ok ? ((await res.json()) as { user?: { username?: string } }) : null;
      })
      .then((body) => {
        if (!cancelled) setUsername(body?.user?.username ?? null);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload on purpose: clears client state and re-runs the sign-in gate
      window.location.href = "/login";
    }
  }, []);

  return { username, loading, signOut };
}
