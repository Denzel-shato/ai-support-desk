/**
 * A small in-memory limiter for the login route: after MAX_FAILURES failed
 * attempts from one client within WINDOW_MS, further attempts are refused until
 * the window passes. LIMITATION: state is per server process, so on a
 * multi-instance or serverless deployment each instance counts separately.
 * That still slows guessing; it is not a substitute for a strong password.
 */

export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60_000;
const MAX_TRACKED = 5000;

interface Entry {
  failures: number;
  firstAt: number;
}

export class LoginRateLimiter {
  private entries = new Map<string, Entry>();

  /** Seconds to wait, or 0 when the client may try. */
  retryAfterSeconds(key: string, nowMs: number): number {
    const e = this.entries.get(key);
    if (!e) return 0;
    if (nowMs - e.firstAt >= WINDOW_MS) {
      this.entries.delete(key);
      return 0;
    }
    return e.failures >= MAX_FAILURES
      ? Math.ceil((e.firstAt + WINDOW_MS - nowMs) / 1000)
      : 0;
  }

  recordFailure(key: string, nowMs: number): void {
    const e = this.entries.get(key);
    if (!e || nowMs - e.firstAt >= WINDOW_MS) {
      if (this.entries.size >= MAX_TRACKED) this.entries.clear();
      this.entries.set(key, { failures: 1, firstAt: nowMs });
    } else {
      e.failures += 1;
    }
  }

  recordSuccess(key: string): void {
    this.entries.delete(key);
  }
}

export const loginLimiter = new LoginRateLimiter();
