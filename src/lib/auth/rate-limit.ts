/**
 * A small in-memory limiter for the login route: after MAX_FAILURES failed
 * attempts from one client within WINDOW_MS, further attempts are refused until
 * the window passes. LIMITATION: state is per server process, so on a
 * multi-instance or serverless deployment each instance counts separately.
 * That still slows guessing; it is not a substitute for a strong password.
 */

export const MAX_FAILURES = 5;
/**
 * Failures allowed across ALL clients in one window. A client key comes from
 * forwarding headers that an attacker may be able to rotate, so this cap is
 * what still stops guessing then. The trade-off: a sustained attack can lock
 * the one real user out for up to WINDOW_MS (a lockout, not a break-in).
 */
export const MAX_GLOBAL_FAILURES = 20;
export const WINDOW_MS = 15 * 60_000;
const MAX_TRACKED = 5000;

interface Entry {
  failures: number;
  firstAt: number;
}

export class LoginRateLimiter {
  private entries = new Map<string, Entry>();
  private global: Entry | null = null;

  /**
   * Checks the limits and, if the attempt may go ahead, counts it as a failure
   * straight away. Counting BEFORE the slow password check means parallel
   * guesses can't all slip past the limit while the first one is still being
   * verified. A successful sign-in then calls recordSuccess to refund it.
   * Returns seconds to wait, or 0 when the attempt is allowed.
   */
  reserve(key: string, nowMs: number): number {
    const wait = Math.max(this.retryAfterSeconds(key, nowMs), this.globalWait(nowMs));
    if (wait > 0) return wait;
    this.recordFailure(key, nowMs);
    this.bumpGlobal(nowMs, 1);
    return 0;
  }

  private globalWait(nowMs: number): number {
    const g = this.global;
    if (!g) return 0;
    if (nowMs - g.firstAt >= WINDOW_MS) {
      this.global = null;
      return 0;
    }
    return g.failures >= MAX_GLOBAL_FAILURES ? Math.ceil((g.firstAt + WINDOW_MS - nowMs) / 1000) : 0;
  }

  private bumpGlobal(nowMs: number, by: number): void {
    const g = this.global;
    if (!g || nowMs - g.firstAt >= WINDOW_MS) {
      if (by > 0) this.global = { failures: by, firstAt: nowMs };
    } else {
      g.failures = Math.max(0, g.failures + by);
    }
  }

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

  /** A successful sign-in clears this client's count and refunds the reserved slot. */
  recordSuccess(key: string, nowMs: number = Date.now()): void {
    this.entries.delete(key);
    this.bumpGlobal(nowMs, -1);
  }
}

export const loginLimiter = new LoginRateLimiter();
