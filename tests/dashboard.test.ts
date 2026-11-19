/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic route modules and stubs */
// Phase 3 tests: time-aware greeting, ticket search + filters, saved preferences (persistence, validation, failures).
// Logic is tested directly; React components are NOT rendered here (no browser/DOM test setup in this project).
import test from "node:test";
import assert from "node:assert/strict";
import type { Firestore } from "firebase-admin/firestore";
import { hashPassword } from "@/lib/auth/password";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth/session";
import {
  dayPartFor, DEFAULT_SETTINGS, formatClock, formatDateShort, greetingFor, hourIn, isValidTimeZone,
  parseSettingsUpdate, settingsFromStored,
} from "@/lib/dashboard-settings";
import { readDashboardSettings, writeDashboardSettings } from "@/lib/firestore-settings";
import { saveDashboardSettings } from "@/lib/api/dashboard-settings";
import { canSave, initialFormState, isDirty, settingsFormReducer } from "@/lib/settings-form";
import { applyFilters, DEFAULT_FILTERS, indexTickets, hasActiveFilters, categoryOptions } from "@/lib/tickets-list";
import type { SupportTicketRecord } from "@/lib/types";
import { FakeFirestore } from "./fake-firestore";

const utc = (iso: string) => new Date(iso);

// ---- greeting ---------------------------------------------------------------------------------------------------

test("greeting boundaries: morning 05:00-11:59, afternoon 12:00-16:59, evening 17:00-04:59", () => {
  const at = (h: number, m = 0) => greetingFor(utc(`2026-11-18T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`), "UTC");
  assert.equal(at(4, 59), "Good evening");
  assert.equal(at(5), "Good morning");
  assert.equal(at(11, 59), "Good morning");
  assert.equal(at(12), "Good afternoon");
  assert.equal(at(16, 59), "Good afternoon");
  assert.equal(at(17), "Good evening");
  assert.equal(at(0), "Good evening");
  assert.equal(at(23, 59), "Good evening");
});

test("the greeting follows the chosen time zone, not the server's", () => {
  const instant = utc("2026-11-18T10:30:00Z");
  assert.equal(greetingFor(instant, "UTC"), "Good morning");
  assert.equal(greetingFor(instant, "Africa/Harare"), "Good afternoon"); // 12:30 UTC+2
  assert.equal(greetingFor(instant, "Asia/Tokyo"), "Good evening"); // 19:30
  assert.equal(greetingFor(instant, "America/Los_Angeles"), "Good evening"); // 02:30
  assert.equal(hourIn(instant, "Africa/Harare"), 12);
  assert.equal(dayPartFor(instant, "auto"), dayPartFor(instant, undefined), "auto means the device zone");
  assert.equal(greetingFor(instant, "Not/AZone"), greetingFor(instant, undefined), "an invalid zone falls back rather than throwing");
});

test("the greeting changes as time passes (it is computed, not fixed)", () => {
  const seen = new Set([6, 13, 20].map((h) => greetingFor(utc(`2026-11-18T${String(h).padStart(2, "0")}:00:00Z`), "UTC")));
  assert.equal(seen.size, 3);
});

test("clock and date formatting honour the zone and tolerate bad input", () => {
  const instant = utc("2026-11-18T22:30:00Z");
  assert.equal(formatClock(instant, "UTC"), "22:30");
  assert.equal(formatClock(instant, "Africa/Harare"), "00:30");
  assert.match(formatDateShort("2026-11-18T22:30:00Z", "Africa/Harare")!, /19 Nov 2026/);
  assert.match(formatDateShort("2026-11-18T22:30:00Z", "UTC")!, /18 Nov 2026/);
  assert.equal(formatDateShort("garbage", "UTC"), null);
  assert.equal(formatDateShort(null, "UTC"), null);
});

// ---- ticket search + filters --------------------------------------------------------------------------------------

const NOW = utc("2026-11-18T12:00:00Z");
const rec = (o: Partial<SupportTicketRecord> & { id: string }): SupportTicketRecord => ({ status: "open", priority: "low", category: "billing_issue", createdAt: "2026-11-10T09:00:00Z", ...o });
const tickets: SupportTicketRecord[] = [
  rec({ id: "tk_a1", customerName: "Priya Nair", customerEmail: "priya@northwind.com", message: "I was charged twice for my invoice", summary: "Duplicate charge", priority: "high", createdAt: "2026-11-12T09:00:00Z" }),
  rec({ id: "tk_b2", customerName: "Tendai Moyo", customerEmail: "tendai@example.org", message: "App crashes on login", summary: "Login crash", category: "bug", priority: "urgent", escalationRequired: true, escalationStatus: "required", createdAt: "2026-11-15T09:00:00Z" }),
  rec({ id: "tk_c3", customerName: "Ada Lovelace", customerEmail: "ada@example.com", message: "How do I reset my password?", summary: "Password reset", category: "account_access", priority: "low", createdAt: "2026-11-01T09:00:00Z" }),
  rec({ id: "tk_d4", customerName: null, customerEmail: null, message: null, summary: null, category: null, createdAt: null }),
];
const index = indexTickets(tickets, NOW);
const find = (o: Partial<typeof DEFAULT_FILTERS>) => applyFilters(index, { ...DEFAULT_FILTERS, ...o }).map((t) => t.id);

test("search covers name, email, ticket id, category (raw and displayed) and message/summary text", () => {
  assert.deepEqual(find({ search: "priya" }), ["tk_a1"]);
  assert.deepEqual(find({ search: "TENDAI@EXAMPLE.ORG" }), ["tk_b2"]);
  assert.deepEqual(find({ search: "tk_c3" }), ["tk_c3"]);
  assert.deepEqual(find({ search: "billing issue" }), ["tk_a1", "tk_c3"].filter((id) => id === "tk_a1"), "displayed label");
  assert.deepEqual(find({ search: "account_access" }), ["tk_c3"], "raw category value");
  assert.deepEqual(find({ search: "charged twice" }), ["tk_a1"], "message");
  assert.deepEqual(find({ search: "login crash" }), ["tk_b2"], "summary");
});

test("search: empty or whitespace query shows everything; every word must match; no results is an empty list", () => {
  assert.equal(find({ search: "" }).length, 4);
  assert.equal(find({ search: "   " }).length, 4);
  assert.equal(hasActiveFilters({ ...DEFAULT_FILTERS, search: "  " }), false);
  assert.deepEqual(find({ search: "priya northwind" }), ["tk_a1"]);
  assert.deepEqual(find({ search: "priya tendai" }), []);
  assert.deepEqual(find({ search: "zzz-nothing" }), []);
});

test("search treats regex characters and odd input as plain text and never throws", () => {
  for (const q of [".*", "(", "[a-", "\\", "%", "<script>", "a".repeat(5000)]) assert.doesNotThrow(() => find({ search: q }));
  assert.deepEqual(find({ search: ".*" }), []);
});

test("search combines with priority, status and category filters (all must match)", () => {
  assert.deepEqual(find({ search: "example", priority: "urgent" }), ["tk_b2"]);
  assert.deepEqual(find({ search: "example", priority: "high" }), []);
  assert.deepEqual(find({ search: "example", status: "escalated" }), ["tk_b2"]);
  assert.deepEqual(find({ search: "example", category: categoryOptions(index).find((c) => /account/i.test(c))! }), ["tk_c3"]);
  assert.deepEqual(find({ priority: "urgent", category: categoryOptions(index).find((c) => /billing/i.test(c))! }), []);
  assert.ok(categoryOptions(index).some((c) => /account/i.test(c)));
});

test("sorting works with search; undated tickets always sort last", () => {
  assert.deepEqual(find({ search: "example", sort: "newest" }), ["tk_b2", "tk_c3"]);
  assert.deepEqual(find({ search: "example", sort: "oldest" }), ["tk_c3", "tk_b2"]);
  assert.equal(find({ sort: "oldest" }).at(-1), "tk_d4");
  assert.equal(find({ sort: "newest" }).at(-1), "tk_d4");
});

test("search is purely client-side over the already-fetched list: no request per keystroke", async () => {
  const { readFileSync } = await import("node:fs");
  const explorer = readFileSync("src/components/tickets/tickets-explorer.tsx", "utf8");
  const filters = readFileSync("src/components/tickets/ticket-filters.tsx", "utf8");
  assert.doesNotMatch(explorer + filters, /fetch\(|fetchTickets/, "filtering never fetches");
  assert.match(explorer, /history\.replaceState/, "the address bar is synced without a navigation");
  const header = readFileSync("src/components/layout/header.tsx", "utf8");
  assert.match(header, /router\.push\([^;]*\/tickets\?q=/, "the header search goes to the tickets page");
  assert.doesNotMatch(header, /fetch\(/);
});

// ---- settings: validation ---------------------------------------------------------------------------------------

test("defaults are sensible and valid", () => {
  assert.deepEqual(DEFAULT_SETTINGS, { timeZone: "auto", autoRefreshMinutes: 0, defaultSort: "newest" });
  assert.equal(parseSettingsUpdate(DEFAULT_SETTINGS).ok, true);
});

test("validation accepts valid values and rejects everything else with per-field messages", () => {
  assert.equal(parseSettingsUpdate({ timeZone: "Africa/Harare", autoRefreshMinutes: 5, defaultSort: "oldest" }).ok, true);
  const bad = parseSettingsUpdate({ timeZone: "Mars/Base", autoRefreshMinutes: 7, defaultSort: "random" });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.deepEqual(Object.keys(bad.errors).sort(), ["autoRefreshMinutes", "defaultSort", "timeZone"]);
  for (const raw of [null, [], "x", 5, {}, { timeZone: "UTC" }]) assert.equal(parseSettingsUpdate(raw).ok, false);
  assert.equal(parseSettingsUpdate({ ...DEFAULT_SETTINGS, autoRefreshMinutes: "5" }).ok, false, "no string numbers");
  assert.equal(parseSettingsUpdate({ ...DEFAULT_SETTINGS, timeZone: "x".repeat(100) }).ok, false);
  assert.equal(parseSettingsUpdate({ ...DEFAULT_SETTINGS, timeZone: "" }).ok, false);
  assert.equal(isValidTimeZone("auto"), true);
});

test("unknown fields are refused, so nothing but the three settings (and no secret) can be stored", () => {
  for (const extra of [{ role: "admin" }, { FIREBASE_PRIVATE_KEY: "x" }, { __proto__: { a: 1 }, webhookUrl: "https://x" }]) {
    const r = parseSettingsUpdate({ ...DEFAULT_SETTINGS, ...extra });
    assert.equal(r.ok, false);
  }
});

test("stored data that is missing or corrupt falls back to defaults field by field", () => {
  assert.deepEqual(settingsFromStored(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(settingsFromStored({ timeZone: 5, autoRefreshMinutes: 99, defaultSort: null }), DEFAULT_SETTINGS);
  assert.deepEqual(settingsFromStored({ timeZone: "UTC", autoRefreshMinutes: 15, defaultSort: "bogus", extra: 1 }), { timeZone: "UTC", autoRefreshMinutes: 15, defaultSort: "newest" });
});

// ---- settings: persistence ----------------------------------------------------------------------------------------

test("settings persist: defaults when nothing is stored, saved values come back on the next read (a refresh)", async () => {
  const fake = new FakeFirestore();
  const db = fake as unknown as Firestore;
  assert.deepEqual(await readDashboardSettings(db), DEFAULT_SETTINGS);
  const saved = await writeDashboardSettings({ timeZone: "Africa/Harare", autoRefreshMinutes: 5, defaultSort: "oldest" }, "admin", db);
  assert.deepEqual(saved, { timeZone: "Africa/Harare", autoRefreshMinutes: 5, defaultSort: "oldest" });
  assert.deepEqual(await readDashboardSettings(db), saved, "a later read (page refresh) sees them");
  const doc = fake.read("app_settings/dashboard")!;
  assert.deepEqual(Object.keys(doc).sort(), ["autoRefreshMinutes", "defaultSort", "timeZone", "updatedAt", "updatedBy"]);
  assert.equal(doc.updatedBy, "admin");
});

test("a failed write throws and leaves the stored settings unchanged", async () => {
  const fake = new FakeFirestore();
  const db = fake as unknown as Firestore;
  await writeDashboardSettings({ timeZone: "UTC", autoRefreshMinutes: 1, defaultSort: "newest" }, "admin", db);
  const broken = { collection: () => ({ doc: () => ({ get: async () => ({ exists: false, data: () => undefined }), set: async () => { throw Object.assign(new Error("down"), { code: 14 }); } }) }) } as unknown as Firestore;
  await assert.rejects(writeDashboardSettings({ timeZone: "Asia/Tokyo", autoRefreshMinutes: 15, defaultSort: "oldest" }, "admin", broken));
  assert.equal((await readDashboardSettings(db)).timeZone, "UTC");
});

// ---- settings: the API route ---------------------------------------------------------------------------------------

const SECRET = "k".repeat(48);
async function withAuth<T>(fn: (cookie: string) => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  const hash = await hashPassword("correct horse battery");
  Object.assign(process.env, { AUTH_USERNAME: "admin", AUTH_PASSWORD_HASH: hash, AUTH_SESSION_SECRET: SECRET });
  for (const k of ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"]) delete process.env[k];
  try { return await fn(`${SESSION_COOKIE}=${await createSessionToken("admin", `${SECRET}\n${hash}`)}`); } finally { process.env = saved; }
}
const put = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/settings", { method: "PUT", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("PUT/GET /api/settings: signed-out is 401, cross-site is 403, invalid is 422 and saves nothing, valid reaches storage", async () => {
  const { GET, PUT } = await import("@/app/api/settings/route");
  await withAuth(async (cookie) => {
    assert.equal((await GET(new Request("http://localhost/api/settings"))).status, 401, "no cookie");
    assert.equal((await PUT(put(DEFAULT_SETTINGS))).status, 401, "no cookie");
    assert.equal((await PUT(put(DEFAULT_SETTINGS, { cookie: `${SESSION_COOKIE}=forged.value` }))).status, 401, "forged cookie");
    assert.equal((await PUT(put(DEFAULT_SETTINGS, { cookie, "sec-fetch-site": "cross-site" }))).status, 403);
    const text = await PUT(new Request("http://localhost/api/settings", { method: "PUT", headers: { cookie, "content-type": "text/plain" }, body: "x" }));
    assert.equal(text.status, 415);
    const invalid = await PUT(put({ timeZone: "Mars/Base", autoRefreshMinutes: 7, defaultSort: "x" }, { cookie }));
    assert.equal(invalid.status, 422);
    const body = await invalid.json();
    assert.equal(body.error.code, "validation_failed");
    assert.deepEqual(Object.keys(body.error.fields).sort(), ["autoRefreshMinutes", "defaultSort", "timeZone"]);
    // Valid input passes every check and reaches Firestore (not configured in tests, so 503, nothing leaked).
    const ok = await PUT(put({ timeZone: "UTC", autoRefreshMinutes: 5, defaultSort: "oldest" }, { cookie }));
    assert.equal(ok.status, 503);
    assert.equal((await ok.json()).error.code, "firebase_not_configured");
    assert.equal((await GET(new Request("http://localhost/api/settings", { headers: { cookie } }))).status, 503);
  });
});

// ---- settings: browser client and form behaviour on failure ---------------------------------------------------------

test("the browser client reports a failed save with the server's message and field errors", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: "validation_failed", message: "Some settings need attention. Nothing was saved.", fields: { timeZone: "Choose a valid time zone." } } }), { status: 422 })) as typeof fetch;
    await assert.rejects(saveDashboardSettings(DEFAULT_SETTINGS), (e: any) => e.code === "validation_failed" && e.fields.timeZone === "Choose a valid time zone." && e.status === 422);
    globalThis.fetch = (async () => { throw new TypeError("offline"); }) as typeof fetch;
    await assert.rejects(saveDashboardSettings(DEFAULT_SETTINGS), (e: any) => e.code === "network_error" && /still here/.test(e.message));
    globalThis.fetch = (async () => new Response("<html>oops</html>", { status: 500 })) as typeof fetch;
    await assert.rejects(saveDashboardSettings(DEFAULT_SETTINGS), (e: any) => e.status === 500 && e.code === "unknown_error");
    globalThis.fetch = (async () => new Response(JSON.stringify({ settings: { timeZone: "UTC", autoRefreshMinutes: 5, defaultSort: "oldest", junk: 1 } }), { status: 200 })) as typeof fetch;
    assert.deepEqual(await saveDashboardSettings(DEFAULT_SETTINGS), { timeZone: "UTC", autoRefreshMinutes: 5, defaultSort: "oldest" });
  } finally { globalThis.fetch = realFetch; }
});

test("form state: edits are tracked, Save needs a valid changed draft, success clears dirty, failure KEEPS the draft", () => {
  let s = initialFormState();
  assert.equal(canSave(s), false, "nothing changed yet");
  s = settingsFormReducer(s, { type: "edit", patch: { autoRefreshMinutes: 5, timeZone: "Africa/Harare" } });
  assert.equal(isDirty(s), true);
  assert.equal(canSave(s), true);
  s = settingsFormReducer(s, { type: "save-started" });
  assert.equal(s.status, "saving");
  assert.equal(canSave(s), false, "no double submit while saving");
  const draft = s.draft;
  s = settingsFormReducer(s, { type: "save-failed", message: "Firestore is down.", fields: {} });
  assert.equal(s.status, "error");
  assert.deepEqual(s.draft, draft, "the user's changes are not discarded");
  assert.equal(isDirty(s), true);
  assert.equal(canSave(s), true, "and they can retry");
  assert.deepEqual(s.saved, DEFAULT_SETTINGS, "saved values are only updated by a real success");
  s = settingsFormReducer(s, { type: "save-succeeded", value: draft });
  assert.equal(s.status, "saved");
  assert.equal(isDirty(s), false);
  assert.match(s.message!, /saved/i);
});

test("form state: invalid drafts cannot be saved and show field errors; server field errors are shown and kept", () => {
  let s = initialFormState();
  s = settingsFormReducer(s, { type: "edit", patch: { timeZone: "Mars/Base" } });
  assert.equal(canSave(s), false);
  assert.ok(s.fields.timeZone);
  s = settingsFormReducer(s, { type: "edit", patch: { timeZone: "UTC" } });
  assert.deepEqual(s.fields, {});
  s = settingsFormReducer(settingsFormReducer(s, { type: "save-started" }), { type: "save-failed", message: "Nothing was saved.", fields: { timeZone: "Choose a valid time zone." } });
  assert.equal(s.fields.timeZone, "Choose a valid time zone.");
  assert.equal(s.draft.timeZone, "UTC");
});

test("form state: values loaded from the server never overwrite unsaved edits; discard and reset behave", () => {
  const server = { timeZone: "UTC", autoRefreshMinutes: 15, defaultSort: "oldest" } as const;
  let s = initialFormState();
  s = settingsFormReducer(s, { type: "loaded", value: server });
  assert.deepEqual(s.draft, server, "a clean form takes the loaded values");
  s = settingsFormReducer(s, { type: "edit", patch: { autoRefreshMinutes: 1 } });
  s = settingsFormReducer(s, { type: "loaded", value: { ...server, timeZone: "Asia/Tokyo" } });
  assert.equal(s.draft.autoRefreshMinutes, 1, "unsaved edit kept");
  assert.equal(s.saved.timeZone, "Asia/Tokyo");
  s = settingsFormReducer(s, { type: "discard" });
  assert.deepEqual(s.draft, s.saved);
  s = settingsFormReducer(s, { type: "reset-defaults" });
  assert.deepEqual(s.draft, DEFAULT_SETTINGS);
  assert.equal(isDirty(s), true, "resetting is a change until it is saved");
});

test("the settings route and client carry no secrets or server configuration", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["src/app/api/settings/route.ts", "src/lib/dashboard-settings.ts", "src/lib/firestore-settings.ts", "src/lib/api/dashboard-settings.ts"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /process\.env|PRIVATE_KEY|WEBHOOK|AUTH_SESSION/, f);
  }
});
