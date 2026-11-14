# Changelog

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
