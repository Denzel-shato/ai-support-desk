// n8n Code node "Classify create error"  (mode: Run Once for All Items)
//
// Reached only from the ERROR output of "Create a document", after n8n's own retries.
// Nothing has been emailed yet. Decides whether Firestore refused the write because the
// document already exists (the deterministic ticket ID was used before) or failed for any
// other reason (outage, permissions, bad credential ...).
const j = $input.first().json ?? {};
const e = j.error ?? j;
const message = typeof e === 'string' ? e : String(e?.message ?? e?.description ?? JSON.stringify(e ?? {}));
const text = `${message} ${typeof e === 'object' ? JSON.stringify(e ?? {}) : ''}`;
const httpCode = Number(e && typeof e === 'object' ? (e.httpCode ?? e.statusCode ?? e.code) : NaN);
const conflict = httpCode === 409 || /already[ _-]?exists/i.test(text);
return [{ json: { kind: conflict ? 'conflict' : 'failure', error: message.replace(/\s+/g, ' ').slice(0, 300) } }];
