# Intake workflow: proposed corrections (NOT imported, NOT run)

`n8n/ai-support-desk-automation.json` is a **proposed integration artifact** generated from the
exported workflow. It has **not** been imported into n8n, executed, or tested against Gemini,
Firestore or Gmail. The live workflow is unchanged. Treat this as a reviewed starting point, not a
production-ready workflow.

## Problems found in the export, and what the proposal does

| # | Finding in the export | Proposed change |
|---|---|---|
| 1 | `Get many documents` returns N articles, so everything after it runs N times | New Code node **Select active articles** (all items) collapses them into ONE item |
| 2 | Gemini evaluation received articles as separate items (one evaluation per article) | The evaluation prompt now gets ONE combined `knowledgeBase` text; **one** Gemini call |
| 3 | `Code in JavaScript` ran once per item -> one ticket per article | **Build ticket** runs once for all items and returns exactly one item |
| 4 | Inactive articles were not filtered | Filtered (`active` true or `"true"`) in Select active articles |
| 5 | Article metadata not preserved in the prompt | Each article includes ID, title, category, keywords, content |
| 6 | Normal branch upsert used `updateKey: "={{ $json._id }}"` (a field *name*, wrongly given an ID value), escalation used `"_id"` | **Both upserts and both Edit Fields nodes removed.** Routing fields are computed in Build ticket and stored by the single Create |
| 7 | No tracking beyond the ticket | Out of scope here: delivery tracking is in the dashboard and `docs/n8n-send-response-workflow.md` |

New flow: `Form Trigger -> classify -> Get many documents (Always Output Data) -> Select active articles -> evaluate (one call) -> Build ticket -> Create a document (one) -> Prepare email fields -> If escalationStatus == "required" -> escalation email / acknowledgement email`.

`.first()` replaces `.item` for the Form Trigger and classification references downstream of the
aggregation, because a Code node in "all items" mode does not preserve n8n's item pairing.

## Deliberate behaviour changes you must review

1. **Acknowledgement recipient.** The export sends *both* emails to a hard-coded personal address.
   The proposal sends the acknowledgement to `{{ $json.customerEmail }}` (the stored customer). If you
   still want test mode, put your own address back in that node. **Importing this and activating it will
   email real customers.**
2. **Escalation recipient** is the placeholder `REPLACE_WITH_ESCALATION_INBOX@example.com`: set it.
3. **High/Urgent tickets now get `reviewStatus: "awaiting_review"`** at creation (previously the
   escalation branch wrote no `reviewStatus`). Low/Medium still get it as before; the dashboard ignores it for them.
4. **HTML escaping.** Customer and model text is HTML-escaped once (Prepare email fields) before it is
   put into the HTML emails; the templates reference `$json.safe.*`. Email layout is otherwise unchanged.
5. Routing is still **priority only** (High/Urgent). The model's `escalationRequired` is still stored but, as
   before, does not change routing.
6. The workflow is exported **inactive**, credentials are referenced by name only (re-select them after
   import), and the instance ID, webhook IDs and the personal email address were removed.

## Failure handling and routing rules (phase 4A)

The three Gemini/Firestore-read nodes are set to **continue on error**, and `Build ticket` never throws:

| Situation | Result |
|---|---|
| Classification fails (error, empty, not JSON) | One ticket with ONLY the customer's submission, `intakeIssue: classification_failed`, `escalationStatus: required`. No priority/category/summary/response is invented; the evaluation output is ignored too. |
| Evaluation fails or is malformed | Real classification kept; `intakeIssue: evaluation_failed` / `evaluation_invalid`; no `kbStatus`, no response; escalated. |
| Knowledge-base read fails | `intakeIssue: knowledge_base_unavailable`, `kbStatus: not_covered`, no response; escalated. (A failed read is distinguished from an empty collection.) |
| No active articles | `kbStatus: not_covered`, `escalationRequired: true`, model text discarded, escalated. Not an `intakeIssue`. |
| Priority/category not one of the known values | Normalised by case/spacing only; otherwise NOT stored and `intakeIssue: classification_invalid`; escalated. `critical`, `normal`, `P1` are not mapped. |
| `kbStatus: not_covered` | Steps forced to `[]`, `escalationRequired` forced `true`; escalated. |
| `escalationRequired: true` | Escalated, even for Low/Medium. |
| High / Urgent | Always escalated (case-insensitive, so `high` is no longer missed). |

**Escalated = staff email only; the customer gets nothing until an agent approves a reply in the dashboard.** The
customer acknowledgement is sent only when: Low/Medium, `kbStatus` covered/partially_covered, `escalationRequired`
false, no `intakeIssue`, and a response exists.

The dashboard uses the same rule (`approvalRequired` in `src/lib/overview.ts`, applied to the whole ticket, no priority
aliases) and a test runs both over every priority x evaluation x article-count combination to keep them equal.
New ticket field: `intakeIssue` (string, only on failed/invalid intake). Existing tickets are unaffected, except that a
legacy Low/Medium ticket stored with `kbStatus: not_covered` or `escalationRequired: true` now counts as needing review.

## Public intake validation and abuse protection (phase 4B)

**Implemented (enforced inside the workflow).** `Form Trigger -> Validate submission -> Is submission valid`. Only the
"valid" output continues to Gemini, Firestore and Gmail; the other output ends at `Rejected submission (stop)`.
Checked in the Code node, so posting straight to the form URL does not bypass it:

| Field | Rule |
|---|---|
| Name | required, text, max 100 chars, whitespace collapsed, no control characters/line breaks |
| Email | required, text, max 254, one `@`, dotted domain, no spaces or `, ; < > ( ) " \`, no `..`, no line breaks (header injection), local part max 64 |
| Message | required, text, non-empty after trimming, **max 5,000 characters** (after trimming), control characters stripped, line breaks kept |

A rejected item carries only `{field, code}` errors, never the submitted text. Valid values leave the node trimmed under
the original field labels, and every later node (prompts, `Build ticket`) reads them from `Validate submission`, not from
the raw form. The three form fields are also marked required in the Form Trigger: that is browser-side only (UX), not security.

**Limitation: the submitter is not told.** The Form Trigger answers with its completion page as soon as the form is
posted, before the workflow runs, so a rejected visitor sees "submitted" and nothing is created or emailed. Telling them
requires the Form Trigger's "respond when last node finishes" mode plus a Form ending page; that changes the normal
visitor experience and wasn't verified, so it is left out. The browser-side `required`/email checks still stop honest mistakes.

**NOT protected (no rate limiting, no bot protection is implemented).**
- The Form Trigger has no rate limit, CAPTCHA or honeypot setting, and cannot host a CAPTCHA widget. An in-memory
  counter in a Code node would reset on restarts and doesn't span executions, so none was added.
- A bot posting *valid-looking* submissions still creates tickets and Gemini calls, and (for Low/Medium covered issues)
  sends an acknowledgement email to whatever address it typed. Validation only stops malformed input.
- Execution data for rejected submissions is still stored by n8n like any other execution.

**Smallest practical options, in order (none are done):**
1. **Rate-limit the form URL at the edge.** If n8n is self-hosted, put it behind Cloudflare (or your reverse proxy) with a
   rate-limiting rule on the form path, e.g. a handful of POSTs per IP per minute. No code and no new dependency. n8n Cloud
   gives no such control.
2. **If you need a real CAPTCHA:** replace the Form Trigger with a small public form page that posts to an n8n Webhook,
   verify the Cloudflare Turnstile / reCAPTCHA token server-side in the first node, then run `Validate submission`. This
   is a new public page, so do it only if option 1 isn't enough.
3. **Cap spend:** set a budget/quota on the Gemini API key so abuse can't run up cost.

## Reliability layer (retries, duplicates, rescue emails)

All of this is in `n8n/ai-support-desk-automation.json`. The Gemini prompts, classification, KB evaluation, routing, dashboard and the
Send Response workflow are unchanged. High/Urgent tickets still go to staff only, with no automatic customer acknowledgement.

| Area | Behaviour |
|---|---|
| Gemini | Both nodes retry 3 times (3 s apart). If it still fails, the existing manual-handling ticket (`intakeIssue`) is created and escalated. |
| Ticket ID | `Build ticket` computes `tk_<32 hex>` = SHA-256 of lower-cased email + whitespace-normalised message + clock hour (pure JS: the Code node allows no `crypto` by default). Same submission in the same hour = same ID. Used as the Firestore document ID. Name is not part of the identity. |
| `intakeExecutionId` | **New ticket field** (the n8n execution that built the ticket). Additive: the dashboard allowlist ignores it. Used only to tell "my own earlier write" from "someone else's". |
| Create failure | `Create a document` retries 3 times (2 s apart), then its error output runs `Classify create error`. **Not a conflict:** `Prepare rescue email` -> `Send rescue email` (no customer email, no ticket). **Conflict (document exists):** `Get existing ticket` -> `Check existing ticket`: same `intakeExecutionId` = our own earlier write whose reply was lost, so continue to the normal emails; different = a duplicate submission, stop quietly (`Duplicate submission (stop)`, nothing sent); unreadable = rescue email "status unclear". |
| Notification emails | The acknowledgement and escalation Gmail nodes retry twice (2 s apart). If they still fail, the error output sends a rescue email to staff (the ticket is already saved). A retry after a lost reply can send a duplicate notification; that was chosen over silently sending none. |
| Rescue email | Escaped submission (name, email, message), ticket ID, priority, shortened error text (max 300 chars), n8n execution ID, and what to do. Subject says which failure happened. Goes to the **same inbox as escalations**. |
| Attribution | n8n's "sent automatically with n8n" line is turned off on all three Gmail nodes. |

**You must set the staff inbox in TWO places:** `Send a message` (escalation) and `Send rescue email`. Both ship with
`REPLACE_WITH_ESCALATION_INBOX@example.com`; a test asserts they are equal in the JSON, so don't change just one.

### Known limits of the duplicate protection
- The window is a clock hour: a repeat that straddles the hour boundary can create a second ticket. A genuinely new message always gets a new ID.
- An identical message from the same address in the same hour is treated as a duplicate and dropped silently (a stop node, no email, no ticket).
- A duplicate is only recognised if the first run's write succeeded. If the first run died before writing, the second run creates the ticket (correct).

### Immediate acknowledgement: **NOT solved, and n8n can't solve it cleanly here**
With the Form Trigger's default "respond when the form is submitted", the visitor sees the confirmation **before** the ticket is saved, so
a Firestore outage still shows them "submitted". Retries and the rescue email reduce the chance and make sure staff see the request, but they
do not make the confirmation truthful. What I found in the n8n 2.47.7 source (read, not run):
- A "Respond to Webhook" node is **rejected** in workflows started by Form Trigger v2.2+ (error: not supported; use a Form node).
- The only supported early response is an n8n **Form node, Page Type "Form Ending"**. It pauses the execution and relies on the visitor's browser
  posting back to resume it, so Gemini, the ticket save and the emails would depend on the visitor keeping the page open. Not built.
- What the form says now: "Your request has been submitted and is now being processed...", which no longer claims it was recorded.

Safest practical alternatives (neither is implemented; pick one):
1. **Truthful but slower:** on the Form Trigger set *Respond When* to **Workflow Finishes**. The visitor waits for both Gemini calls (with retries) and
   a Firestore/Gmail failure surfaces as an error page instead of "submitted". Deterministic IDs make a resubmission after such an error safe.
   Expect a wait of several seconds up to roughly a minute if Gemini is retrying (not measured).
2. **Fast and truthful (bigger change):** split into a small front-door workflow (validate, save a minimal manual-handling ticket under the
   deterministic ID, then answer) and a second workflow for Gemini/emails that updates the ticket. The Firestore node's `upsert` writes only the listed
   columns (it uses a masked batch write), so it can fill in a saved ticket. Note that batch writes report per-write failures inside the response rather
   than throwing, so a design like this must check each write's `status`.

## What is verified and what is not (reliability layer)

**Automated (Node, mocks), `tests/intake-reliability.test.ts` and `tests/workflow.test.ts`:** SHA-256 matches Node's `crypto`; ID stability and
sensitivity; graph reachability (no email unless the ticket was written or proven to be this run's own); create-error classification; simulated
failure paths built from the real Code-node sources (Firestore failure, simultaneous duplicates, lost reply, unreadable conflict, ack/escalation
failure, High/Urgent routing, rescue-email escaping).

**Stubbed local n8n 2.47.7 (not your instance; Gemini, Firestore and Gmail replaced by stub nodes, nothing activated, nothing sent):** the workflow imports;
the Code nodes (including the SHA-256 and `$execution.id`) run in n8n's real Code sandbox; Create/Gmail failure branches, duplicate stop, own-write recovery,
unclear conflict and notification-failure rescue took the expected paths (`isExecuted` works in the real sandbox); retries really repeat the node
(Create failing 3 times -> rescue; failing twice then succeeding -> normal path; Gemini failing twice then succeeding -> normal ticket; Gemini always failing ->
manual-handling ticket).

**NOT verified (needs your n8n):** real Firestore error shapes (the conflict detection relies on "already exists" or HTTP 409 in the error; the real text is
unconfirmed), real Gmail failures, real Gemini 429/503 behaviour, the Form Trigger response, whether retries multiply wait time as expected,
and that `Create a document` with `onError: continueErrorOutput` exposes the error on output 2 in your version (it did in 2.47.7).

### Manual test checklist (use a test Firestore project/collection and a mailbox you own)
1. Import into a **non-production** n8n, attach credentials, set the staff inbox in both Gmail nodes (above). Do not activate until step 2 passes.
2. Submit a valid Low-priority covered question: one ticket `tk_...`, one acknowledgement, no rescue email.
3. Submit the identical form again within the hour: no second ticket, no emails; the execution ends at `Duplicate submission (stop)`.
4. Submit the same text from a different address, and a different message from the same address: each creates its own ticket.
5. Submit a High issue: one ticket, escalation email to staff, **no** customer email.
6. Temporarily break the Firestore credential: expect the rescue email "Ticket NOT saved" with the full submission and no customer email. Restore it.
7. Temporarily set the escalation inbox invalid / break Gmail: expect the ticket saved and a rescue email (or an execution error if the rescue also cannot send).
8. Make Gemini fail (bad key): ticket with `intakeIssue`, escalated, plus the escalation email.
9. Check a created ticket in Firestore: `intakeExecutionId` present, `escalatedAt` null for Low (written as null by the Create node), dashboard shows it normally.
10. Confirm the dashboard approves and sends a reply for an intake-created High ticket through the Send Response workflow (this workflow does not touch that path).

## What is verified and what is not

Verified by `npm test` (runs the Code-node sources in plain Node with a stand-in for n8n's `$`):
N articles -> one item; inactive filtered; metadata kept; empty KB still yields an item; exactly one ticket per
submission; routing fields; fenced/invalid model JSON handling; graph has one Create and no upserts; no
expression refers to a removed node; embedded code equals `n8n/code/*.js`; every `$json.safe.*` used by the
email templates exists; HTML is escaped.

**Not verified (needs a test run in n8n):**
- The JSON imports cleanly into your n8n version, and node typeVersions match your instance.
- The Gemini node output shape (`content.parts[0].text`) is unchanged (copied from the export).
- The Firestore `create` node accepts the extended `columns` list, **and omits `escalatedAt` for Low/Medium
  tickets** (it is absent from the item; confirm the document has no `escalatedAt` field of the wrong type).
- The Create node's output carries `_id` and the stored fields so the email expressions resolve.
- Gmail sends HTML as before and the escaped text renders correctly.
- That "continue on error" on the Gemini and Firestore nodes delivers an item with an `error` field in your n8n version (the code treats a missing/invalid `content.parts[0].text` as a failure either way).
- Omitted fields: reading the n8n 2.x Firestore node source (not running it) shows the Create node writes a listed column that is missing from the item as `null`, not as an absent field. The dashboard only checks `intakeIssue` as a non-empty string and `escalatedAt`/`priority` leniently, so null is expected to be harmless, but confirm in a test run.
- That the Form Trigger passes `requiredField` and the form values under the same labels as before, and that the new Code/If/NoOp nodes import in your version.
- Behaviour with a very large knowledge base (all active articles go into one prompt: watch the token limit).

## Suggested first test
Submit one Low and one Urgent form with the escalation address set to yourself and the acknowledgement
recipient temporarily set to yourself. Confirm: exactly ONE `support_tickets` document each; Urgent has
`escalationStatus: "required"` and an `escalatedAt`; Low has neither `escalatedAt` nor a second document;
the right email arrives once.
