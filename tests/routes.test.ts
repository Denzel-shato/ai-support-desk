/* eslint-disable @typescript-eslint/no-explicit-any -- tests read untyped workflow JSON and dynamic route modules */
// Calls the real route handlers with NO session cookie. Auth is checked
// before any Firestore access, so no credentials or database are needed.
import test from "node:test";
import assert from "node:assert/strict";

const ID = { params: Promise.resolve({ id: "t1", messageId: "11111111-1111-4111-8111-111111111111" }) };
const json = (method: string, body: unknown = {}) =>
  new Request("http://localhost/api/x", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const routes: [string, string, () => Promise<{ default?: never } & Record<string, any>>, string][] = [
  ["tickets", "GET", () => import("@/app/api/tickets/route"), "GET"],
  ["tickets/[id]", "GET", () => import("@/app/api/tickets/[id]/route"), "GET"],
  ["tickets/[id]/messages", "GET", () => import("@/app/api/tickets/[id]/messages/route"), "GET"],
  ["tickets/[id]/review", "POST", () => import("@/app/api/tickets/[id]/review/route"), "POST"],
  ["tickets/[id]/send", "POST", () => import("@/app/api/tickets/[id]/send/route"), "POST"],
  ["tickets/[id]/resolution", "POST", () => import("@/app/api/tickets/[id]/resolution/route"), "POST"],
  ["tickets/[id]/reconcile", "POST", () => import("@/app/api/tickets/[id]/reconcile/route"), "POST"],
  ["tickets/[id]/followups", "POST", () => import("@/app/api/tickets/[id]/followups/route"), "POST"],
  ["followups/[messageId]/reconcile", "POST", () => import("@/app/api/tickets/[id]/followups/[messageId]/reconcile/route"), "POST"],
  ["knowledge-base", "GET", () => import("@/app/api/knowledge-base/route"), "GET"],
  ["knowledge-base", "POST", () => import("@/app/api/knowledge-base/route"), "POST"],
  ["knowledge-base/[id]", "PATCH", () => import("@/app/api/knowledge-base/[id]/route"), "PATCH"],
  ["settings", "GET", () => import("@/app/api/settings/route"), "GET"],
  ["settings", "PUT", () => import("@/app/api/settings/route"), "PUT"],
  ["settings/status", "GET", () => import("@/app/api/settings/status/route"), "GET"],
  ["auth/session", "GET", () => import("@/app/api/auth/session/route"), "GET"],
  ["overview", "GET", () => import("@/app/api/overview/route"), "GET"],
];

test("every API route file is in the unauthenticated-rejection list (a new route can't ship unprotected unnoticed)", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "route.ts") found.push(full.split("src/app/api/")[1].replace(/\/route\.ts$/, ""));
    }
  };
  walk(join(process.cwd(), "src/app/api"));
  // login and logout are the only routes that are meant to work signed out.
  const open = new Set(["auth/login", "auth/logout"]);
  const sources = routes.map(([, , load]) => String(load));
  for (const f of found) {
    if (open.has(f)) continue;
    assert.ok(
      sources.some((src) => src.includes(`@/app/api/${f}/route`)),
      `API route "${f}" is not covered by the unauthenticated-access test`,
    );
  }
  assert.ok(found.length >= 14);
});

for (const configured of [true, false]) {
  test(`unauthenticated requests are rejected by every API route (auth ${configured ? "configured" : "NOT configured"})`, async () => {
    const saved = { ...process.env };
    if (configured) {
      process.env.AUTH_USERNAME = "admin";
      process.env.AUTH_PASSWORD_HASH = "scrypt:16384:8:1:AAAAAAAAAAAAAAAAAAAAAA==:" + "A".repeat(86) + "==";
      process.env.AUTH_SESSION_SECRET = "s".repeat(48);
    } else {
      delete process.env.AUTH_USERNAME; delete process.env.AUTH_PASSWORD_HASH; delete process.env.AUTH_SESSION_SECRET;
    }
    try {
      for (const [label, method, load, exportName] of routes) {
        const handler = (await load())[exportName];
        const req = method === "GET" ? new Request("http://localhost/api/x") : json(method, { action: "approve", outcome: "delivered", active: true });
        const res: Response = await handler(req, ID);
        assert.equal(res.status, configured ? 401 : 503, `${method} ${label} answered ${res.status}`);
        const body = await res.json();
        assert.equal(body.error.code, configured ? "unauthenticated" : "auth_not_configured");
        assert.equal(JSON.stringify(body).includes("stack"), false);
      }
    } finally {
      process.env = saved;
    }
  });
}

test("a forged cookie is rejected by a route", async () => {
  process.env.AUTH_USERNAME = "admin";
  process.env.AUTH_PASSWORD_HASH = "scrypt:16384:8:1:AAAAAAAAAAAAAAAAAAAAAA==:" + "A".repeat(86) + "==";
  process.env.AUTH_SESSION_SECRET = "s".repeat(48);
  const { GET } = await import("@/app/api/tickets/route");
  const res = await GET(new Request("http://localhost/api/tickets", { headers: { cookie: "asd_session=eyJzdWIiOiJhZG1pbiJ9.AAAA" } }));
  assert.equal(res.status, 401);
});
