# Verifying the intake workflow in n8n (phase 4B.1)

`n8n/ai-support-desk-automation.json` is still a **proposal**. This page records what was verified in an isolated
sandbox, what was only simulated, and a safe procedure for checking it in **your** n8n.

## What was run (sandbox, not your instance)
A throw-away **n8n 2.47.7** (npm `n8n@2.47.7`, run with a Node 24 binary because it needs Node >= 24) with its own
database/user folder, **fake credentials**, no activation, and the Firestore project/collection renamed to
`sandbox-test-project` / `sandbox_test_*` in the test copies only. Synthetic data only (`test@example.invalid`).
Your n8n version is unknown, so this does not prove compatibility with it.

| Check | How | Result |
|---|---|---|
| Import | `n8n import:workflow` of the repo JSON, unmodified | imported (**executed in n8n**) |
| Node types/versions exist | loaded each node class from the installed packages: formTrigger 2.6, code 2, if 2.4, noOp 1, googleGemini 1.2, Firestore 1.1, gmail 2.2 | all available (**checked against n8n 2.47.7's code**) |
| `requiredField` | read the Form Trigger source | valid option, but it **only adds a `form-required` CSS class**. The POST handler does no required-field check and copies `bodyData[key] ?? null`, so a missing field arrives as `null`. The Code-node validator is therefore the real enforcement, and it treats `null` as missing (**source reading, not a run**) |
| Invalid submissions (no name, bad email, whitespace-only message, 5,001-char message, array as message) | each run through the real engine | all five ended at `Rejected submission (stop)`; `Message a model`, Firestore and Gmail nodes did **not** run (**executed in n8n**, trigger simulated) |
| Validator crash | forced a throw in `Validate submission` | run stopped there, nothing downstream ran (**executed**) |
| Trigger emits no items | | nothing after the trigger ran (**executed**) |
| Valid submission, real Gemini/Firestore nodes + fake credentials | | validator and gate passed; normalised name reached `Build ticket`; both Gemini nodes failed (HTTP 403) and the failed KB read produced `kbUnavailable`; `Build ticket` made ONE manual-handling ticket (`classification_failed`, escalated); `Create a document` was attempted once and stopped on the fake key before any write; Gmail never ran. This is the Phase 4A continue-on-error path working in the real runtime (**executed**) |
| Valid submission, Gemini/Firestore/Gmail replaced by local stub nodes | the real validator, gate, Code nodes, prompts, expressions and email templates | both prompts rendered the trimmed values; the KB section listed only the active article with ID, title, category and keywords; one ticket, one Create; the acknowledgement and the High-priority staff email rendered with HTML escaped (`&lt;script&gt;`) and the correct "Escalated at" time; a Gemini failure produced the fallback ticket and a staff email with "Not available" fields (**real engine, but external nodes simulated**) |

Code nodes ran in n8n's own JavaScript task runner, so they are not just plain-Node tests.

## NOT verified
- The Form Trigger's real HTTP form (rendering, a browser POST, the payload shape) because that needs an activated or
  listening trigger. The runs used a Code node emitting a Form-Trigger-shaped item.
- Real Gemini, Firestore and Gmail behaviour: response shape (`content.parts[0].text`), how the Create node stores
  arrays/timestamps and omitted fields, and the real shape of a Gemini error item.
- Your n8n version. Very large knowledge bases (prompt size).

## Finding: a missing or unusable credential stops the whole run
With a credential that is removed or not usable by the workflow, n8n failed the execution before running the validator.
"Continue on error" does **not** cover this, so nothing, including the manual-handling fallback ticket, is created.
It can't be fixed inside the workflow. Set an **Error Workflow** (workflow settings) that alerts you, and keep the
Gemini, Google service-account and Gmail credentials healthy.

## Safe procedure for your own n8n
1. Use a **separate n8n workflow copy** (import the JSON; do not activate). Never test on the live workflow.
2. Create **test credentials**: a Gemini key with a small quota, a Google service account that can only reach a
   **test Firestore project or a `sandbox_*` collection** with its own `knowledge_base` containing 2 test articles, and
   Gmail pointed at an inbox you own. In the copy, set the project/collection to the test ones and set both Gmail
   `sendTo` fields to your own address (the acknowledgement defaults to the submitted customer address).
3. Open the form's **test URL** (editor "Execute workflow"), and submit: a valid message; then no name, `not-an-email`,
   a message of spaces, and a 5,001-character message. Valid: expect ONE document in the test collection and one email
   to you. Each invalid one: expect the run to end at `Rejected submission (stop)` with no document and no email.
4. Open the run and check: `Validate submission` output holds the trimmed values; the prompts in both Gemini nodes show
   them; `Create a document` ran once. Then temporarily disable the Gemini credential to see the fallback ticket.
5. Only after that, switch the copy to the real project and activate deliberately.
