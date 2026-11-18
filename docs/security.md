# Security: Firestore rules and API audit

## Architecture (what runs where)
| Where | What | How it reaches Firestore |
|---|---|---|
| Browser | Dashboard pages (no data in the HTML), fetches `/api/*` with an httpOnly session cookie | **Never.** No Firebase client SDK, no Firebase Auth, no `NEXT_PUBLIC_FIREBASE_*` |
| Next.js API routes | Tickets, review/approve, send, reconcile, follow-ups, knowledge base, settings status | Firebase **Admin SDK** (bypasses rules), after `requireAuth` |
| n8n intake workflow | Public form, KB read, ticket create, rate limiting (`rate_limits`) | Service account (bypasses rules) |
| n8n Send Response workflow | Sends the approved email, writes `n8n_send_log` | Service account (bypasses rules) |

Authentication is one shared admin account (signed cookie, see `docs/auth-deployment.md`). The only public operation is the n8n form, which is not a Firestore client.

## Firestore rules (`firestore.rules`, new)
Deny all reads and writes for everyone using client SDKs or the public REST API. Nothing the app does needs more, so this protects `support_tickets` (and `messages`/`events`), `knowledge_base`, `rate_limits` and `n8n_send_log` equally. **This is the most important finding:** the repository had no rules file, so the database's protection depended on whatever was set in the Firebase console (a "test mode" database is open to anyone who knows the project ID, which is in `.env.example`).

## Findings
| # | Finding | Severity | Action |
|---|---|---|---|
| 1 | No `firestore.rules` in the repo; real console state unknown | High if the console is in test mode, otherwise low | Added deny-all rules + `firebase.json`; **you must deploy them** (below) |
| 2 | No security response headers (framing of a page with approve/send buttons, content sniffing, `X-Powered-By`) | Low-Medium | Added headers in `next.config.ts` (frame-ancestors none, nosniff, referrer, HSTS, permissions). No script CSP, because Next's inline scripts would need nonces |
| 3 | `GET /api/tickets/[id]/messages` did not validate the id itself (the lower layer did) | Low | Validates first, like every other route |
| 4 | Everything else audited was already sound: every route calls `requireAuth` first and fails closed; wrong-user/forged/expired tokens rejected; state-changing routes need same-origin JSON; ids validated; review/send accept only an action, the reply text and `retryUnknown`, with recipient and text read from the stored ticket; KB input allowlisted; ticket output allowlisted; errors generic with a request id | n/a | No change |

Accepted, unchanged (see `docs/auth-deployment.md`): in-memory login limiter, no server-side session revocation, single shared account without MFA. Not changed because they are architecture choices, not defects of this phase.

## Not in scope / not changed
- The n8n Send Response workflow. Its webhook secret (`N8N_SEND_RESPONSE_WEBHOOK_SECRET`, enforced in production by the app) is what stops others from triggering emails.
- n8n's own access control and the Google service account's IAM role.

## Tests (`tests/security.test.ts`, plus existing suites)
Run against the real route handlers with no database: wrong-user, wrong-secret, expired and empty cookies get 401 on every privileged route; a valid admin passes auth and reaches the database layer; cross-site and non-JSON writes get 403/415; unsafe ticket, article and message ids get 400; review/KB inputs drop extra fields; the send route reads only `retryUnknown` from its body; error bodies hold no stack, key or path; headers are configured; the rules file is deny-all and nothing in `src` uses a browser Firestore client (the test fails if that changes); all n8n Firestore nodes use the service-account credential.
**Not tested:** the rules were checked **statically only**. They have not been evaluated by the Firebase emulator or a real project (the emulator download is blocked here), so "denied" is by reading a three-line rule, not by an attempted request. Approval/send behaviour is covered by the existing suites with a fake Firestore, not real Firebase.

## Deployment requirements (manual)
1. Deploy the rules: `npx firebase-tools deploy --only firestore:rules --project <your project>` (or paste `firestore.rules` into Console > Firestore > Rules > Publish).
2. Verify in the Rules Playground (or with the emulator) that an unauthenticated read of `support_tickets/anything` is denied; then confirm the dashboard still loads tickets (Admin SDK is unaffected) and a test form submission still creates a ticket.
3. Make sure no other Firebase client app or Auth provider is enabled in the project that you do not expect (anonymous sign-in does not matter under deny-all, but review it).
4. Production env: `AUTH_*` set, `N8N_SEND_RESPONSE_WEBHOOK_SECRET` set and matching n8n, HTTPS only.
5. Keep the service account key out of the repo; grant it only Firestore access (e.g. Cloud Datastore User) and rotate it if it was ever shared.
6. Re-check the headers on the deployed site (some hosts add their own, e.g. HSTS).
