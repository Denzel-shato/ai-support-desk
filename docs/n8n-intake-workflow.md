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

**Visitors are now told (rate-limit change, see "Rate limiting" below):** the Form Trigger is v2.1 with a Respond to Webhook node, so an
invalid or rate-limited visitor gets a specific polite message instead of "submitted". The browser-side `required`/email checks still stop honest mistakes.

**Still NOT protected: bot protection.** There is no CAPTCHA or honeypot, and a bot posting valid-looking submissions *within the limits* still creates
tickets, Gemini calls and (Low/Medium) acknowledgement emails. Execution data for rejected submissions is stored by n8n like any other execution.

**Further options (none done):**
1. **Rate-limit the form URL at the edge.** If n8n is self-hosted, put it behind Cloudflare (or your reverse proxy) with a
   rate-limiting rule on the form path, e.g. a handful of POSTs per IP per minute. No code and no new dependency. n8n Cloud
   gives no such control.
2. **If you need a real CAPTCHA:** replace the Form Trigger with a small public form page that posts to an n8n Webhook,
   verify the Cloudflare Turnstile / reCAPTCHA token server-side in the first node, then run `Validate submission`. This
   is a new public page, so do it only if option 1 isn't enough.
3. **Cap spend:** set a budget/quota on the Gemini API key so abuse can't run up cost.

## Automatic customer replies: grounding (audit finding B1)

**Threat.** The customer's message, name and address are untrusted. Before this change a Low/Medium ticket was emailed whatever the model wrote whenever the model's own JSON said `covered` and `escalationRequired: false`, so a prompt-injected model could make the company mailbox send attacker-chosen text, links or instructions to any address.

**What now decides whether an automatic email is sent** (deterministic code, not the model):

1. Priority is exactly Low or Medium, no `intakeIssue`, evaluation complete, `kbStatus` is `covered`, `escalationRequired` is false and `unsupportedParts` is empty.
2. The cited article exists among the **active** articles: by exact `relevantArticleId` (title must agree if given), or by a unique exact title when no ID is given. Unknown, mismatched, ambiguous or non-string references are refused.
3. Every `supportedSteps` entry is located inside that article (normalised, whole-word, and the step must cover at least half of the matching article sentence/line; 12+ characters). The email uses the **article's sentence**, not the model's wording. Paraphrases, merged steps and invented steps fail.
4. None of the sentences or the title contains a URL, domain, e-mail address, `@`, Markdown link, control or bidirectional characters. A staff-written article that contains a link therefore always goes to a human.
5. The email text is a fixed template (`GROUNDING.render`): intro line, `Article: <title>`, numbered article sentences, fixed disclaimer. The greeting uses only a plain Name-Case first name, otherwise just "Hello,". Subject and surrounding text are fixed.

`Prepare email fields` repeats steps 1-5 from the stored ticket and the article text, and sets `escalationStatus: required` if anything fails, so a bug in `Build ticket` still cannot cause an automatic send. The customer email node cannot print `customerResponse` at all.

**On any failure** the ticket is stored with the untouched submission, `escalationRequired: true`, `escalationStatus: required`, `groundingIssue: <code>`, an escalation reason, an empty `supportedSteps`, and the model's prose kept as a draft the agent may edit and send through the unchanged approval/Send Response flow. Codes: `not_fully_covered`, `unsupported_parts_remain`, `article_not_cited`, `article_not_found`, `article_mismatch`, `ambiguous_article`, `unsafe_title`, `no_steps`, `step_not_in_article`, `unsafe_text`.

**Residual risks (not solved).**
- A model can still be steered into choosing a *different real article* or real steps for the wrong problem. The customer then receives genuine, staff-written guidance that may not fit, and nobody reviews it. Only wording, not relevance, is verified.
- The recipient address is still unverified: anyone can make the system send a (safe, template) email to a third party. Rate limits bound the volume; email-ownership confirmation would be the real fix.
- The greeting still contains up to 30 submitter-chosen letters (e.g. "Hello Winner,").
- Human-reviewed drafts still contain model prose; an agent must read them before approving. The staff escalation email and dashboard show attacker-controlled text (HTML-escaped).
- An article written by staff is trusted. Anyone who can edit the knowledge base can change what is sent.
- Prompt injection can still corrupt classification (priority, category) and summaries; a wrongly Low priority only affects whether the grounded template is sent.
- Verified only by tests that run the Code nodes in Node. The n8n Firestore node's returned types (booleans, arrays) and `$('Select active articles')` access must be confirmed in a real n8n run: the second gate fails closed (everything goes to staff) if they differ.

## Rate limiting

### What the Form Trigger gives us (inspected in n8n 2.47.7)
- Request **headers** are available only when the Form Trigger option `showHeaders` is on. There is **no socket/remote IP** in the payload.
- Headers are client-controllable unless your own reverse proxy/CDN appends them. So the limiter trusts only the entry written by *your* proxy:
  the Nth entry from the **right** of `X-Forwarded-For` (`ipSource.trustedProxyHops`, default 1). Left-hand entries are ignored, so a spoofed leading
  value cannot dodge the limit. Fewer entries than hops, private/loopback/link-local/CGNAT or unparsable addresses mean "unknown source".
  If n8n is exposed directly (no proxy that sets the header), **IP limiting is not reliable**; the unknown bucket and email/global limits are the fallback.
- To be able to answer visitors, the Form Trigger is now **v2.1 with `responseMode: responseNode`** (v2.2+ rejects Respond to Webhook) and an explicit `path`.

### Design
`Form Trigger -> Rate limit settings -> Validate submission -> (valid) Prepare rate limit -> Plan claim -> Claim slot -> Evaluate claim -> ...`
- **Slot claims in Firestore.** Per check and fixed window there are N slot documents `rl_<kind>_<hashedkey>_<windowId>_<slot>`. A submission creates the
  first free slot with Firestore `create` (atomic, fails with 409 if the document exists). Winning `limit` slots = allowed. Two concurrent submissions
  cannot both take the same slot, so the limit cannot be exceeded by racing (read-then-write counters can).
- **Checks, in order:** global flood cap, IP (or shared "unknown" bucket), normalised email. Email is never the only check.
- **Normalised email:** lower-case, `+tag` removed, Gmail/googlemail dots removed. Other domains keep dots.
- **Outcomes:** granted -> `Respond to form (accepted)` (the unchanged "submitted and is now being processed" text) -> Gemini etc. exactly as before.
  Limited -> polite "several requests, try again later" and the run **ends** (no Gemini, KB, ticket, escalation or customer email). Limiter unavailable -> see below.
- **All numbers and messages live in `Rate limit settings`** (one node). Values are clamped (limit 1-20, window 10-86400 s).

### Chosen initial limits (please tune)
| Check | Limit | Window | Why |
|---|---|---|---|
| Global | 20 | 60 s | Flood/cost cap for the whole form; far above a small team's real traffic |
| IP | 10 | 1 h | Allows a shared office/NAT several genuine requests |
| Unknown source | 20 | 1 h | One shared bucket when no trusted IP; deliberately looser so honest users behind a missing header are not locked out |
| Email | 3 | 1 h | A real customer rarely needs more; stops one address being used to mail-bomb or probe |
These are judgement calls, not measured traffic.

### Limiter failure decision: **fail closed** (`failMode: 'closed'`)
If the claim store errors (after 2 immediate retries per slot) the visitor is told to try again shortly, nothing is processed, and a **staff rescue email**
(kind "Spam check unavailable", with the escaped submission) goes to the same inbox as escalations, so a legitimate request is not lost. Reason: failing open
would silently remove abuse protection exactly when Firestore is struggling. Set `failMode: 'open'` to accept instead (marked `degraded`). Limiter failures use a
separate route/message/rescue kind, so they are distinguishable from Gemini, ticket-save and email failures.

### Privacy and retention
Only salted SHA-256 hashes of IP and email appear in the document id; documents hold `kind, slot, createdAt, expireAt`. Replace the placeholder `salt`.
Each document expires `window + retentionGraceSeconds` after window end. Correctness never depends on deletion (the window is in the id). Enable a Firestore **TTL
policy** on collection group `rate_limits`, field `expireAt`, to delete them (deletion is typically within about a day).
n8n execution data will still contain request headers (including the IP) for as long as your execution retention keeps it.

### Retries and duplicates
A legitimate retry after a rejection works once the window rolls over; a rejection claims no email slot, so it does not extend the block. It does consume a
global and IP slot. A double-click consumes two email slots. The deterministic ticket ID still stops duplicate tickets.

### Trade-offs
Fixed windows allow up to ~2x the limit across a boundary. Cost is O(limit) Firestore writes per check. Spam can use up the global bucket (cheap denial of
service for the form), which is why it is generous. A limiter outage with fail-closed can produce many rescue emails.

### What was verified
- **Node tests (`tests/rate-limit.test.ts`)**: the real Code-node sources with a fake store whose create is atomic: all nine scenarios (within limit, over limit,
  window expiry, rapid same-source, 300 random interleavings of concurrent submissions, different customers, missing IP, store failure, retry after rejection),
  IP parsing, normalisation, hashing-only storage, expiry, config clamping, and graph assertions that Gemini/ticket/email nodes are reachable only through a granted claim.
- **Real n8n 2.47.7 sandbox (own throwaway instance, stubbed Gemini/Firestore/Gmail, real HTTP form posts):** loop wiring, error-output handling, header parsing,
  limited/allowed/unavailable routing (closed and open), window rollover, and that rejected paths create no ticket or email. This is not your n8n.
- **NOT verified:** real Firestore atomicity and concurrency (taken from the API's documented create semantics, not run), your reverse-proxy headers, the form's look in a
  real browser (only HTTP responses were checked), live Gemini/Gmail, TTL deletion, and the public URL change (v2.1 serves `/form/support-request` once n8n assigns a webhookId on import).

### Manual steps
1. Set a real random `salt` in `Rate limit settings`.
2. Confirm your proxy sets `X-Forwarded-For` (or switch `ipSource.header`, e.g. `cf-connecting-ip`, hops 1) and that clients cannot inject the last entry.
3. Create the Firestore TTL policy on `rate_limits.expireAt`; the service account used by n8n needs create rights (it bypasses rules; the dashboard doesn't use this collection).
4. Set the staff inbox on the rescue email node as for escalations; confirm the credential on `Claim slot`.
5. Import into a **test** n8n and Firestore project, submit from a real browser, check the three messages render, then exceed each limit and test a simultaneous burst.

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

### Immediate acknowledgement: **NOT solved (still true for the accepted path), and n8n can't solve it cleanly here**
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
