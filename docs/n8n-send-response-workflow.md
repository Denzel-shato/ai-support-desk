# n8n workflow: "Send support response" (agent-initiated customer email)

File: `n8n/ai-support-desk-send-response.json` (21 nodes, **inactive**, separate from the intake workflow).

**Status: proposed, partly checked, NOT configured and NOT tested against real Gmail.**
Nothing here has been imported into your n8n, activated, or run against your Gmail, your
Firestore or the real webhook URL. See "What has and has not been verified" at the bottom.

## Flow

```
Agent edits/approves a High/Urgent reply (or writes a follow-up) and clicks Send
 -> dashboard (server): auth + same-origin check, atomic Firestore claim "sending",
    builds payload from the STORED ticket, POSTs once with X-Webhook-Secret
 -> n8n: header auth -> Validate payload -> Get ticket -> Check ticket -> duplicate check
         -> claim in n8n_send_log -> Gmail "Send email" -> record sent -> Respond
 -> dashboard (server): reads the answer, records sent / failed / unknown on the ticket
    (or follow-up message), plus an audit event; the UI shows the result
```

The webhook URL and secret exist only in server environment variables; the browser never sees them.
This workflow is separate from intake, so Low/Medium auto-acknowledgements, escalation
notification emails, Gemini classification, KB evaluation and routing are untouched.

## Who updates what

| | Owner |
|---|---|
| `support_tickets/{id}` `responseStatus`, `responseSentAt`, `responseError`, content/recipient snapshot, audit events, follow-up message status | **Dashboard** (from n8n's answer) |
| `n8n_send_log/{key}__a{attempt}` (claim, one per attempt) and `n8n_send_log/{key}__sent` (Gmail accepted it, all attempts) | **n8n** (the only thing it writes) |

n8n deliberately never writes to a ticket: one writer for delivery status, and the Firestore
node has no "update" operation anyway (create/upsert/delete/get/getAll/query).

## Request contract (dashboard -> n8n)

`POST <N8N_SEND_RESPONSE_WEBHOOK_URL>`, headers `Content-Type: application/json`,
`X-Webhook-Secret: <secret>`, `Idempotency-Key: <key>`. Body (from `buildWebhookPayload` /
`buildFollowUpPayload` in `src/lib/n8n-send-response.ts`):

```json
{ "ticketId": "abc123", "messageType": "initial_response", "idempotencyKey": "<uuid>",
  "attempt": 1, "customerName": "Ann", "customerEmail": "ann@example.com",
  "subject": "Re: Your support request", "messageBody": "Hi Ann, ...",
  "finalResponse": "Hi Ann, ...", "ticket": { "...": "context" },
  "requestedAt": "2026-11-17T10:00:00.000Z", "source": "ai-support-desk" }
```
`follow_up` omits `finalResponse`/`ticket` and adds `messageId` (= `idempotencyKey`).
The idempotency key is identical on every retry of the same message; `attempt` increments.

## What the n8n workflow checks (in order, all before Gmail)

1. **Webhook** requires the Header Auth credential (`X-Webhook-Secret`); a wrong/missing secret is refused by n8n (401/403) before any node runs.
2. **Validate payload** (Code): ids are `[A-Za-z0-9_-]`, key 8-128 chars, known `messageType`, exactly one plain email address (no list/display name/line breaks), single-line subject <= 200, body 1-10,000 chars, `finalResponse` equals `messageBody`. Invalid -> `400 {"status":"failed","fields":[...]}`; submitted text is never echoed.
3. **Get ticket + Check ticket**: a missing document arrives as an empty item ("Always Output Data") -> 404; any error item is a genuine read failure -> `502 failed`, never "missing". Ticket exists, recipient equals the stored ticket's (409), and for `initial_response` the ticket is `reviewStatus == "approved"` and the stored `finalResponse` equals the payload text (409). Nothing has been sent at this point.
4. **Duplicate check** (`n8n_send_log`): `<key>__sent` exists -> `200 {"status":"sent", "deduplicated":true}`, no email; claim `<key>__a<attempt>` exists -> `200 {"status":"unknown"}`, no email; any error item on either read (even one that says "not found") -> `unknown`. Only an empty item means "no such document".
5. **Create claim** `n8n_send_log/<key>__a<attempt>` (`status, startedAt, ticketId, messageType, attempt`). Create fails if the doc exists, so two concurrent runs cannot both send; failure -> `unknown`.
6. **Gmail "Send email"**: To = validated recipient, Subject, plain text = validated body, n8n attribution disabled. On Error: continue (error output).
7. Success: create `<key>__sent` (`status, sentAt, gmailId, ticketId, messageType`), then `200 {"status":"sent","sentAt":...,"messageId":<Gmail id>}`. If that log write fails the answer is still `sent` (the email WAS sent; the dashboard must record it).
8. Gmail error: only a clear rejection (HTTP 400/401/403, invalid recipient, invalid_grant/credentials) is `failed`: the claim is deleted (so a retry can proceed; if that delete fails the answer is still `failed`, and the next attempt number uses a fresh claim anyway) and the answer is `502 {"status":"failed"}`. Anything else (timeout, 5xx, reset) keeps the claim and answers `200 {"status":"unknown"}`, so a repeat of the same attempt can never email twice.

How the dashboard reads each answer is in `interpretWebhookResponse` (`src/lib/response-workflow.ts`): `sent` only for 2xx + `{"status":"sent"}`; an explicit `failed`/`unknown` body is authoritative at any HTTP code; otherwise 4xx (not 408) = failed, 5xx/408/timeout (25 s)/dropped connection = unknown, cannot connect = failed. `unknown` blocks a plain resend; an agent resolves it ("It was delivered" / "It was not delivered" / "Send again anyway", the last reusing the same key).

## Retries and attempts

The dashboard reuses the idempotency key on every retry but raises `attempt` only after a known failure or an explicit agent decision ("It was not delivered" / "Send again anyway"). The claim is therefore per attempt: the same attempt can never send twice, an agent-resolved retry (next attempt) is not stuck behind the old claim, and a message with a `__sent` record is answered `sent` for any attempt without emailing again. Trade-off: if an agent wrongly marks an unconfirmed send as "not delivered" when it actually went out and left no `__sent` record (n8n crashed after Gmail), the resend will deliver a duplicate. The dashboard warns about this.

## Manual configuration you still have to do

1. In n8n create a **Header Auth** credential named exactly `Send response webhook secret`: header name `X-Webhook-Secret`, value = a long random secret.
2. Import `n8n/ai-support-desk-send-response.json` into a **non-production** n8n first. Attach credentials by name: the Gmail OAuth2 and Google Service Account credentials (same ones the intake workflow uses) and the Header Auth credential above. Check the Firestore `projectId` parameter on the six Firestore nodes is your project (it is set to this repo's Firebase project id).
3. Set an **Error Workflow** if you use one (a failed run before Respond appears to the dashboard as a timeout -> `unknown`, which is safe).
4. Activate it deliberately, then set in the dashboard's server environment (Vercel/hosting, **never** `NEXT_PUBLIC_*`):
   - `N8N_SEND_RESPONSE_WEBHOOK_URL` = the **Production** webhook URL (`.../webhook/send-support-response`)
   - `N8N_SEND_RESPONSE_WEBHOOK_SECRET` = the same secret as the credential
5. Run the manual test checklist below with a mailbox you own.
6. Optional: a retention job deleting old `n8n_send_log` documents.

## Manual test checklist (all unexecuted, do these before trusting it)
1. Wrong/missing secret -> refused (401/403), no email.
2. Empty `messageBody` -> 400. Recipient different from the ticket's -> 409.
3. Ticket not approved, or text edited after approval -> 409, no email.
4. Approved ticket to your own mailbox -> email arrives; `n8n_send_log` has `<key>__a1` and `<key>__sent`; dashboard shows Sent.
5. Re-send the identical request (same key) -> `sent` + `deduplicated`, **no second email**.
6. Follow-up on a Low ticket -> email arrives; ticket doc unchanged apart from the dashboard's own message record.
7. Delete `<key>__sent` but keep `<key>__a1` (simulated crash) -> a repeat of attempt 1 answers `unknown`, no email.
8. Break the Gmail credential -> `502 failed`; dashboard shows the error; fix and Retry works (claim was released).
9. Make the workflow exceed 25 s -> dashboard shows "Delivery unknown", not "Failed".
10. Confirm in your n8n version that the Firestore `get` of a missing document yields an empty item (the workflow relies on it, with "Always Output Data" set).

## What has and has not been verified

**Executed (automated, no network):** `tests/send-workflow.test.ts` runs every Code-node source in plain Node with a stub of n8n's helpers and checks the JSON graph: exactly one Gmail node reachable only after validation, ticket check, duplicate check and claim; the dashboard's real payload builder passes the n8n validator; every n8n answer is classified correctly by the dashboard's interpreter. Dashboard-side behaviour (authorization, validation, duplicate claims, failed/unknown handling, outcome recording) is covered by the existing lifecycle tests with a fake Firestore and mocked webhook.

**Executed in a throw-away local n8n 2.47.7 (CLI, no credentials, no network):** the workflow JSON imports; node types/versions are available; with the Webhook, Firestore and Gmail nodes replaced by stub Code nodes, scenarios (re-run after the final changes: valid send, existing claim, ticket read-error item, claim read error; earlier: duplicate, claim-create failure, Gmail rejection/ambiguous error, log write failure) took the expected branches and produced the expected answers (valid send, duplicate already sent, unfinished claim, claim-create failure, Gmail clear rejection, Gmail ambiguous error, log write failure after send, log read error). The Respond node could not be run without a real Webhook trigger.

**NOT verified:** real Gmail delivery; the real Webhook node's header authentication and Respond node; the real Firestore get/create behaviour in your n8n (read from source only); your n8n version; credential setup; end-to-end dashboard -> n8n -> Gmail. No real email was sent and no production data was touched.

**Limitations:** per-message de-duplication works only while this workflow is built and active as described; a deleted/invalid credential makes n8n fail the whole run before any node (the dashboard then records `unknown`); a send claim in `n8n_send_log` that never finishes needs an agent decision in the dashboard.
