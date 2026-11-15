# Changelog

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
