# n8n workflow: "Send approved response" (manual setup)

**Status: NOT configured and NOT tested.** This is a specification. Nothing here has
run against a real n8n, Gmail or Firestore. Build it as a **new, separate workflow**;
do not touch the intake workflow. Until you have built it and run the tests at the
bottom, do not treat email delivery as working.

## What the dashboard does and does not guarantee

Gmail delivery and Firestore status updates are separate systems, so **exactly-once
delivery cannot be guaranteed by the dashboard alone**. What it does:

- Claims each send atomically in Firestore (`sending`), so two requests can't both send.
- Sends a **stable `idempotencyKey`** (same for every retry of the same message) in the
  JSON body and in an `Idempotency-Key` header.
- Calls n8n **once** and never retries automatically.
- Treats only HTTP 2xx + `{"status":"sent"}` as delivered.
- Records anything ambiguous as **`unknown`** (never `failed`) and refuses to resend it until
  an agent either marks it delivered / not delivered, or explicitly chooses "Send again anyway".

What only n8n can do, and why this workflow must implement step 4 below: if Gmail sends the
email but the reply is lost (timeout, crash), the dashboard sees `unknown`. If the agent then
resends, **n8n is the only place that can recognise the repeat** by `idempotencyKey` and refuse
to email twice.

## How the dashboard reads n8n's answer

| n8n answers | Dashboard records |
|---|---|
| 2xx and `{"status":"sent"}` | `sent` |
| 2xx without that (e.g. "Workflow was started") | `queued` (accepted, not confirmed) |
| any status and `{"status":"failed"}` | `failed` (known not delivered; plain retry allowed) |
| 4xx (not 408), e.g. 400/401/403/404/409 | `failed` (request refused, nothing sent) |
| any status and `{"status":"unknown"}` | `unknown` |
| 5xx, 408, timeout (25 s), dropped connection | `unknown` |
| could not connect at all (refused, DNS) | `failed` |

So: **only answer 4xx / `failed` when you are certain no email was sent.** If anything could
have gone out, answer `{"status":"unknown"}` (or let it time out).

## 1. Webhook node
- HTTP Method: `POST`; Path: e.g. `send-support-response`
- Authentication: **Header Auth** (header `X-Webhook-Secret`, value = your secret; same value as
  `N8N_SEND_RESPONSE_WEBHOOK_SECRET`). The dashboard refuses to send in production without a secret.
- Respond: **Using 'Respond to Webhook' node**
- Activate the workflow and use the **Production URL** in `N8N_SEND_RESPONSE_WEBHOOK_URL`.

Two message types arrive at this one webhook, told apart by `messageType`: `"initial_response"`
(an approved High/Urgent reply) and `"follow_up"` (an agent's extra message, any priority).
**In both cases the Gmail node sends `messageBody`.**

```json
{
  "ticketId": "abc123",
  "messageType": "initial_response",
  "idempotencyKey": "6f1c2e0e-....",
  "attempt": 1,
  "customerName": "Ann",
  "customerEmail": "ann@example.com",
  "subject": "Re: Your support request",
  "messageBody": "Hi Ann, ...",
  "finalResponse": "Hi Ann, ...",
  "ticket": { "summary": "...", "category": "...", "priority": "High",
              "originalMessage": "...", "createdAt": "2026-11-14T08:00:00.000Z" },
  "requestedAt": "2026-11-14T09:00:00.000Z",
  "source": "ai-support-desk"
}
```
`follow_up` is the same without `finalResponse`/`ticket`, plus `"messageId"` (= `idempotencyKey`).
`attempt` is 1 for the first try and higher for an agent-approved resend of the same message.

## 2. IF: validate payload
True only if `ticketId`, `customerEmail`, `messageBody` and `idempotencyKey` are non-empty and
`customerEmail` is exactly one address. False -> **Respond** `400`, `{"status":"failed","error":"Invalid payload"}`.

## 3. Firestore: Get document
Collection `support_tickets`, Document ID `{{ $json.body.ticketId }}`; enable "Always Output Data".
Missing -> Respond `404`, `{"status":"failed","error":"Ticket not found"}`.

## 4. De-duplicate by idempotency key (the step that prevents double emails)
Use a small **n8n-owned** collection `n8n_send_log`, document ID = `idempotencyKey`. (This is a new
collection, added only for this reason: nothing else can record "Gmail was already asked to send
this" atomically before Gmail runs. The dashboard never reads or writes it.)

1. **Firestore: Get document** `n8n_send_log/{{ idempotencyKey }}`.
   - `status == "sent"` -> **Respond 200** `{"status":"sent","sentAt":"<stored sentAt>","messageId":"<stored gmailId>"}` and stop. No second email.
   - `status == "sending"` -> an earlier run started and never finished. Gmail may or may not have sent it.
     **Respond 200** `{"status":"unknown","error":"An earlier attempt did not finish"}` and stop. (Do NOT email again.
     The agent checks the inbox and resolves it in the dashboard.)
   - missing -> continue.
2. **Firestore: Create document** `n8n_send_log/{{ idempotencyKey }}` with `{status:"sending", startedAt, ticketId}`.
   `Create` fails if the document already exists, so two concurrent runs can't both proceed. On failure ->
   Respond `200` `{"status":"unknown"}`.
3. Safety checks against the stored ticket (Initial response only): `reviewStatus == "approved"`, and stored
   `customerEmail` equals the payload's (case-insensitive). Otherwise delete nothing, update the log
   `status="rejected"`, Respond `409` `{"status":"failed","error":"Ticket is not approved or the email does not match"}`.
   For `follow_up`, only check the email matches the stored ticket's.

## 5. Gmail: Send a message
- To: `{{ $('Webhook').item.json.body.customerEmail }}`; Subject: `{{ ...body.subject }}`
- Email type: **Text**; Message: `{{ ...body.messageBody }}`
- Settings -> **On Error: Continue (using error output)**.

## 6a. Success branch
1. **Firestore: Update** `n8n_send_log/{{ idempotencyKey }}`: `status="sent"`, `sentAt`, `gmailId`.
   (If this write fails, the log stays `sending`: later repeats answer `unknown`, which is the safe outcome.)
2. For `initial_response` only: **Firestore: Update** `support_tickets/{{ticketId}}`: `responseStatus="sent"`,
   `responseSentAt` (timestamp), `responseError=null`. Only those fields; never `aiResponse`/`customerResponse`/`finalResponse`.
   For `follow_up`, do not write to the ticket; the dashboard records the outcome on the message document.
3. **Respond 200** `{"status":"sent","sentAt":"{{ $now.toISO() }}","messageId":"<Gmail id>"}`

## 6b. Gmail error branch
Gmail's error output does not always prove nothing was sent (a timeout inside the Gmail node can
follow a successful send). Only for a clear, immediate rejection (e.g. an invalid-address or
authentication error returned by Gmail's API):
1. Update `n8n_send_log/{{ idempotencyKey }}`: `status="failed"` (so a retry may proceed: change step 4.1 to treat `failed` like "missing").
2. **Respond 502** `{"status":"failed","error":"Gmail could not send the email"}`.
For any other error, leave the log as `sending` and Respond `200` `{"status":"unknown"}`.
Keep messages generic; never echo credentials or internals.

## Notes
- The dashboard waits 25 s, then records `unknown`. Keep the workflow fast.
- A dashboard "resend anyway" reuses the same `idempotencyKey`, so step 4 answers `sent`/`unknown`
  instead of emailing again. Without step 4 a resend can deliver a duplicate: the dashboard warns the
  agent about exactly that.
- Delete `n8n_send_log` documents after a retention period of your choice.

## Manual test checklist (do all before trusting it)
1. Wrong/missing secret -> rejected (401/403).
2. Empty `messageBody` -> 400.
3. Ticket not approved -> 409, no email.
4. Approved ticket -> email arrives; `n8n_send_log` shows `sent`; ticket `responseStatus="sent"`.
5. Send the identical request again (same `idempotencyKey`) -> 200 `sent`, **no second email**.
6. Follow-up on a Low ticket -> email arrives; the ticket document is unchanged.
7. Same follow-up `messageId` again -> 200 `sent`, no second email.
8. Stop the workflow after step 4.2 (simulate a crash) -> next repeat answers `unknown`; dashboard shows "Delivery unknown"; "It was delivered" / "It was not delivered" / "Send again anyway" behave as described.
9. Break the Gmail credential -> 502 `failed`; dashboard shows the error and Retry works after fixing it.
10. Let the workflow exceed 25 s -> dashboard shows "Delivery unknown", NOT "Failed".
