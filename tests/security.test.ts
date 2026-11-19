/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic route modules */
// Security tests. What they prove: the route handlers' own checks (authentication, same-origin, id and body validation)
// and static properties of firestore.rules. What they do NOT prove: how Firestore itself evaluates the rules. That needs the
// Firebase emulator or a real project, neither of which was available; see docs/security.md.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { hashPassword } from "@/lib/auth/password";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import { parseArticleCreate } from "@/lib/knowledge-base";
import { parseReviewRequest } from "@/lib/response-workflow";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const SECRET = "k".repeat(48);
const AUTH = { AUTH_USERNAME: "admin", AUTH_PASSWORD_HASH: "", AUTH_SESSION_SECRET: SECRET };

async function withEnv<T>(extra: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  AUTH.AUTH_PASSWORD_HASH = await hashPassword("correct horse battery");
  Object.assign(process.env, AUTH);
  for (const k of ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"]) delete process.env[k];
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally { process.env = saved; }
}
const signingKey = () => `${SECRET}\n${AUTH.AUTH_PASSWORD_HASH}`;
const cookie = async (sub = "admin", key = signingKey(), now = Date.now(), ttl?: number) =>
  `${SESSION_COOKIE}=${await createSessionToken(sub, key, now, ttl)}`;
const call = (method: string, headers: Record<string, string>, body?: unknown) =>
  new Request("http://localhost/api/x", { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string, messageId = "11111111-1111-4111-8111-111111111111") => ({ params: Promise.resolve({ id, messageId }) });

const mutating: [string, string, () => Promise<any>, unknown][] = [
  ["review", "POST", () => import("@/app/api/tickets/[id]/review/route"), { action: "approve", finalResponse: "Hello" }],
  ["send", "POST", () => import("@/app/api/tickets/[id]/send/route"), {}],
  ["reconcile", "POST", () => import("@/app/api/tickets/[id]/reconcile/route"), { outcome: "delivered" }],
  ["followups", "POST", () => import("@/app/api/tickets/[id]/followups/route"), { messageId: "11111111-1111-4111-8111-111111111111", content: "Hi" }],
  ["followup reconcile", "POST", () => import("@/app/api/tickets/[id]/followups/[messageId]/reconcile/route"), { outcome: "delivered" }],
  ["kb create", "POST", () => import("@/app/api/knowledge-base/route"), { title: "T", category: "C", content: "Body" }],
  ["kb update", "PATCH", () => import("@/app/api/knowledge-base/[id]/route"), { active: false }],
  ["resolution", "POST", () => import("@/app/api/tickets/[id]/resolution/route"), { action: "resolve" }],
];
const idRoutes: [string, string, () => Promise<any>, unknown][] = [
  ["ticket get", "GET", () => import("@/app/api/tickets/[id]/route"), undefined],
  ["messages", "GET", () => import("@/app/api/tickets/[id]/messages/route"), undefined],
  ...mutating.filter((m) => m[0] !== "kb create"),
];

// ---- authentication / authorisation of the privileged operations ----------------------------------------------

test("credentials that are not the configured admin are rejected on every privileged route (wrong user, wrong key, expired)", async () => {
  await withEnv({}, async () => {
    const now = Date.now();
    const bad = {
      "validly signed, different username": await cookie("someone-else"),
      "signed with a different secret": await cookie("admin", "y".repeat(48)),
      expired: await cookie("admin", signingKey(), now - 10 * 3600_000),
      "empty cookie": `${SESSION_COOKIE}=`,
    };
    for (const [label, c] of Object.entries(bad)) {
      for (const [name, method, load, body] of [...idRoutes, ["kb create", "POST", () => import("@/app/api/knowledge-base/route"), mutating[5][3]] as any, ["tickets", "GET", () => import("@/app/api/tickets/route"), undefined] as any, ["kb list", "GET", () => import("@/app/api/knowledge-base/route"), undefined] as any, ["status", "GET", () => import("@/app/api/settings/status/route"), undefined] as any]) {
        const res: Response = await (await load())[method](call(method, { cookie: c }, body), ctx("t1"));
        assert.equal(res.status, 401, `${label}: ${method} ${name} answered ${res.status}`);
      }
    }
  });
});

test("a signed-in admin passes authentication and reaches Firestore (valid operations still work up to the database)", async () => {
  await withEnv({}, async () => {
    const c = await cookie();
    for (const [name, method, load, body] of idRoutes) {
      const res: Response = await (await load())[method](call(method, { cookie: c }, body), ctx("t1"));
      // No Firebase credentials in the test, so the first Firestore touch answers 503 firebase_not_configured:
      // authentication, same-origin, JSON and body checks all passed.
      assert.equal(res.status, 503, `${method} ${name} answered ${res.status}`);
      assert.equal((await res.json()).error.code, name === "send" || name === "followups" ? "send_not_configured" : "firebase_not_configured");
    }
    const session = await (await import("@/app/api/auth/session/route")).GET(call("GET", { cookie: c }));
    assert.equal(session.status, 200);
  });
});

test("cross-site and non-JSON requests cannot use a valid session on state-changing routes", async () => {
  await withEnv({}, async () => {
    const c = await cookie();
    for (const [name, method, load, body] of mutating) {
      const handler = (await load())[method];
      for (const h of <Record<string, string>[]>[{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: "https://evil.example", host: "localhost" }]) {
        const res: Response = await handler(call(method, { cookie: c, ...h }, body), ctx("t1"));
        assert.equal(res.status, 403, `${name} with ${JSON.stringify(h)} answered ${res.status}`);
        assert.equal((await res.json()).error.code, "forbidden_origin");
      }
      const form = new Request("http://localhost/api/x", { method, headers: { cookie: c, "content-type": "text/plain" }, body: "action=approve" });
      const r2: Response = await handler(form, ctx("t1"));
      assert.ok([415, 503].includes(r2.status), `${name} text/plain answered ${r2.status}`); // send tolerates an empty body only
    }
    const out = await (await import("@/app/api/auth/logout/route")).POST(call("POST", { "sec-fetch-site": "cross-site" }));
    assert.equal(out.status, 403);
  });
});

// ---- cross-ticket access and unsafe ids -------------------------------------------------------------------------

test("document ids that could address another path or collection are refused before Firestore is touched", async () => {
  await withEnv({ N8N_SEND_RESPONSE_WEBHOOK_URL: "https://n8n.example.com/webhook/x" }, async () => {
    const c = await cookie();
    const unsafe = ["a/b", "x/messages/y", "..", ".", "__name__", "t".repeat(1501), "support_tickets/other"];
    for (const id of unsafe) {
      for (const [name, method, load, body] of idRoutes) {
        const res: Response = await (await load())[method](call(method, { cookie: c }, body), ctx(id));
        assert.equal(res.status, 400, `${method} ${name} with id "${id.slice(0, 20)}" answered ${res.status}`);
        assert.match((await res.json()).error.code, /^invalid_(ticket|article)_id$/);
      }
    }
  });
});

test("follow-up message ids must be UUIDs (no path or collection injection through the second id)", async () => {
  await withEnv({ N8N_SEND_RESPONSE_WEBHOOK_URL: "https://n8n.example.com/webhook/x" }, async () => {
    const c = await cookie();
    const mod = await import("@/app/api/tickets/[id]/followups/[messageId]/reconcile/route");
    for (const mid of ["../x", "a/b", "not-a-uuid", ""]) {
      const res: Response = await mod.POST(call("POST", { cookie: c }, { outcome: "delivered" }), ctx("t1", mid));
      assert.equal(res.status, 400, mid);
    }
    const fu = await import("@/app/api/tickets/[id]/followups/route");
    const res: Response = await fu.POST(call("POST", { cookie: c }, { messageId: "../../x", content: "hi" }), ctx("t1"));
    assert.equal(res.status, 400);
  });
});

// ---- user-controlled fields / unauthorised state changes -----------------------------------------------------

test("review requests carry only an action and the reply text: extra fields (status, recipient, responseStatus) are dropped", () => {
  const parsed = parseReviewRequest({ action: "approve", finalResponse: "Hello", customerEmail: "evil@example.com", responseStatus: "sent", reviewStatus: "approved", status: "Resolved", id: "other" });
  assert.deepEqual(Object.keys(parsed).sort(), ["action", "finalResponse"]);
  for (const action of ["delete", "send", "", 5, null, undefined]) assert.throws(() => parseReviewRequest({ action }), /action/i);
});

test("knowledge-base input is limited to the article schema: no extra fields reach Firestore, bad types are refused", () => {
  const ok = parseArticleCreate({ title: "T", category: "C", content: "Body", keywords: ["a"], active: true, createdAt: "1999", role: "admin", __proto__: { x: 1 }, id: "evil" });
  assert.equal(ok.ok, true);
  assert.deepEqual(Object.keys((ok as any).value).sort(), ["active", "category", "content", "keywords", "title"]);
  for (const bad of [null, [], "x", { title: 1, category: "C", content: "b" }, { title: "T", category: "C", content: "b", keywords: "a" }, { title: "T", category: "C", content: "x".repeat(200_000) }]) {
    assert.equal(parseArticleCreate(bad).ok, false);
  }
  assert.equal(parseArticleCreate({ title: "T", category: "C", content: "b", requestId: "../../x" }).ok, false, "requestId becomes a document id, so it must be a UUID");
});

test("the send route ignores anything in the body except retryUnknown: recipient and text come from the stored ticket", () => {
  const src = read("src/app/api/tickets/[id]/send/route.ts");
  const bodyUses = [...src.matchAll(/body\?\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(bodyUses)], ["retryUnknown"]);
});

// ---- errors and headers ----------------------------------------------------------------------------------------

test("error bodies never contain stack traces, credentials or file paths", async () => {
  await withEnv({ FIREBASE_PROJECT_ID: "p", FIREBASE_CLIENT_EMAIL: "x@p.iam.gserviceaccount.com", FIREBASE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nSECRETKEYBODY\n-----END PRIVATE KEY-----\n" }, async () => {
    const c = await cookie();
    const res: Response = await (await import("@/app/api/tickets/route")).GET(call("GET", { cookie: c }));
    const text = await res.text();
    assert.ok(res.status >= 500);
    assert.doesNotMatch(text, /SECRETKEYBODY|PRIVATE KEY|\bat .*\(|node_modules|\/home\//);
  });
});

test("security headers are configured for all routes, and the framework banner is off", async () => {
  const mod = await import("../next.config" as string);
  const cfg: any = mod.default;
  assert.equal(cfg.poweredByHeader, false);
  const rules = await cfg.headers();
  const h = Object.fromEntries(rules.find((r: any) => r.source === "/:path*").headers.map((x: any) => [x.key, x.value]));
  assert.equal(h["X-Frame-Options"], "DENY");
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.match(h["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.ok(h["Strict-Transport-Security"] && h["Referrer-Policy"]);
});

// ---- Firestore rules (STATIC checks only) -------------------------------------------------------------------------

test("firestore.rules denies all client access, with no allow other than `if false` (static check, not an emulator run)", () => {
  const rules = read("firestore.rules").replace(/\/\/.*$/gm, "");
  assert.match(rules, /rules_version\s*=\s*'2'/);
  const allows = rules.match(/allow[^;]*;/g) ?? [];
  assert.ok(allows.length >= 1);
  for (const a of allows) assert.match(a, /if\s+false\s*;$/, a);
  assert.doesNotMatch(rules, /if\s+true|request\.auth|get\(|exists\(/);
  assert.match(rules, /match\s+\/\{document=\*\*\}/, "a catch-all covers support_tickets, knowledge_base, rate_limits, n8n_send_log and every subcollection");
  assert.equal((rules.match(/match\s+\//g) ?? []).length, 2, "only the database root and the catch-all");
  assert.equal(JSON.parse(read("firebase.json")).firestore.rules, "firestore.rules");
  assert.ok(existsSync(join(root, "firestore.rules")));
});

test("the deny-all rules are only correct while nothing in the app uses Firestore from a browser; this fails if that changes", () => {
  const pkg = JSON.parse(read("package.json"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.equal("firebase" in deps, false, "the Firebase client SDK is not a dependency");
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { const f = join(d, n); if (statSync(f).isDirectory()) walk(f); else if (/\.(ts|tsx|js|mjs)$/.test(n)) files.push(f); } };
  walk(join(root, "src"));
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /from\s+["']firebase\/|from\s+["']firebase["']|NEXT_PUBLIC_FIREBASE/, f);
    if (/["']use client["']/.test(src)) assert.doesNotMatch(src, /firebase-admin|firestore-|getAdminDb/, `client component ${f} must not import server data code`);
  }
  assert.match(read("src/lib/firebase-admin.ts"), /import "server-only"/);
});

test("every Firestore access from n8n uses the service-account credential, so the public form keeps working under deny-all rules", () => {
  const wf = JSON.parse(read("n8n/ai-support-desk-automation.json"));
  const fs = wf.nodes.filter((n: any) => n.type.toLowerCase().includes("firestore"));
  assert.ok(fs.length >= 4);
  for (const n of fs) assert.equal(n.credentials?.googleApi?.name, "Google Service Account account", n.name);
  assert.deepEqual(new Set(fs.map((n: any) => n.parameters.collection)), new Set(["knowledge_base", "support_tickets", "rate_limits"]));
  assert.equal(wf.nodes.filter((n: any) => /trigger|webhook/i.test(n.type) && !/respond/i.test(n.type)).length, 1, "the form is the only public entry point");
});
