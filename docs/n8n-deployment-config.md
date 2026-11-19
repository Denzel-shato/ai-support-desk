# n8n deployment configuration (audit finding B2)

Two values are specific to your deployment and must **never** live in Git:

| Value | What it is for | Shipped as (placeholder) |
|---|---|---|
| Staff inbox | Receives escalation emails **and** rescue emails | `REPLACE_WITH_ESCALATION_INBOX@example.com` |
| Rate-limit salt | Secret mixed into every stored rate-limit hash | `CHANGE-ME-TO-A-LONG-RANDOM-STRING` |

Both are set in **one** place: the `Deployment config` Code node of `n8n/ai-support-desk-automation.json`, inside your n8n editor.
The repository only ever contains the placeholders. The workflow refuses to process anything while either one is a placeholder,
missing or invalid.

## Where each placeholder was, and how it is guarded now

| Was | Now |
|---|---|
| Escalation email `Send a message` -> `sendTo` literal | `sendTo` is the expression `$('Deployment config').first().json.deployment.escalationInbox`. No address is stored in the node. |
| Rescue email `Send rescue email` -> `sendTo` literal | Same expression, so both staff emails always go to the same inbox. |
| `salt` in `Rate limit settings` | Removed from that node. `Deployment config` holds it; `Prepare rate limit` re-validates it and **throws** (the run fails, nothing is claimed) if it is not valid. |

The only remaining occurrences of the placeholders are in `n8n/code/deployment-config.js` and its embedded copy in the workflow JSON
(plus these docs and tests). A test fails if they appear anywhere else.

## What "valid" means

- **Inbox:** one plain mailbox (no display name, list, spaces, line breaks or template syntax), not a placeholder, and not on a reserved
  example/test domain (`example.com/.net/.org`, `.example`, `.test`, `.invalid`, `.localhost`).
- **Salt:** 32 to 256 printable ASCII characters without spaces or `{ } < >`, at least 8 different characters, and not a placeholder
  (anything containing `replace-with`, `change-me`, `placeholder`, `your-salt/secret/email/inbox/address`).
  `openssl rand -hex 32` (64 characters) satisfies this.

## What happens when the configuration is not valid

1. `Deployment config` reports problem **codes only** (for example `escalation_inbox_placeholder`, `rate_limit_salt_length`); a bad value is never echoed.
2. `Deployment config valid?` sends the run down the failing branch: the visitor gets the existing "We couldn't process your request right now" message
   (no operator detail), then `Stop: deployment misconfigured` **fails the execution** with the codes, so it shows as an error in n8n's Executions list.
3. Nothing after the gate runs: no rate-limit claim, no Gemini, no Firestore ticket, no email. The submission is **not** saved or forwarded, because without a valid
   inbox there is nowhere safe to send it. Fix the configuration and ask visitors to resubmit; set an **Error Workflow** so a failing run alerts you.

## Why a Code node and not an environment variable

Whether a Code node or an expression may read environment variables depends on your n8n settings (`N8N_BLOCK_ENV_ACCESS_IN_NODE`, and task runners isolate
the Code-node environment from the main process). n8n's own documentation and community reports disagree on the default for 2.x, and this was **not** checked on
your instance (2.47.7), so the workflow does not depend on it. n8n credentials cannot be read from a Code node, and `$vars` needs a plan that offers Variables.
If you confirm on your instance that `$env.SOME_NAME` works in that Code node, you may write `$env.SOME_NAME` in place of a literal; validation still applies to
whatever value results.

**Consequences you should know about** (this is the price of not relying on `$env`):
- Anyone who can edit or export the workflow in n8n can read the salt and the inbox. Restrict who has editor access.
- An exported or backed-up workflow contains the real values. **Never export the live workflow to Git or share it.** Re-importing the repository JSON over the live
  workflow puts the placeholders back, and the workflow then refuses to run until you set them again.
- Execution data of `Deployment config` (and of nodes that pass its item on) contains the salt and inbox while that execution is kept. Keep execution retention short
  and consider turning off "Save successful production executions".

## Manual setup (do this in a test n8n first)

1. **Import** `n8n/ai-support-desk-automation.json`. Leave it **inactive**. Re-select the Gemini, Google service-account and Gmail credentials on their nodes.
2. **Generate the salt yourself**, on your own machine, and do not paste it into chat, tickets, Git or screenshots:
   - macOS / Linux / WSL: `openssl rand -hex 32`
   - Any system with Node: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

   Both print 64 hex characters from a cryptographically secure source. Store a copy in your password manager: changing the salt later resets all rate-limit counters.
3. Open the workflow, open the **`Deployment config`** Code node, and replace the two values at the top:
   - `escalationInbox:` the real staff mailbox that should receive escalations and rescue emails (you choose it; nothing in this repository supplies one);
   - `rateLimitSalt:` the value from step 2.

   Save the workflow.
4. **Check it fails safe:** before editing (or after temporarily restoring a placeholder), run a test submission. Expect an **error** execution whose message lists the
   problem codes, no ticket in Firestore, and no email.
5. **Check it works:** with real values set, submit a test request and confirm a ticket is created, the escalation email (for High/Urgent) arrives in the staff inbox, and a
   forced failure (for example a deliberately broken acknowledgement) delivers the rescue email to the **same** inbox.
6. Only then activate. Re-do steps 3 to 5 in every n8n instance you import into (test and production values should differ).

## Rotating the salt
Replace `rateLimitSalt` and save. All counters start from zero (old documents expire through the TTL policy). Do it if the salt may have been exposed.

## What is not verified (needs your real n8n)
- That the node behaves as described in n8n 2.47.7: the tests run the Code-node sources in plain Node with stand-in helpers and check the exported JSON wiring.
  Nothing was imported into or executed by n8n for this change.
- That `Stop and Error` (type version 1) and the new IF node import and render cleanly in 2.47.7.
- What the visitor sees in a browser when the run fails after the Respond node, and how your Error Workflow reports it.
- Gmail delivery to your real inbox, the `$env` behaviour of your instance, who has editor access, and your execution-data retention settings.
