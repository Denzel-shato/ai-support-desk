import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { createSessionToken, verifySessionToken, readCookie, SESSION_COOKIE } from "@/lib/auth/session";
import { AuthError, requireAuth } from "@/lib/auth/require-auth";
import { LoginRateLimiter, MAX_FAILURES, WINDOW_MS } from "@/lib/auth/rate-limit";
import { missingAuthSettings } from "@/lib/auth/config";
import { safeNextPath } from "@/lib/auth/next-path";
import { isSameOriginRequest } from "@/lib/request-guard";

const SECRET = "x".repeat(48);
const NOW = 1_800_000_000_000;

async function env() {
  return { AUTH_USERNAME: "admin", AUTH_PASSWORD_HASH: await hashPassword("correct horse battery"), AUTH_SESSION_SECRET: SECRET };
}
const req = (cookie?: string) => new Request("http://localhost/api/tickets", cookie ? { headers: { cookie } } : {});

test("password hashing: right password verifies, wrong or malformed does not, no '$' in stored form", async () => {
  const h = await hashPassword("correct horse battery");
  assert.ok(!h.includes("$"));
  assert.equal(await verifyPassword("correct horse battery", h), true);
  assert.equal(await verifyPassword("wrong", h), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
});

test("session tokens: valid verifies; tampered, expired, wrong-secret and junk are rejected", async () => {
  const t = await createSessionToken("admin", SECRET, NOW);
  assert.equal((await verifySessionToken(t, SECRET, NOW + 1000))?.sub, "admin");
  const [body, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "root", iat: 1, exp: 9e9 })).toString("base64url");
  assert.equal(await verifySessionToken(`${forged}.${sig}`, SECRET, NOW), null);
  assert.equal(await verifySessionToken(`${body}.${sig.slice(0, -2)}AA`, SECRET, NOW), null);
  assert.equal(await verifySessionToken(t, "y".repeat(48), NOW), null);
  assert.equal(await verifySessionToken(t, SECRET, NOW + 9 * 3600 * 1000), null);
  for (const junk of ["", "abc", "a.b.c", undefined, null]) assert.equal(await verifySessionToken(junk as never, SECRET, NOW), null);
  assert.equal(await verifySessionToken(t, "short", NOW), null);
});

test("requireAuth: no cookie, bad cookie and wrong user are 401; valid cookie passes", async () => {
  const e = await env();
  await assert.rejects(requireAuth(req(), e, NOW), (x) => x instanceof AuthError && x.status === 401);
  await assert.rejects(requireAuth(req(`${SESSION_COOKIE}=garbage`), e, NOW), (x) => x instanceof AuthError && x.status === 401);
  const other = await createSessionToken("someone-else", SECRET, NOW);
  await assert.rejects(requireAuth(req(`${SESSION_COOKIE}=${other}`), e, NOW), (x) => x instanceof AuthError && x.status === 401);
  const ok = await createSessionToken("admin", SECRET, NOW);
  assert.equal((await requireAuth(req(`a=b; ${SESSION_COOKIE}=${ok}`), e, NOW + 5)).sub, "admin");
});

test("requireAuth fails CLOSED when auth is not configured, even with a plausible cookie", async () => {
  const token = await createSessionToken("admin", SECRET, NOW);
  for (const partial of [{}, { AUTH_USERNAME: "admin" }, { AUTH_USERNAME: "admin", AUTH_PASSWORD_HASH: "scrypt:1:1:1:a:b", AUTH_SESSION_SECRET: "short" }]) {
    await assert.rejects(requireAuth(req(`${SESSION_COOKIE}=${token}`), partial, NOW), (x) => x instanceof AuthError && x.status === 503);
  }
  assert.deepEqual(missingAuthSettings({}), ["AUTH_USERNAME", "AUTH_PASSWORD_HASH", "AUTH_SESSION_SECRET"]);
});

test("login rate limiter blocks after repeated failures and recovers after the window", () => {
  const l = new LoginRateLimiter();
  for (let i = 0; i < MAX_FAILURES; i++) l.recordFailure("ip", NOW);
  assert.ok(l.retryAfterSeconds("ip", NOW + 1000) > 0);
  assert.equal(l.retryAfterSeconds("other", NOW), 0);
  assert.equal(l.retryAfterSeconds("ip", NOW + WINDOW_MS + 1), 0);
  l.recordFailure("a", NOW); l.recordSuccess("a");
  assert.equal(l.retryAfterSeconds("a", NOW), 0);
});

test("cookie parsing, post-login redirect safety, same-origin guard", () => {
  assert.equal(readCookie("a=1; b=2", "b"), "2");
  assert.equal(readCookie(null, "b"), null);
  assert.equal(safeNextPath("/tickets/abc"), "/tickets/abc");
  for (const bad of ["//evil.com", "https://evil.com", "/\\evil", "/api/tickets", "/login", null]) assert.equal(safeNextPath(bad as never), "/");
  const h = (o: Record<string, string>) => new Request("http://localhost/x", { method: "POST", headers: o });
  assert.equal(isSameOriginRequest(h({ origin: "http://localhost", host: "localhost" })), true);
  assert.equal(isSameOriginRequest(h({ origin: "http://evil.com", host: "localhost" })), false);
  assert.equal(isSameOriginRequest(h({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(isSameOriginRequest(h({ "sec-fetch-site": "same-origin" })), true);
  assert.equal(isSameOriginRequest(h({})), true);
});
