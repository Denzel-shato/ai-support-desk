# Changelog

## Operational readiness (audit findings B6, B8, B9, B10)

Reconciled with B1-B5 on `main` (`acf95bb`); no logic of those was reimplemented. Nothing here was run on a real n8n, Firebase or Gemini; see the docs for what stays manual.

- **B6 (TTL): disproven at code level, not verified live.** n8n 2.47.7's Firestore node turns strict ISO-8601 strings into Timestamps, and all four `rate_limits` writers (`Claim slot`, `Claim rescue slot`, `Record held submission`, `Record failed notification`) emit canonical UTC strings. Tests cover every writer's columns, format and lifetimes through a port of the node's serialiser. New read-only operator check `npm run ttl:check` reports the real stored type. The exact policy (`rate_limits` / `expireAt`) is documented.
- **B8 (failure handling): confirmed, fixed.** Five Code nodes after "submitted" now have error outputs into the rescue email (new kind `notification_failed`); new `ai-support-desk-failure-alert.json` (Error Trigger, `Alert config` with B2's validator and placeholder, sanitised alert with no customer data). Execution-data settings are explicit. **Finding:** B5's suppressed rescue submissions live only in a "successful" execution, so successful executions must **not** be disabled; B2's doc advice to consider that was corrected. Manual setup, retention, backup and recovery: `docs/n8n-failure-alerts.md`.
- **B9 (proxy IP): confirmed limitation, defensive parsing added.** Direct access to n8n lets a client choose its IP (infrastructure fix only; documented with a verification procedure). `Prepare rate limit` now handles ports, brackets, IPv4-mapped IPv6 and rejects private/reserved/multicast/IPv4-compatible/oversized/stuffed values. The hop count default (1) is unchanged because it depends on your topology. Limits and B4 slot ownership untouched.
- **B10 (Gemini): confirmed.** `gemini-3-flash-preview` (preview, deprecated with a named replacement) became `gemini-3.6-flash` (stable) in the evaluation node. `gemini-3.1-flash-lite` (stable, earliest shutdown 2027-05-07) is unchanged on purpose; a deadline tripwire test and a smoke-test procedure are documented. `Build ticket` now joins all text parts of a response and ignores thought parts.
- Tests: `tests/operational-readiness.test.ts`; graph assertions in older tests updated for the new error outputs and B5's nodes; B2's placeholder inventory now allows the alert workflow's own inbox placeholder.

## Rate limiter starvation and rescue-email flooding (audit findings B4 + B5)

- **B4:** claims are now IP/unknown, email, then global **last**; every slot carries a per-submission `claimId`; on refusal the held slots are released only after reading them and confirming the `claimId` (Firestore delete has no precondition). Refused submissions no longer consume global capacity, other requests' slots can never be released, atomic `create` is unchanged, a failed release only makes the limiter stricter. Limits, windows, messages and fail-closed behaviour are unchanged.
- **B5:** refused-submission rescue emails (`rate_limit_unavailable`) are capped per window (3 detailed, 1 notice without customer data, then none) using atomic slot documents, with identifier-only `held_*` records for suppressed ones, a static-data fallback and a send-anyway degrade when both stores fail. Failed rescue emails are handled explicitly (held record, execution marked failed). Rescue emails for accepted tickets are not throttled.
- Merged on top of B1, B2 (salt from `Deployment config`) and B3; the Send Response workflow, auth, Firestore rules and `src/` are untouched. New nodes got unique ids (a merge collision was found by importing into n8n and is now tested).
- Tests: `tests/rate-limit-reliability.test.ts`; older graph assertions updated for the new topology. Docs: `docs/n8n-intake-workflow.md`.

## Explicit ticket resolution and reopening (audit finding B3)

- **Audit result:** there was no way to resolve a ticket. "Resolved" existed only as a *display* value read from a stored `status` that nothing in the dashboard or the n8n workflows ever wrote (n8n writes `pending_review`). The only existing "reopen" is the unrelated review action ("Submit for review again"). This is new work, not a duplicate.
- **API:** `POST /api/tickets/[id]/resolution` with `{ "action": "resolve" | "reopen" }`. Same protections as the other mutating routes: sign-in (401/503), same-origin and JSON only (403/415), size cap, ID validated (400), then one Firestore transaction (404 missing ticket, 409 invalid transition). Only `action` is read from the body.
- **Writes (and only these):** resolve sets `status: "resolved"`, `resolvedAt`, `resolvedBy` (the signed-in user) and an internal `statusBeforeResolution`. Reopen restores that status (`open` if unknown, never a finished status), clears `resolvedAt`/`resolvedBy`, and sets `reopenedAt`/`reopenedBy`. Escalation, review, response and `aiResponse`/`customerResponse` fields are never touched.
- **History:** each change appends an immutable `ticket_resolved` / `ticket_reopened` event to `support_tickets/{id}/response_events` in the same transaction. Reopening never edits or deletes the resolve event; the reopen event records the resolution it reversed.
- **Invalid transitions (409):** `already_resolved` (the original `resolvedAt`/`resolvedBy` are never overwritten, including for tickets closed outside the dashboard), `not_resolved` (reopen), and `send_in_progress` / `delivery_unconfirmed` (resolve is refused while an email is mid-send or its delivery is unconfirmed, the same rule the review actions use).
- **No email, no n8n:** resolving never sends anything, never calls n8n and does not use the approval or Send Response code. Neither workflow JSON is modified.
- **Dashboard:** "Mark as resolved" / "Reopen ticket" on the ticket page, with an inline confirmation, loading, success and error states. **Resolved now takes precedence in the single displayed status** (previously escalated and awaiting-review outranked it, so a resolved escalation would still read "Escalated"). Overview "Escalated tickets" became **"Active escalations"** (escalated and not resolved, with "N resolved of M escalated" beneath); "Awaiting review" no longer counts resolved tickets; on the Escalations page the total stays historical while Urgent / High / Awaiting attention count active escalations only, and a new Active / Resolved filter was added (default: all, so history stays visible). Whether a ticket *was* escalated (`escalationStatus`) and whether it is resolved now are separate facts and both are shown on the ticket page.
- Tests: `tests/resolution.test.ts` (runs the real handler against the in-memory Firestore, plus dashboard consistency); the two route-protection tables now include the new route.
- Not changed on purpose: approval, Send Response and follow-ups still work on a resolved ticket.

## Secure deployment configuration and placeholder protection (audit finding B2)

- **Placeholders can no longer pass as configuration.** The escalation inbox (`REPLACE_WITH_ESCALATION_INBOX@example.com`, previously in two Gmail nodes) and the rate-limit salt (`CHANGE-ME-TO-A-LONG-RANDOM-STRING`, previously in `Rate limit settings`) now live in one new `Deployment config` Code node. It validates both (inbox: one plain mailbox, not a placeholder or reserved example/test domain; salt: 32-256 printable characters, enough variety, not a placeholder) and reports problem codes only.
- **Fail closed.** New first steps `Deployment config` -> `Deployment config valid?`: an invalid configuration answers the visitor with the existing "try again later" text and then fails the execution (`Stop and Error`). No rate-limit claim, Gemini call, ticket or email happens. `Prepare rate limit` independently re-validates the salt and throws.
- **One inbox for both staff emails.** `Send a message` (escalation) and `Send rescue email` read the validated inbox from `Deployment config`; no address is stored in either node.
- Rate-limiting algorithm, limits, hashing and the Send Response workflow are unchanged. Hashes only change if you choose a different salt than the one you had.
- Tests: `tests/deployment-config.test.ts` (placeholder, missing and malformed values, gate wiring, forged flags, placeholder inventory, secret hygiene); `tests/rate-limit.test.ts` harness now supplies a valid test configuration.
- Docs: new `docs/n8n-deployment-config.md` (exact manual setup, how to generate a random salt, caveats). **Manual setup is required before the workflow will process submissions.** Not run in a real n8n 2.47.7.

## Secure automatic customer replies (audit finding B1)

- **The model no longer writes anything that is emailed automatically.** A Low/Medium ticket is answered automatically only when the evaluation is complete, `kbStatus` is `covered`, `escalationRequired` is false, no unsupported parts remain, and every proposed step is found inside the article the model cites (by exact article ID, and title when given). The email text is a fixed template filled with the **article's own sentences**; the model's prose is stored only as a draft for agents.
- Any step, article reference or output that cannot be verified, is ambiguous (duplicate titles), or whose sentence contains a link, e-mail address, markup or hidden/bidirectional characters sends the ticket to human review (`escalationRequired: true`, reason `Automatic reply blocked (<code>)`, new fields `groundingIssue`, `autoReplyArticleId`). `partially_covered` now always needs a human. The original submission is stored in every case.
- `Select active articles` now also outputs `articles` (id, title, content). `Build ticket` verifies; `Prepare email fields` **re-verifies independently** against the article text and routes to staff if anything does not hold. The customer email node prints only `safe.greeting` (a plain Name-Case first name, otherwise "Hello,") and `safe.autoReplyText`.
- Both Gemini prompts now delimit the customer text as untrusted data and the evaluation must return `relevantArticleId` and verbatim steps. **This is defence in depth only; nothing relies on the model obeying it.**
- High/Urgent behaviour, the approval and Send Response workflow, rate limiting and authentication are unchanged. The Send Response workflow JSON is not modified.
- Tests: `tests/auto-reply-grounding.test.ts` (adversarial and randomised). Existing fixtures that expected an ungrounded automatic reply were updated to cite a real article. Not run against a real n8n, Gemini, Firestore or Gmail.

## Dashboard: greeting, search, settings, polish

- The overview greeting is now time-aware (morning 05:00-11:59, afternoon 12:00-16:59, evening 17:00-04:59) in the chosen time zone and updates without a reload.
- Header search was decorative; it now opens All tickets with the query (`/tickets?q=`). Ticket search also matches the category. Filtering stays client-side over the already-loaded list (no request per keystroke).
- Settings gained saved **Preferences** (`/api/settings`, Firestore `app_settings/dashboard`): time zone, background refresh interval, default ticket order. Validated server-side, persisted, applied across the dashboard; failed saves keep the draft.
- Tests: `tests/dashboard.test.ts` (+ new route in the auth tests). Components are not rendered in tests; see `docs/dashboard.md` for what was checked in a real browser.

## Security audit (Firestore rules and API)

- Added `firestore.rules` (deny all client/REST access; the app and n8n use service accounts) and `firebase.json`. **Must be deployed manually.** Previously the repo had no rules.
- Added security response headers and disabled `X-Powered-By` in `next.config.ts`.
- `GET /api/tickets/[id]/messages` now validates the id itself.
- Tests: `tests/security.test.ts`. Rules were checked statically only, not in the emulator or a real project. Details in `docs/security.md`.

## Rate limiting for the public form

- Firestore slot-claim limiter (atomic `create`, hashed keys, TTL field): global 20/min, IP 10/h, unknown-source 20/h, normalised email 3/h, all in `Rate limit settings`.
- Form Trigger moved to v2.1 with Respond to Webhook: accepted visitors see the unchanged text; invalid, limited or limiter-unavailable visitors get a polite specific message. Rejected requests never reach Gemini, KB, tickets or customer/escalation emails.
- Fail closed on limiter outage with a staff rescue email (own kind); `failMode: 'open'` available.
- Tests: `tests/rate-limit.test.ts` (Node, fake atomic store); also run in a stubbed local n8n. Not tested on your n8n, real Firestore, proxy or browser. Setup steps in `docs/n8n-intake-workflow.md`.

## Intake reliability (phases A-E)

- **Gemini retries** (3 tries) on both nodes; the manual-handling fallback is unchanged.
- **Deterministic ticket ID** (`tk_` + SHA-256 of email + message + clock hour) as the Firestore document ID, plus new additive ticket field `intakeExecutionId`. A double submit or retried write can no longer create two tickets; duplicates stop quietly.
- **Create failure handling:** retry, then conflict recovery (own earlier write continues to the emails; someone else's write is a duplicate; unreadable is reported) or a staff **rescue email** with the escaped submission. A Firestore outage no longer loses the customer's text.
- **Notification emails** retry and fall back to the rescue email; n8n attribution removed from emails; escalation subject no longer blank when priority is missing.
- Form confirmation text no longer claims the request was "recorded". **The early-confirmation problem is NOT solved**: n8n can't respond truthfully early with Form Trigger v2.6 without browser-dependent processing. Alternatives are documented in `docs/n8n-intake-workflow.md`.
- Tests: `tests/intake-reliability.test.ts`; the graph assertion in `tests/workflow.test.ts` now lists the new branch points.
- Proposed workflow only. Verified in Node and in a stubbed local n8n, **not** against live Gemini, Firestore, Gmail or your n8n.

## Send-response workflow audit fixes

- Only an empty Firestore item counts as a missing document; any error item (even one saying "not found") is now a read failure (`502` for the ticket, `unknown` for the send log), so a genuine error can no longer be mistaken for "not sent yet".
- Send claims are scoped per attempt (`n8n_send_log/<key>__a<attempt>`); the `__sent` record stays per key. An agent-resolved retry is no longer permanently blocked by an old unresolved claim. Tests added for simultaneous claims, retries, and Gmail success followed by a logging failure.
- Still not tested against a real n8n activation, Gmail or Firestore.

## Agent-initiated email delivery: n8n receiver workflow

- New proposed workflow `n8n/ai-support-desk-send-response.json` (inactive, 21 nodes) for the existing dashboard send webhook: header auth, payload and ticket validation, duplicate protection through `n8n_send_log`, one Gmail send, honest `sent` / `failed` / `unknown` answers. Separate from intake: acknowledgements, escalation emails, Gemini and routing are unchanged. n8n never writes tickets; the dashboard records the outcome.
- New tests `tests/send-workflow.test.ts` (graph, validation, duplicate protection, Gmail error classification, dashboard contract). `docs/n8n-send-response-workflow.md` rewritten to match; intake doc note on omitted fields corrected.
- **Not tested against real n8n activation, Gmail or Firestore.** Manual configuration steps are in the doc.

## Audit remediation, phase 4B (public intake validation)

- New first step in the proposed intake workflow, `Validate submission` + `Is submission valid`: name, a well-formed email and a non-empty message (max 5,000 characters) are required; invalid submissions stop before Gemini, Firestore and Gmail. Later nodes read the cleaned values from this node.
- **Not implemented, and documented as such:** rate limiting and bot protection. The Form Trigger can't enforce them; see `docs/n8n-intake-workflow.md` for the options. Proposed workflow only; not imported or run.

## Audit remediation, phase 4A (intake reliability and routing)

- **No more lost submissions.** Gemini and knowledge-base-read failures create a manual-handling ticket (original submission, `intakeIssue`, escalated, no invented classification or response) instead of aborting the run.
- **Strict priority/category validation** and one shared approval rule: only Low/Medium without `escalationRequired`, `not_covered` or an `intakeIssue` is automatic; everything else needs a human, in both n8n routing and the dashboard (`approvalRequired(ticket)`, no priority aliases).
- **Knowledge-base coverage enforced:** no active articles / `not_covered` / `escalationRequired` override automatic handling; invented steps are stripped.
- Proposed workflow JSON regenerated (still not imported or run). New optional ticket field `intakeIssue`.

## Audit remediation, phase 3 (response lifecycle)

- **Late results can't overwrite a newer attempt.** A retry reuses the idempotency key, so recording an outcome now also requires the attempt number to match (ticket and follow-up).
- **Outcome write is retried** (twice, short delay; safe because it only applies while the claim is `sending`), and an unexpected error after a claim settles the send as `unknown` immediately instead of waiting for the claim to go stale.
- **Append-only audit trail** in a new subcollection `support_tickets/{id}/response_events`, written in the same transaction as each change: approve/reject/reopen, edits (keeps the replaced text), send claims, outcomes, agent reconciliations, follow-up equivalents. `aiResponse` / `customerResponse` remain untouched. Nothing reads the collection yet (no UI).

## Audit remediation, phase 1

Security, data integrity and delivery-safety fixes from the architecture audit. No Firestore schema change for tickets or articles. Added fields are listed below. One new dependency-free auth layer, one test suite (`npm test`).

### Security
- **Authentication (new, enforced server-side).** Single shared account; signed httpOnly cookie (HMAC-SHA256, 8 h), scrypt password hash, rate-limited login. `requireAuth()` runs first in **every** API route, so a protected page is not the only barrier; `src/proxy.ts` additionally redirects signed-out page visits to `/login`. **Fails closed**: with the three `AUTH_*` settings missing, every API answers 503 and every page redirects. Generate the values with `npm run auth:hash`.
- Ticket API output is now an **allowlist** (internal fields such as the send idempotency key are no longer returned).
- The send webhook secret is **required in production**.
- Cross-site request guard now also checks `Sec-Fetch-Site`.
- Removed the mock user ("Amara Okafor") and the fake "3 unread" notification badge; added Sign out.

### Response lifecycle and delivery safety
- `responseStatus` is now `draft | queued | sending | sent | failed | unknown`; `reviewStatus` is unchanged and separate.
- A timeout, dropped connection, 5xx or 408 is recorded as **`unknown`, never `failed`**. `failed` means known not delivered (n8n said so, a 4xx, or no connection was made).
- A claim that never recorded an answer reads as `unknown` after 2 minutes (it used to be silently re-sendable, which could duplicate an email).
- `unknown` / `queued` sends are **not retried automatically and not resendable by a plain click**. An agent can mark it delivered, mark it not delivered, or explicitly "Send again anyway" (warned about a duplicate). New routes: `POST /api/tickets/[id]/reconcile`, `POST /api/tickets/[id]/followups/[messageId]/reconcile`.
- The idempotency key is stable per message and also sent as an `Idempotency-Key` header; `attempt` is included. **Exactly-once delivery is not claimed**: de-duplicating a repeat requires the n8n step documented in `docs/n8n-send-response-workflow.md`.
- Overview "Awaiting review" and the table status no longer count Low/Medium tickets carrying a legacy `awaiting_review`.
- Added ticket fields (written only by the dashboard): `responseAttempts`, `responseConfirmedBy`; message field `attempts`, `confirmedBy`. Existing documents work unchanged.

### Knowledge Base
- A full edit that omits `active` no longer silently reactivates an inactive article.
- Creating an article is idempotent per form submission (the request ID is the document ID); a duplicate title in the same category is refused (409).
- Edits carry a version token; a stale edit is refused (409) instead of overwriting a concurrent change.

### Errors and visibility
- 5xx responses carry a short `requestId` that matches the server log; stacks never reach the client.
- When the 1,000-ticket / 200-article safety cap cuts results off, the UI says so (it used to be silent).
- Fixed a crash in the follow-up panel when `customerEmail` was not a string.

### n8n (proposed, NOT imported or run)
`n8n/ai-support-desk-automation.json` is a **proposed** corrected intake workflow, generated from the exported one. See `docs/n8n-intake-workflow.md`. The live workflow has not been changed.

### Tests
`npm test` (Node's built-in runner, no new dependency): lifecycle, Knowledge Base, auth, every API route unauthenticated, workflow Code nodes and wiring, regression.

## Settings page

Replaces the Settings placeholder with a read-only, honest status page. No schema change, no new dependency, no new environment variable, no new collection, no n8n change, no authentication.

### What it shows
- **Workspace**: app name and description, data store (Firestore project ID), and the fact that the dashboard has no sign-in.
- **Integrations**: Firebase/Firestore (measured with count queries: ticket and article counts, latest ticket); the n8n ticket pipeline with Gemini and Gmail delivery (shown as handled by n8n: the dashboard cannot observe them); the n8n send-response webhook (Awaiting setup / Misconfigured / Configured, not verified; "Delivery confirmed before" only once a response has actually been recorded as sent). The webhook is never called by the status check, because that would send an email. URL and secret are shown only as Set or Not set.
- **Notifications**: which emails exist and where each is controlled. No toggles: nothing in the architecture can honestly be switched from the dashboard, so none were added.
- **Application**: version from `package.json`, environment, Next/React/Node versions, read limits.

A **Re-check** button re-runs the measurements. Loading, error (with retry) and failed-refresh states are handled.

### Added
- `GET /api/settings/status` (read-only, no-store)
- `src/lib/app-info.ts`, `settings-status.ts`, `system-status.ts`, `src/lib/api/settings.ts`
- `src/hooks/use-settings-status.ts`, `src/components/settings/settings-page.tsx`
### Modified
- `src/app/(dashboard)/settings/page.tsx`

## Knowledge Base: edit, activate and deactivate

Completes article management. Writes go through a server-side `PATCH /api/knowledge-base/[id]` to the existing `knowledge_base` collection. No schema change, no new dependency, no new environment variable, no n8n change. **Permanent deletion is intentionally not implemented**: there is no DELETE route or button (DELETE and PUT answer 405). Deactivating is the safe alternative.

### Behaviour
- **Edit article** (button in the reader): the same form as Add article, prefilled with the article's current title, category, keywords, content and status. "Save changes" stays disabled until something changes; the stored category is kept exactly as written. Same validation as creation (required fields, trimmed, blank and duplicate keywords prevented). On save the existing document is updated in place (same ID, never a new document), the list and the selected article refresh, and a success notice appears. If saving fails, the form stays open with everything entered and shows the error; Save retries; repeat submissions are blocked while saving.
- **Deactivate / Activate** (button in the reader): deactivating asks for confirmation (inline), activating does not. Only the `active` boolean is written; title, category, keywords, content and ID are untouched. The change shows immediately and is re-read from Firestore; success and failure notices are shown. Inactive articles stay in the list (dimmed, "Inactive" badge), stay readable and editable, and can be reactivated.

### API
`PATCH /api/knowledge-base/[id]` with either `{ "active": boolean }` (toggle, writes only `active`) or the full edit `{ title, category, keywords, content, active }`. Order of checks: document ID (400 `invalid_article_id`), request guard (415/413/400/403), body validation (422 `validation_failed` with per-field messages), then Firestore. A missing document is 404 `article_not_found` and nothing is created. The write is a transaction using `update()`, so any extra fields on a document are preserved.

### Modified / added
- `src/app/api/knowledge-base/[id]/route.ts` (new): the PATCH route.
- `src/lib/knowledge-base.ts`: `parseArticleUpdate`, `updateFields`.
- `src/lib/firestore-knowledge-base.ts`: `updateKnowledgeArticle`, `KnowledgeNotFoundError`, `InvalidArticleIdError`.
- `src/lib/knowledge-api-errors.ts`: 400/404 mapping.
- `src/lib/api/knowledge-base.ts`: shared `send` helper; `updateKnowledgeArticle`, `setArticleActive` client calls (create now uses the same helper).
- `src/hooks/use-knowledge-base.ts`: `replaceArticle`.
- `src/components/knowledge/article-form-dialog.tsx`: edit mode (prefill, change detection, labels).
- `src/components/knowledge/knowledge-explorer.tsx`: Edit / Deactivate / Activate controls, confirmation, success and error notices.
- `CHANGELOG.md`.

### Tested / not tested
- Lint, type-check and production build pass; Overview, Tickets, Escalations and ticket details still load.
- Logic tests with an in-memory Firestore fake: same ID, only schema fields written, extra fields preserved, no document created, toggle writes only `active` and restores to the original document, missing document and invalid IDs written nothing.
- API checks on a running build: 400 invalid ID, 415, 400 bad JSON, 403 cross-origin, 422 field messages, valid input reaches Firestore access, DELETE/PUT 405.
- Browser tests (stubbed API): prefilled edit form, no-change disabled save, validation, duplicate/blank keywords, failed save keeps input then retry succeeds, double-click sends one request, no duplicate article, keywords and content displayed after save, deactivate (cancel, failure, success), reactivate, inactive article stays visible and editable, 404 handled, create/search/view unchanged, mobile.
- **Not tested against your real Firestore.** Try: edit the existing article, check the document ID and fields in the Firebase console, deactivate and reactivate it.

### Limitations
- Last write wins: if two people edit the same article, the later save replaces the earlier one (no conflict detection).
- No authentication: anyone who can reach the dashboard can edit or deactivate articles.
- Whether an inactive article is skipped by the n8n workflow depends on how that workflow filters on `active`; the dashboard only sets the field.

---

## Add Knowledge Base articles

Adds an **Add article** button and form to `/knowledge-base`. New articles are written server-side to the existing `knowledge_base` collection with an auto-generated document ID, using exactly the existing five fields (`title`, `category`, `keywords`, `content`, `active`). No new collection, no schema change, no extra fields (no timestamps), no new dependency, **no new environment variable**. Existing documents (including `app_crash_troubleshooting`) are never modified: the write uses Firestore `create()`, which can't overwrite. Editing and deleting are still not implemented.

### Added
- `src/components/knowledge/article-form-dialog.tsx`: the form, in a native `<dialog>` (focus trap, Esc, backdrop). Title; category (Bug, Question, Billing, Account, Technical Support, categories already in use, or "Other (custom)"); keywords as removable chips (Enter, comma or Add; trimmed, blanks and case-insensitive duplicates rejected); Markdown content editor with Write/Preview; Active switch (default on). Save is disabled while saving; on failure the dialog stays open with everything entered and shows the error, and Save retries. Closing with unsaved input asks for confirmation.

### Modified
- `src/lib/knowledge-base.ts`: shared `validateArticleInput` (used by the form and the server), `cleanKeywords`, limits and category presets.
- `src/lib/firestore-knowledge-base.ts`: `createKnowledgeArticle` (auto ID, `create()`).
- `src/app/api/knowledge-base/route.ts`: new `POST`. Checks JSON content type, same-origin, size, then validates (422 `validation_failed` with per-field messages) before touching Firestore. 201 `{ article }` on success.
- `src/lib/knowledge-api-errors.ts`: request-guard errors and write-specific messages.
- `src/lib/api/knowledge-base.ts`: `createKnowledgeArticle` client call.
- `src/lib/api/tickets.ts`, `src/lib/types.ts`: `TicketsApiError` and `ApiErrorBody` gain an optional `fields` map for validation messages.
- `src/hooks/use-knowledge-base.ts`: `addArticle` shows the new article immediately, then re-reads Firestore so the list stays Firestore-backed.
- `src/components/knowledge/knowledge-explorer.tsx`: Add article button, dialog wiring, success notice (auto-dismisses), selects the new article and clears the search so it is visible.
- `src/components/knowledge/knowledge-states.tsx`: empty-state text points to Add article.
- `CHANGELOG.md`.

### Validation (server)
Title 1-200, category 1-60, content 1-50,000 characters (all trimmed; line endings normalised); keywords optional, max 20, each 1-50 characters, blanks dropped, duplicates removed; `active` must be boolean (default true). Unknown properties are ignored.

### Setup
None. Your service account must be allowed to **write** to Firestore (it already writes tickets). If it can't, the form shows "Firestore rejected the save".

### Tested / not tested
- Lint, type-check and production build pass; Overview, Tickets, Escalations and the earlier Knowledge Base browser tests still pass.
- 5 logic tests (validation, exact five-field write with auto ID, error propagation); API checks on a running build (415, 400, 403, 422 with field messages, valid payload reaches Firestore access); browser test with a stubbed API: validation, custom category, keyword chips, preview, toggle, double-click sends one request, failed save keeps all input, retry succeeds, list refreshes, new article readable with its status and keywords, confirm-on-close, mobile.
- **Not tested against your real Firestore** (no credentials here). Please create one test article and check the document in the Firebase console.

### Limitations
- A save whose response is lost (browser offline after the server wrote) can't be detected, so retrying could create a second article. Firestore auto IDs make a retry a new document; delete the duplicate in the console if it happens.
- Still no authentication: anyone who can reach the dashboard can add articles.

---

## Knowledge Base page (`/knowledge-base`)

Read-only. Reads the existing Firestore collection `knowledge_base` through the shared Firebase Admin instance, server-side only. No schema change, no writes, no new dependency, no new environment variable, no n8n change.

### Added
- `src/app/api/knowledge-base/route.ts`: `GET /api/knowledge-base`, all articles as JSON (active first); same error shape as the ticket routes.
- `src/lib/firestore-knowledge-base.ts` (server-only): reads `knowledge_base` (cap 200), reusing `getAdminDb` and `withTimeout`.
- `src/lib/knowledge-api-errors.ts`: maps errors to JSON responses (knowledge-base wording).
- `src/lib/knowledge-base.ts` (pure): document -> article normalisation (missing/odd fields tolerated), search, and a small Markdown parser (headings, nested ordered/bullet lists, bold, italic, inline code, rules). Output is plain data rendered as React elements, so article text can't inject HTML.
- `src/lib/api/knowledge-base.ts`, `src/hooks/use-knowledge-base.ts`: client fetch and hook (same pattern as tickets).
- `src/components/knowledge/knowledge-explorer.tsx`: searchable article list, article reader (title, category, Active/Inactive, keywords, ID, last updated only if the document has `updatedAt`), refresh.
- `src/components/knowledge/markdown-content.tsx`: Markdown rendering with search-term highlighting; drops a leading `# Title` that merely repeats the article title.
- `src/components/knowledge/knowledge-states.tsx`: loading, empty and error states.

### Modified
- `src/app/(dashboard)/knowledge-base/page.tsx`: placeholder replaced by the explorer.
- `src/lib/types.ts`: added `KnowledgeArticle`.
- `src/lib/api/tickets.ts`: `requestJson` is now exported (one keyword) so the knowledge-base client can reuse it.
- `CHANGELOG.md`.

### Behaviour
- Fields used: `title`, `category`, `active`, `keywords`, `content` (and `updatedAt` only if present). Article ID = document ID.
- Search matches title, category, keywords, ID and content (all words must match); content matches show a snippet and are highlighted in the reader.
- Inactive articles are shown, labelled "Inactive" and dimmed. The list always renders, so a single article shows as "1 article" and more articles work without changes.

### Tested / not tested
- Lint, type-check and production build pass; Overview, Tickets and Escalations still load.
- 7 logic tests (normalisation, Markdown, search, ordering) and browser tests with a stubbed API: one article, inactive plus multiple articles, empty, error and retry, loading, mobile width, no HTML injection.
- Without credentials, the real route correctly answers 503 `firebase_not_configured`.
- **Not tested against your real Firestore.** The stub used your documented fields, not your actual article text. Check how the real Markdown renders (see the checklist in the reply).

---

## Priority-based handling, follow-ups and communication history

### Behaviour
- **Approval is decided by priority, never by stored `reviewStatus`.** Low and Medium: no approval; High and Urgent: approval required. A missing or unrecognised priority requires approval (safe default).
- **Low / Medium tickets:** read-only AI response, an "approval not required" badge, a note that the acknowledgement is sent automatically by the existing n8n workflow, and no Approve / Reject / Edit / Restore / Send controls. A legacy `awaiting_review` value is ignored on the ticket page (the "Review status" field shows "Not required"). The server also refuses review and send requests for these tickets (HTTP 409 `approval_not_required`), so the rule isn't only in the UI.
- **High / Urgent:** the approval workflow from the previous change is unchanged. Once sent, the response is locked.
- **Follow-up composer on every ticket**, independent of the initial response's review or delivery state. Sending a follow-up never touches `aiResponse`, `customerResponse`, `finalResponse`, `reviewStatus` or `responseStatus`.
- **Communication history** on the ticket page: the original AI response, the final agent response (when saved), and every follow-up with status and timestamps; failed or unconfirmed follow-ups can be retried.

### Storage
- Follow-ups are documents in the subcollection `support_tickets/{ticketId}/messages` (ID = message ID = idempotency key; fields: `type`, `source`, `content`, `status`, `createdAt`, `queuedAt`, `sentAt`, `error`). One document per message means no write contention, no overwriting sent messages and no migration of existing tickets.
- The AI and agent responses are shown in the history from the ticket's existing fields; nothing is duplicated or migrated.

### New / changed API
- `GET /api/tickets/[id]/messages`: follow-ups, oldest first.
- `POST /api/tickets/[id]/followups` with `{ messageId (uuid), content }`: claims the message in a transaction, calls the n8n webhook, records the result. A retry re-sends the **stored** text. 200 sent, 202 queued (unconfirmed), 502 failed, 504 timeout. The recipient always comes from the stored ticket.
- The n8n payload gained `messageType` (`initial_response` | `follow_up`), `messageId` and `messageBody` (the email text for both types). `finalResponse` is still sent for initial responses.

### n8n: remaining manual setup
Update the (not yet built) send workflow per `docs/n8n-send-response-workflow.md`: branch on `messageType`, point the Gmail node at `messageBody`, follow the follow-up path. No existing acknowledgement or escalation workflow is touched. No new environment variables.

### Files
New: `src/lib/communications.ts`, `src/lib/firestore-ticket-messages.ts`, `src/hooks/use-communications.ts`, `src/components/tickets/communications-panel.tsx`, `src/app/api/tickets/[id]/messages/route.ts`, `src/app/api/tickets/[id]/followups/route.ts`.
Modified: `src/lib/response-workflow.ts`, `src/lib/n8n-send-response.ts`, `src/lib/api/ticket-response.ts`, `src/components/tickets/response-workspace.tsx`, `src/components/tickets/ticket-detail.tsx`, `docs/n8n-send-response-workflow.md`, `CHANGELOG.md`.

### Tested / not tested
- Lint and production build pass.
- 28 logic tests against an in-memory Firestore fake (priority rules, double-click and concurrent claims, retry uses stored text, no downgrade of `sent`, ticket document untouched by follow-ups, history order) plus a local webhook stub.
- Browser tests (Playwright, stubbed API): Low and Medium show no approval controls even with a legacy `awaiting_review`; High shows them; follow-up failure, retry (same message ID, no new text), no resend after sent, a second follow-up, locked response after sent, mobile width.
- **Not tested:** real Firestore, real n8n, real Gmail. **Do not rely on email delivery until the n8n workflow is built and its checklist passes.**

### Limitations and things to decide
- Still **no authentication** on the dashboard.
- The Overview/All Tickets status badge and the "awaiting review" metric still use the stored `reviewStatus`, so Low/Medium tickets with the legacy value are still counted/labelled there. I left that alone (it changes Overview numbers); say if you want those to follow the priority rule too.
- The dashboard can't verify that the automatic acknowledgement was actually sent (no field records it); the note states what the workflow is meant to do.

---

## AI response review and sending

### Added
- **Response workspace** on the ticket details page (replaces the read-only "Responses" card): original AI response (read-only), editable final response, Restore original, Approve / Reject / Submit for review again, review and delivery status pills, confirm-then-send, sent / queued / failed panels, per-action loading states and live-region feedback.
- `POST /api/tickets/[id]/review` (approve / reject / reopen) and `POST /api/tickets/[id]/send`.
- Server-side send flow: validates the ticket, requires `reviewStatus="approved"`, takes the recipient and text from Firestore (never the browser), claims the send in a Firestore transaction (no double sends), calls the n8n webhook, and records the result.
- New ticket fields (all optional; older tickets work): `finalResponse`, `responseStatus` (`draft|queued|sent|failed`), `responseSentAt`, `responseError`, `responseSendId`, `responseQueuedAt`. `reviewStatus` uses `awaiting_review|approved|rejected`.
- `docs/n8n-send-response-workflow.md`: exact manual n8n setup + test checklist.
- `.env.example` (placeholders only). **If you have your own `.env.example`, merge rather than overwrite.**

### Environment variables (server only)
- `N8N_SEND_RESPONSE_WEBHOOK_URL`: production URL of the n8n send workflow. Unset = sending disabled (503).
- `N8N_SEND_RESPONSE_WEBHOOK_SECRET`: optional; sent as `X-Webhook-Secret`.

### Behaviour notes
- `aiResponse` and `customerResponse` are never written. Edits live in `finalResponse`.
- Approving never sends. Sending is blocked until approved, while the editor differs from the approved text, and after `sent`.
- "Sent" is shown only when n8n answers 2xx with `{"status":"sent"}`. A bare 200 leaves the ticket `queued` (HTTP 202); failures set `failed` with `responseError`; a stuck `queued` can be retried after 2 minutes.
- Changing the saved text resets delivery state to `draft`.

### Modified
`src/components/tickets/ticket-detail.tsx`, `src/lib/types.ts`, `src/lib/firestore-tickets.ts` (exports `withTimeout`, `isValidDocumentId`).

### Tested / not tested
- Lint and production build pass.
- Logic, an in-memory Firestore fake (including concurrent sends) and a local webhook stub: 17 tests pass.
- HTTP validation against `next start`; browser lifecycle with Playwright against stubbed API routes (desktop + mobile width).
- **Not tested:** real Firestore, real n8n, real Gmail. The in-memory fake is not the Firestore emulator.

### Limitations
- **No authentication in the dashboard.** Anyone who can reach the app can approve and send. Add auth before deploying publicly (or unset the webhook URL).
- Which of `aiResponse` / `customerResponse` is the "original" is an assumption (see `pickOriginalAiResponse` in `src/lib/response-workflow.ts`; one function to change).
