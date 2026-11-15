# n8n workflow: "Send approved response" (manual setup)

**Status: NOT configured and NOT tested.** This is a specification. Nothing here has
run against a real n8n, Gmail or Firestore. Build it as a **new, separate workflow**;
do not touch the existing classification / KB / escalation branches. Until you have
built it and run the tests at the bottom, do not treat email delivery as working.

The dashboard only counts an email as sent when n8n replies **HTTP 2xx with
`{"status":"sent"}`**, so the Respond node must come **after** Gmail succeeds.

## 1. Webhook node
- HTTP Method: `POST`; Path: e.g. `send-support-response`
- Authentication: **Header Auth** (header `X-Webhook-Secret`, value = your secret; same value as `N8N_SEND_RESPONSE_WEBHOOK_SECRET`)
- Respond: **Using 'Respond to Webhook' node**
- Activate the workflow and use the **Production URL** in `N8N_SEND_RESPONSE_WEBHOOK_URL` (not the Test URL).

**Two message types arrive at this one webhook**, told apart by `messageType`:
`"initial_response"` (an approved High/Urgent reply) and `"follow_up"` (an agent's extra message,
any priority). Add an **IF/Switch on `{{ $json.body.messageType }}`** right after validation and
follow the matching path below. **In both cases the Gmail node sends `messageBody`.**

Incoming JSON body for `initial_response` (from the dashboard server, built from the stored ticket):
```json
{
  "ticketId": "abc123",
  "messageType": "initial_response",
  "idempotencyKey": "6f1c2e0e-....",
  "customerName": "Ann",
  "customerEmail": "ann@example.com",
  "subject": "Re: Your support request",
  "messageBody": "Hi Ann, ...",
  "finalResponse": "Hi Ann, ...",
  "ticket": { "summary": "...", "category": "...", "priority": "high",
              "originalMessage": "...", "createdAt": "2026-11-14T08:00:00.000Z" },
  "requestedAt": "2026-11-14T09:00:00.000Z",
  "source": "ai-support-desk"
}
```

Incoming JSON body for `follow_up` (no ticket-level approval applies):
```json
{
  "ticketId": "abc123",
  "messageType": "follow_up",
  "messageId": "123e4567-e89b-42d3-a456-426614174000",
  "idempotencyKey": "123e4567-e89b-42d3-a456-426614174000",
  "customerName": "Ann",
  "customerEmail": "ann@example.com",
  "subject": "Re: Your support request",
  "messageBody": "Quick question: which router model is it?",
  "requestedAt": "2026-11-14T09:00:00.000Z",
  "source": "ai-support-desk"
}
```

## 2. IF: validate payload
True only if `ticketId`, `customerEmail`, `messageBody` and `idempotencyKey` are all non-empty
and `customerEmail` contains exactly one address. False -> **Respond to Webhook**: status `400`,
body `{"status":"failed","error":"Invalid payload"}`.

## 3. Firestore: Get document (reuse your existing Firestore credential)
Collection `support_tickets`, Document ID `{{ $json.body.ticketId }}`.
Enable "Always Output Data". Missing document -> Respond `404`, `{"status":"failed","error":"Ticket not found"}`.

## 4. IF: safety checks against the stored ticket
- If stored `responseStatus == "sent"` -> **Respond 200** `{"status":"sent","sentAt":"<stored responseSentAt>","messageId":null}` and stop (dedupe: never email twice).
- Else require stored `reviewStatus == "approved"` AND stored `customerEmail` equals the payload `customerEmail` (case-insensitive). Otherwise Respond `409`, `{"status":"failed","error":"Ticket is not approved or the email does not match"}`.

### Follow-up path (`messageType == "follow_up"`)
Skip the ticket-level checks above (a follow-up does not depend on `reviewStatus` or `responseStatus`).
1. **Firestore: Get document** `support_tickets/{{ticketId}}/messages/{{messageId}}`.
   If its `status == "sent"` -> **Respond 200** `{"status":"sent","sentAt":"<stored sentAt>","messageId":null}` and stop (dedupe).
   If the document is missing -> Respond `404` (the dashboard always creates it before calling n8n).
2. Check the stored ticket's `customerEmail` equals the payload `customerEmail`; otherwise Respond `409`.
3. **Gmail** node as below, then **Respond 200** `{"status":"sent","sentAt":..., "messageId": <gmail id>}`;
   on Gmail error **Respond 502** `{"status":"failed","error":"Gmail could not send the email"}`.
4. **Do not write to the ticket document** for follow-ups. The dashboard records the outcome on the
   message document itself after it receives your response. (n8n may also update that message document
   if you prefer, using only `status`, `sentAt`, `error`.)

## 5. Gmail: Send a message (reuse your existing Gmail credential)
- To: `{{ $('Webhook').item.json.body.customerEmail }}`
- Subject: `{{ $('Webhook').item.json.body.subject }}`
- Email type: **Text**; Message: `{{ $('Webhook').item.json.body.messageBody }}` (works for both message types)
- Settings -> **On Error: Continue (using error output)** so failures can be handled.

## 6a. Success branch
1. **Firestore: Update document** `support_tickets/{{ticketId}}`, fields:
   `responseStatus = "sent"`, `responseSentAt = {{ $now.toISO() }}` (as timestamp), `responseError = null`.
   Update only those fields; never `aiResponse`/`customerResponse`/`finalResponse`.
2. **Respond to Webhook**: `200`, JSON
   `{"status":"sent","sentAt":"{{ $now.toISO() }}","messageId":"{{ $('Gmail').item.json.id }}"}`

## 6b. Gmail error branch
1. **Firestore: Update document**: `responseStatus = "failed"`, `responseError = <short error text>`.
2. **Respond to Webhook**: `502`, JSON `{"status":"failed","error":"Gmail could not send the email"}`.
   (Keep the error message generic; do not echo credentials or internals.)

## Notes
- The dashboard has a 25 s timeout. Keep the workflow fast; if it exceeds it, the dashboard shows
  "check before retrying" and keeps the ticket retryable.
- Retries reuse the same `idempotencyKey` for the same text; step 4 is what actually prevents a duplicate.
- Set the workflow's execution timeout and error workflow as you prefer.

## Manual test checklist (do all before trusting it)
1. Webhook with wrong/missing secret -> rejected (403).
2. Payload with empty `finalResponse` -> 400.
3. Ticket not approved in Firestore -> 409, no email.
4. Approved ticket -> email arrives, Firestore `responseStatus="sent"`, dashboard shows Sent.
5. Repeat the same send -> 200 `sent` with no second email.
5a. Follow-up on a Low ticket (not approved) -> email arrives; `support_tickets/{id}/messages/{messageId}` shows `sent`; the ticket's own fields are unchanged.
5b. Repeat the same follow-up `messageId` -> 200 `sent`, no second email.
6. Break the Gmail credential -> 502, `responseStatus="failed"`, dashboard shows the error and Retry works after fixing it.
