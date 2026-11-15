# Changelog

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
