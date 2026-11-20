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
2. **Escalation recipient** is no longer stored in the Gmail nodes. It is set in the `Deployment config` node (placeholder `REPLACE_WITH_ESCALATION_INBOX@example.com`, refused until replaced). See [n8n-deployment-config.md](n8n-deployment-config.md).
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

## Gemini models (audit finding B10)

**Checked against Google's official pages on 2026-11-19** ([models](https://ai.google.dev/gemini-api/docs/models), [deprecations](https://ai.google.dev/gemini-api/docs/deprecations)). The deprecations page lists the **earliest** possible shutdown date; Google says the exact date is announced with notice.

| Node | Was | Status per Google | Now |
|---|---|---|---|
| `Message a model1` (evaluation) | `gemini-3-flash-preview` | **Preview**; on the deprecations page with no shutdown date yet and `gemini-3.6-flash` as the recommended replacement | `gemini-3.6-flash` (**Stable**, no shutdown date announced; Google's own named replacement) |
| `Message a model` (classification) | `gemini-3.1-flash-lite` | **Stable**, but deprecated: earliest shutdown **2027-05-07**, recommended replacement `gemini-3.5-flash-lite` | **unchanged** |

**Why this model and not "the newest".** `gemini-3.6-flash` was chosen because it is stable *and* the replacement Google names for the exact model we used, not because of its version number. A newer stable Flash exists (`gemini-3.8-flash`); it was not chosen. Google also lists some endpoints (for example `gemini-3.5-flash`, `gemini-3.7-flash`) that **automatically route to a newer model**: never put an alias like that, or `-latest`, in this workflow, because the behaviour behind it can change without notice. Even a pinned stable id can be retired, which is why the dates above matter.

**Why classification was not changed now.** It is stable and has at least until 2027-05-07. It decides `priority`, which decides High/Urgent escalation, so swapping it without a live comparison would change safety-relevant behaviour for no current benefit. Plan the move to `gemini-3.5-flash-lite` (or whatever Google then names) well before that date, with the smoke test below. A test (`B10: DEADLINE TRIPWIRE`) **fails once the date has passed** so this cannot be forgotten; it tells you which page to re-read.

**What was verified about the integration** (n8n 2.47.7 source, `GoogleGemini` node): the model is addressed as `models/<id>`; with the default "simplify" output each candidate is one item with `content.parts`; no `responseMimeType` is sent unless "Output content as JSON" is enabled (it is not; JSON is requested in the prompt and parsed and validated by `Build ticket`), and no thinking setting is sent unless you set one. **Compatibility change made:** `Build ticket` used to read only `parts[0].text`. It now joins every plain text part and ignores reasoning ("thought") parts, so a model that splits its answer or puts a non-text part first still parses; anything that does not parse fails safe to human review exactly as before. The prompts, output schemas and the B1 grounding are unchanged.

**Required n8n configuration:** after import, re-select your Gemini credential on both nodes, then open `Message a model1` and confirm the model list shows **Gemini 3.6 Flash** for your API key (the list comes from Google's API; availability can depend on key and region). If it does not appear, choose "By ID" and enter `models/gemini-3.6-flash`. If the model is unavailable the node's error output is not used (`continueRegularOutput`), the evaluation is recorded as failed, and the ticket goes to a human: nothing is lost, but **every** ticket would then need review, so check this before going live.

**Live smoke test (do this in your test n8n, with Gmail stubbed or pointed at a mailbox you own).** Send at least 10 realistic submissions: clearly covered by a knowledge-base article, partially covered, not covered, urgent, and several that try to inject instructions. Check for each: classification is valid JSON with a sensible `priority`; `intakeIssue` is empty (no `classification_failed`, `evaluation_failed`, `evaluation_invalid`); covered ones cite a real `relevantArticleId` with word-for-word steps and are auto-replied (`groundingIssue` empty) while the rest are held for a human; compare the share auto-replied with what you expect. Record the model id, the date and the results.

Not verified: any live Gemini behaviour, answer quality or priority accuracy of `gemini-3.6-flash` on these prompts, its price, quota or latency, and its availability for your account and region. A stable model id existing in Google's documentation is not evidence that it is enabled for your key.

## Failure alerting and execution data (audit finding B8)

Code nodes that can fail after the visitor is told "submitted" now have error outputs into the rescue email; a failure-alert workflow reports anything unhandled; execution-data
settings are explicit. The manual setup, the retention trade-off (successful executions must be kept because of B5), backup and recovery are in
[n8n-failure-alerts.md](n8n-failure-alerts.md).

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
- **Checks, in order (B4):** IP (or shared "unknown" bucket), normalised email, and the global flood cap **last**. Email is never the only check. See "Claim order and release (B4)" below.
- **Normalised email:** lower-case, `+tag` removed, Gmail/googlemail dots removed. Other domains keep dots.
- **Outcomes:** granted -> `Respond to form (accepted)` (the unchanged "submitted and is now being processed" text) -> Gemini etc. exactly as before.
  Limited -> polite "several requests, try again later" and the run **ends** (no Gemini, KB, ticket, escalation or customer email). Limiter unavailable -> see below.
- **All numbers and messages live in `Rate limit settings`** (one node); the salt and staff inbox live in `Deployment config`. Values are clamped (limit 1-20, window 10-86400 s).

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

### Claim order and release (B4)
**Problem:** the global slot used to be claimed first, so a submission later refused by the IP or email limit had already used global capacity; an attacker repeating one email could starve everyone else.

**Algorithm** (`Prepare rate limit`, `Evaluate claim`, `Plan release`, `Read claim`, `Check owner`, `Release slot`):
1. Each submission gets a random `claimId` (hash of salt, time, execution id and random values). Every slot document it creates stores it.
2. Checks are claimed narrow first: IP (or unknown bucket), email, then **global last**. Every slot created is recorded in `rl.held`.
3. If a check refuses (or the store fails), the visitor is answered first, then each held slot is released: **read the slot, delete it only if its stored `claimId` is this submission's**. The Firestore node's delete has no precondition and succeeds on missing documents, so the ownership read is what stops a request from ever releasing another request's slot.
4. The global slot is claimed last, so a request that wins it is allowed and never needs to release it. A request refused by global releases its IP and email slots.
5. Claiming is still the atomic Firestore `create`; no check-then-write. Numbers, windows and messages are unchanged; `retentionGraceSeconds` is now clamped to at least 300 s so a slot cannot expire while being released.

**Failure behaviour:** a failed or skipped release (store error, ownership mismatch) leaves the slot taken until its window ends, i.e. stricter, never looser. Store failure mid-way still fails closed (and releases what it can). An ambiguous create (error, then 409 on retry) can leak one unrecorded own slot, also in the safe direction.

**Known trade-offs:** (a) a burst can make a request see "limited" while refused requests still hold narrow slots for a moment (transient over-counting; clears on release/window end); (b) refused requests cost extra Firestore reads/deletes (1 read + 1 delete per held slot, normally 1-2); (c) fixed-window edge effects are unchanged.

### Rescue-email flood protection (B5)
**Problem:** with the limiter store down and fail-closed, every public submission produced a staff rescue email.

**Algorithm** (`Plan rescue slot`, `Claim rescue slot`, `Evaluate rescue slot`, `Build held record`, `Record held submission`):
- Applies **only** to `rate_limit_unavailable` rescue emails, i.e. submissions that were refused (the visitor was told to retry). Rescue emails for already accepted tickets (ticket not saved, unclear, acknowledgement or escalation failed) are never throttled.
- Per window (`rescue` in `Rate limit settings`: `maxEmails` 3, `windowSeconds` 3600, `heldRetentionSeconds` 30 days) the same atomic slot `create` is used (`rs_limiter_<window>_<slot>` in `rate_limits`). Slots 1-3: the normal detailed rescue email. Slot 4: **one** notice email ("rate limiter unavailable, further submissions suppressed", no customer data). Beyond that: no email; a best-effort `held_<executionId>_<window>` document with identifiers only (kind, reason, executionId, createdAt, expireAt; no name, email or message). The n8n execution still holds the submission, so nothing is lost, and the visitor sees the same refusal text as before.
- If the throttle store fails (2 retries) a per-instance fallback counter in workflow static data applies the same cap (not atomic across simultaneous executions; persisted only for production executions). If neither works the email is **sent** (degraded): losing the outage signal is worse than an extra email.
- **Email failures are explicit now:** `Send rescue email` has an error output -> `Rescue email failed` -> `Record failed notification` (held document `held_<exec>_email_failed`, no customer data) -> `Rescue email not sent` (Stop and Error, so the execution shows as failed). A failed send does not refund its throttle slot.
- Residual: execution data (including suppressed submissions' text) is kept only as long as your n8n execution retention; the allowance is per window, so a long outage is announced again each hour; consider an n8n **error workflow** to alert on "Rescue email not sent".
- Config keys, clamped: `maxEmails` 1-10, `windowSeconds` and `heldRetentionSeconds` bounded. Enable the TTL policy on `rate_limits.expireAt` (covers `rl_`, `rs_limiter_` and `held_` documents).

### Privacy and retention
Only salted SHA-256 hashes of IP and email appear in the document id; documents hold `kind, slot, createdAt, expireAt`. The salt is set in `Deployment config`, not here; a placeholder or weak salt stops the run (see [n8n-deployment-config.md](n8n-deployment-config.md)).
Each document expires `window + retentionGraceSeconds` after window end. Correctness never depends on deletion (the window is in the id). Enable a Firestore **TTL
policy** on collection group `rate_limits`, field `expireAt`, to delete them (deletion is typically within about a day).
n8n execution data will still contain request headers (including the IP) for as long as your execution retention keeps it.

### Firestore TTL (audit finding B6)

**Finding: disproven at the code level, not verified live.** The audit asked whether `expireAt` could be stored as an ISO *string* (which TTL ignores). The n8n 2.47.7 Firestore node converts every string that is strict ISO-8601 (and contains `-`, `T` or `:`) into a Firestore **Timestamp** (`jsonToDocument` in the node's `GenericFunctions.ts`). Every `expireAt` this workflow writes is a canonical UTC string such as `2026-11-19T11:15:00.000Z`, so by that code it is stored as a Timestamp. **That is a reading of n8n's source, not an observation of your database.**

Every workflow node that writes to `rate_limits` (all four set `expireAt`; a test fails if a fifth appears without one):

| Node | Document id | Written fields |
|---|---|---|
| `Claim slot` | `rl_<kind>_<hash>_<window>_<slot>` | `kind, slot, createdAt, expireAt, claimId` |
| `Claim rescue slot` | `rs_limiter_<window>_<slot>` | `kind, slot, createdAt, expireAt` |
| `Record held submission` | `held_<execution>_<window>` | `kind, reason, executionId, createdAt, expireAt` |
| `Record failed notification` | `held_<execution>_email_failed` | `kind, reason, executionId, createdAt, expireAt` |

A column the Code node forgets to produce is written by the node as `null`, which silently disables TTL for that document; the tests check that every column of every writer is produced. Tests also check the format, that each expiry is in the future and after `createdAt`, that limiter slots outlive their window by at least 5 minutes (B4), and that held records last the configured `heldRetentionSeconds` (default 30 days). They use a port of the node's serialisation, not the real node.

**The exact TTL policy to create** (collection group and field must match; the field must hold Timestamps, anything else is ignored by TTL):

```
gcloud firestore fields ttls update expireAt --collection-group=rate_limits --enable-ttl
gcloud firestore fields ttls list --collection-group=rate_limits
```

or in the Firebase/Google Cloud console: Firestore → Time-to-live → create a policy for collection group `rate_limits`, field `expireAt`. You need permission to manage indexes. Google documents deletion as typically within about a day after expiry, not instantly. This covers the `rl_`, `rs_limiter_` and `held_` documents. Correctness never depends on deletion (the window is in the id); TTL is storage and privacy hygiene.

**Check the real thing** (read-only; needs the same `FIREBASE_*` variables the dashboard uses; run it after at least one test submission):

```
npm run ttl:check
```

It samples up to 300 `rate_limits` documents and reports the type of `expireAt` (Timestamp, string, number or missing) and how many documents are more than 48 hours past expiry but still present. It prints no document ids, hashes or credentials and changes nothing. It cannot prove a policy exists; use the `list` command for that. Exit code 0 means every sampled value is a Timestamp and nothing is overdue.

Not verified: that a TTL policy exists in your project, the actual stored type in your database, and that deletion happens.

### Trusted proxy and client IP (audit finding B9)

**What the code trusts.** Only the header named in `ipSource.header` (default `x-forwarded-for`), and in it only **the entry `trustedProxyHops` from the right** (default `1`: the last entry). Entries further left are client-supplied and ignored. If the header has fewer entries than `trustedProxyHops`, or more than 20 entries, or is longer than 512 characters, nothing in it is trusted. The IP is hashed with the salt before storage and never stored or echoed.

**The hop count was not guessed or changed.** `trustedProxyHops` must equal the number of proxies **you control** between the internet and n8n that each append the connecting address. It cannot be derived from the code; it depends on your hosting. Examples (illustrative, not your topology): with one reverse proxy appending to `X-Forwarded-For`, use `1`. With a CDN in front of your own proxy, the CDN's address is the last entry and the client the second-last, so you need `2`; with `1` every visitor would be seen as the CDN. If the value is too large, everyone falls into the shared `unknown` bucket (`unknownIp`: 20 per hour for the whole site); too small, everyone behind one proxy shares one bucket. A single-value header written by your edge (for example `cf-connecting-ip`) can be used instead, **only** if n8n accepts traffic from that edge and nothing else.

**n8n's own `N8N_PROXY_HOPS`** (Express "trust proxy") is a separate setting. It affects how n8n itself interprets forwarded headers; this workflow reads the raw header in a Code node and does not use it. Keep it consistent with your topology, but it does not replace `trustedProxyHops`. Whether n8n leaves the `headers` object the Form Trigger exposes untouched was not verified: check it with the procedure below.

#### Direct access to n8n

If a client can reach n8n without passing through your proxy, it writes the whole header itself and can choose any "client IP" per request, which defeats the per-IP limit (a test demonstrates this and is named `KNOWN LIMITATION`). The global limit and the per-email limit still apply. The code cannot detect it; only the network setup can prevent it. Requirements: n8n listens only on a private interface or localhost, or a firewall/security group/private network allows connections to its port **only from your proxy**, or you use a tunnel that opens no public port; the proxy **appends** the real connecting address to `X-Forwarded-For` (for example nginx `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`) rather than trusting what the client sent; and the form's public URL goes only through that proxy.

**How malformed or unusual values are handled** (tested): ports (`1.2.3.4:5678`, `[2001:db8::1]:443`), brackets, leading zeros and IPv4-mapped IPv6 (`::ffff:1.2.3.4`, also `::ffff:102:304`) are normalised to the same client; IPv6 is counted per /64. Private, loopback, link-local, carrier-grade NAT, multicast, reserved, unspecified and unique-local addresses, IPv4-compatible `::a.b.c.d`, zone ids, garbage, empty values and non-string header values are **not trusted** and count in the shared `unknown` bucket. Missing header or no `headers` object: also `unknown`.

**Live verification procedure (for the later integration test; none of it has been done).** In a test n8n behind the real proxy topology:
1. Open the form's **test** URL so the Form Trigger shows its output in the editor (test runs are not stored with the export's settings). Submit from a network whose public address you know. Read `headers['x-forwarded-for']`: the entry at position `trustedProxyHops` from the right must be your real public address. Count entries to set the number.
2. Repeat with a forged header: `curl -H 'X-Forwarded-For: 203.0.113.50' ...` through the public URL. Your real address must still be the one at that position (the forgery sits to its left).
3. From a machine outside your proxy, try to reach n8n's port directly (by its server address). It must fail.
4. After a normal submission, open `Prepare rate limit`'s output: `rl.sourceKnown` must be `true` and the `ip` check present. Submit from a second network: the `ip` check's `key` must differ; from the same network again: it must match.
5. If `sourceKnown` is `false` for real visitors, the hop count or header name is wrong.

Not verified: your proxy topology, the real header contents, whether n8n is reachable directly, and n8n's header handling. These need your hosting.

### Retries and duplicates
A legitimate retry after a rejection works once the window rolls over; a rejection claims no email slot, so it does not extend the block, and (B4) a refused submission
consumes **no global capacity**; its IP slot is given back. A double-click consumes two email slots. The deterministic ticket ID still stops duplicate tickets.

### Trade-offs
Fixed windows allow up to ~2x the limit across a boundary. Cost is O(limit) Firestore writes per check. Accepted spam can still use up the global bucket (cheap denial of
service for the form), which is why it is generous; submissions refused by the IP/email limits no longer count towards it. A limiter outage with fail-closed no longer floods the
inbox (see "Rescue-email flood protection (B5)").

### What was verified
- **Node tests (`tests/rate-limit.test.ts`)**: the real Code-node sources with a fake store whose create is atomic: all nine scenarios (within limit, over limit,
  window expiry, rapid same-source, 300 random interleavings of concurrent submissions, different customers, missing IP, store failure, retry after rejection),
  IP parsing, normalisation, hashing-only storage, expiry, config clamping, and graph assertions that Gemini/ticket/email nodes are reachable only through a granted claim.
- **Real n8n 2.47.7 sandbox (own throwaway instance, stubbed Gemini/Firestore/Gmail, real HTTP form posts):** loop wiring, error-output handling, header parsing,
  limited/allowed/unavailable routing (closed and open), window rollover, and that rejected paths create no ticket or email. This is not your n8n.
- **B4/B5 (`tests/rate-limit-reliability.test.ts`, real Code-node sources + fake atomic store):** IP/email-refused requests do not consume global; global-refused requests give back their slots; 60 random-interleaving trials at the global limit; failures between claims; failed and ownership-mismatched releases; store outages (closed/open); rescue cap, notice, held records, 80 concurrent rescue trials, fallback counter, failed rescue emails, no customer data in notice/held records.
- **B4/B5 in a throwaway n8n 2.47.7 (stubbed Firestore/Gmail/Gemini, state in workflow static data, real form POSTs):** workflow imports and publishes; 5 posts with one email gave 3 accepted, 2 refused, global/IP/email slots 3/3/3 and the refused requests' IP slots released; limiter down x6 gave 3 detailed rescue emails, 1 notice, 2 held records; Gmail failing ended executions in `error` with a held failure record. The stub store lives in static data, so simultaneous executions overwrite each other: concurrency is NOT evidenced by the sandbox, only by the Node tests.
- **NOT verified:** real Firestore atomicity and concurrency (taken from the API's documented create semantics, not run), your reverse-proxy headers, the form's look in a
  real browser (only HTTP responses were checked), live Gemini/Gmail, TTL deletion, and the public URL change (v2.1 serves `/form/support-request` once n8n assigns a webhookId on import).

### Manual steps
1. Set a real random salt (and the staff inbox) in `Deployment config`, following [n8n-deployment-config.md](n8n-deployment-config.md).
2. Confirm your proxy sets `X-Forwarded-For` (or switch `ipSource.header`, e.g. `cf-connecting-ip`, hops 1) and that clients cannot inject the last entry.
3. Create the Firestore TTL policy on `rate_limits.expireAt`; the service account used by n8n needs create rights (it bypasses rules; the dashboard doesn't use this collection).
4. The rescue email uses the same inbox as escalations (from `Deployment config`); confirm the credential on `Claim slot`.
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

**The staff inbox is set in ONE place:** the `Deployment config` node. `Send a message` (escalation) and `Send rescue email` both read it from there, and a test asserts
they use the identical expression. The placeholder `REPLACE_WITH_ESCALATION_INBOX@example.com` is refused until you replace it.

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
