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
