# Failure alerts, execution data and recovery (audit finding B8)

Status: **code and exports changed in the repository; nothing here has been imported into, or run on, a real n8n.** Everything in
"Manual setup" must be done by you, in your n8n and Firebase. Facts about n8n were checked against the n8n 2.47.7 source and n8n's
documentation; they were **not** observed on your instance.

## What the audit found, and what changed

| Finding | Result |
|---|---|
| No error workflow, so an unhandled failure was visible only if someone opened the Executions list | **Confirmed.** New workflow `n8n/ai-support-desk-failure-alert.json` (Error Trigger → `Alert config` → `Prepare alert` → Gmail). It contains **no customer data** (see below). You still have to assign it in each workflow's settings: n8n stores the assignment by workflow id, so it cannot be exported. |
| Code nodes between "your request has been submitted" and "ticket saved / staff notified" had no failure handling: a bug there would stop the run and the submission would exist only in a failed execution | **Confirmed and fixed.** `Select active articles`, `Build ticket`, `Prepare email fields`, `Classify create error` and `Check existing ticket` now have an **error output** that goes straight to `Prepare rescue email` (B5's rescue chain). A new rescue kind, `notification_failed`, covers "ticket saved but the notification step failed". |
| Customer is told "submitted" before the ticket exists | **Partly confirmed.** The wording does not claim a ticket exists: it says the request "has been submitted and is now being processed" and "if you do not hear from us, please contact us again". Every failure after that point now ends in a rescue email (above) or a failed execution that an alert reports. A test pins the wording. |
| A failed rescue email could be silent | **Already fixed by B5** (`Send rescue email` error output → `Rescue email failed` → `Record failed notification` → `Rescue email not sent`, which fails the execution). With the error workflow assigned, that failure now also alerts you. |
| Customer data kept in n8n execution data | **Confirmed, and not removable by a setting without losing data** (see "Execution data", the important trade-off). Mitigation is a short retention period and tight access. |

What is **not** an unhandled failure, and therefore does **not** trigger the error workflow: anything routed through an error output
(for example a Gmail failure that ends in a rescue email). In those cases the rescue email is your alert. The error workflow covers what
nothing handles: a failure of `Prepare rescue email`, `Rescue email not sent`, `Stop: deployment misconfigured`, and any other node that
fails with no error output.

## Manual setup (do this in a test n8n first)

1. **Import** `n8n/ai-support-desk-failure-alert.json`. Leave it **inactive** for now. Select your Gmail credential on `Send failure alert`
   (the export references a credential named `Gmail account`; re-select it).
2. **Set the alert inbox** in the `Alert config` Code node: replace the placeholder inside the node, using the **same staff inbox** you set
   in `Deployment config` of the intake workflow. Like that node, `Alert config` ships a placeholder, **throws** on a placeholder, missing or
   invalid address, and never echoes the bad value, so a fresh import cannot send an alert to a placeholder. It uses exactly the same validator
   as `Deployment config` (a test enforces that). Do not commit or share the workflow after editing it.
3. **Assign it**: open each of the two production workflows → Workflow settings → **Error Workflow** → choose `AI Support Desk failure alert`:
   - `AI Support Desk automation (proposed, untested)` (intake)
   - `AI Support Desk: send approved response (proposed, untested)` (**Send Response**; its JSON is not changed by this work, this is a setting in n8n only)
4. **Test the alert path** (test n8n only; this sends one real email to the inbox you set): follow n8n's Error Trigger documentation to run the
   alert workflow with its example error data, and confirm the email arrives. Then make a real node fail in the test instance (for example
   deselect the Gmail credential on `Send rescue email`) and confirm both the rescue email behaviour and the alert. Whether n8n requires the
   error workflow itself to be **active** to run was not verified: check n8n's documentation for your version and test it.
5. Set the execution-data environment variables below on your n8n deployment.

### What the alert contains

Workflow name, failing node, execution id, mode, a link to the execution, and the error text **shortened to 300 characters with e-mail
addresses and links masked**. It never contains the stack trace, the submission, a name, an e-mail address or a message, and it contains
neither the salt nor the inbox. Tests feed it hostile and customer-bearing payloads to prove this. **The alert tells you to open the execution:
for the intake workflow, the failed execution still holds the original submission, and n8n deletes it after the retention period.**

## Execution data: what is kept, why, and what to set

n8n keeps the data of every node of an execution. For the intake workflow that includes the customer's name, e-mail and message, the Gemini prompts
and answers, and, because of B2, the output of `Deployment config` (**the real salt and inbox**).

**Do not turn off "Save successful production executions" for the intake workflow, and do not set `EXECUTIONS_DATA_SAVE_ON_SUCCESS=none`.**
B2 suggested considering it. That advice is replaced by this: B5's rescue-email cap *suppresses* an email when a burst of limiter failures
happens, ends the run normally (n8n records it as **successful**), and stores identifiers only in Firestore (`held_<execution id>_...`).
**The suppressed submission itself exists only in that execution's data.** With successful runs not saved, it would be lost for good. For the same
reason the export sets `saveDataSuccessExecution` and `saveDataErrorExecution` explicitly to `all`, and also `saveManualExecutions: false` and
`saveExecutionProgress: false` (progress saving would persist every node's data mid-run). A test fails if the success setting is changed to `none`.

So retention length is the lever. Values below are from n8n's execution-data documentation; defaults were not verified on your version:

| Variable | n8n default | Set to | Why |
|---|---|---|---|
| `EXECUTIONS_DATA_PRUNE` | `true` | `EXECUTIONS_DATA_PRUNE=true` | keep pruning on |
| `EXECUTIONS_DATA_MAX_AGE` | `336` hours (14 days) | `EXECUTIONS_DATA_MAX_AGE=168` (7 days) as a starting point | the shorter it is, the less customer data and secret material sits in n8n; **the longer, the more time you have to recover a rescued or suppressed submission.** Choose it from how quickly you will really read alerts. |
| `EXECUTIONS_DATA_PRUNE_MAX_COUNT` | `10000` | leave | a count limit also deletes old data |
| `EXECUTIONS_DATA_SAVE_ON_ERROR` | `all` | leave `all` | failed runs are the recovery copy |
| `EXECUTIONS_DATA_SAVE_ON_SUCCESS` | `all` | leave `all` for the intake workflow (see above) | B5 |

Be aware of the mismatch you create: B5's held records live in Firestore for `heldRetentionSeconds` (30 days) but the submission behind a held
record lives only as long as `EXECUTIONS_DATA_MAX_AGE`. After that the record only says "something was held on that day".

**Send Response workflow:** it keeps the customer's address and the response text in the data of every successful send. Nothing in its exported
nodes reads another execution's data (idempotency is in Firestore claim documents), so setting that workflow's "Save successful production executions" to
"Do not save" in n8n does not touch the duplicate-send protection. I did **not** change that workflow's JSON; make this choice in n8n during your
integration test and confirm a repeated send is still refused.

**Residual risk: the salt and inbox are in retained execution data** (every execution that passes `Deployment config` stores its output). Anyone who
can open executions can read them. Mitigations: short `EXECUTIONS_DATA_MAX_AGE`, few n8n users, rotate the salt if you suspect exposure (this resets
limiter counters, nothing else). n8n 2.47.7 has an execution-data redaction feature, but it is an Enterprise feature that hides data when it is read, it
does not stop it being stored, and the export does not enable it.

## Rescue emails for accepted submissions are not throttled

B5 throttles rescue emails only for submissions the limiter *refused*. The new error outputs belong to submissions that were **accepted**
(they passed the rate limits), so they are not throttled either: if `Build ticket` were broken, up to the rate limits' worth of accepted
submissions (global 20 per minute, per source and per e-mail limits apply as before) would each produce a rescue email. That is deliberate, because
each of those customers must not be lost, but it is noisy: the first alert is the signal to fix it.

## Backup and recovery

Not configured or verified by me; these need your Firebase project and n8n host.

- **Firestore** (`support_tickets`, `knowledge_base`): configure scheduled backups and/or point-in-time recovery in your Firebase/Google Cloud project, and test one restore. `rate_limits` is
  throwaway data (rate-limit slots, held records) and needs no backup.
- **n8n**: back up its database **and keep `N8N_ENCRYPTION_KEY` safe**; without that key n8n cannot decrypt the credentials in a restored database. Keep the
  workflow exports in Git **with placeholders only**; never export the live, configured workflow into the repository.
- **Finding a lost submission**, in this order: (1) the rescue email in the staff inbox; (2) a failed execution in n8n (the alert links to it); (3) a
  `held_<execution id>_...` document in `rate_limits` (identifiers only) and the execution it names, if still within `EXECUTIONS_DATA_MAX_AGE`.

## What is verified and what is not

Verified by tests (real Code-node sources and the exported JSON, in plain Node with a stand-in for n8n's helpers: `tests/operational-readiness.test.ts`):
every node after "submitted" either has an error output or is on a reviewed list; the five error outputs lead only into B5's rescue chain and
never to Gemini, a ticket write or the customer email; the rescue email kinds; the alert contains no customer data, masks addresses and links,
escapes HTML and is bounded; `Alert config` refuses placeholders and invalid addresses and shares B2's validator; the execution-data settings
(including that successful runs are **not** disabled).

Not verified: that an error workflow is assigned and fires in your n8n; that the alert email is delivered; the real execution retention and pruning behaviour of
your n8n version; whether handled errors really finish as "successful" executions and unhandled ones as failed (documented n8n behaviour, not observed
here); that nothing else in your hosting stores request data; backups and restores.
