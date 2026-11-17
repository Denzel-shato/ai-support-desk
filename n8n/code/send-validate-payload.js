// n8n Code node "Validate payload"  (Run Once for All Items)
//
// First step after the authenticated Webhook, before Firestore or Gmail. The
// dashboard builds this payload from the stored ticket, but this workflow is a
// public URL protected only by a shared secret, so it checks everything itself.
//
// Output: ONE item.
//   ok: true  -> `p` holds the cleaned values every later node reads.
//   ok: false -> `code` + `body`, ready for the "Respond" node (400). The
//                submitted text is never echoed back.
const raw = $input.first().json;
const b = raw && typeof raw.body === 'object' && raw.body !== null && !Array.isArray(raw.body) ? raw.body : {};
const bad = [];
const CONTROL = /[\u0000-\u001f\u007f]/;
const ID = /^[A-Za-z0-9_-]+$/;

const id = (v, name, min, max) => {
  if (typeof v !== 'string' || v.length < min || v.length > max || !ID.test(v)) {
    bad.push(name);
    return null;
  }
  return v;
};

const ticketId = id(b.ticketId, 'ticketId', 1, 128);
const key = id(b.idempotencyKey, 'idempotencyKey', 8, 128);

const types = ['initial_response', 'follow_up'];
const messageType = types.includes(b.messageType) ? b.messageType : (bad.push('messageType'), null);

// Exactly one plain address: no list, no display name, no line breaks.
let customerEmail = null;
if (typeof b.customerEmail === 'string') {
  const e = b.customerEmail.trim();
  const at = e.indexOf('@');
  const domain = e.slice(at + 1);
  const ok =
    e.length <= 254 &&
    at > 0 &&
    at === e.lastIndexOf('@') &&
    at <= 64 &&
    !CONTROL.test(e) &&
    !/[\s,;<>()"\\]/.test(e) &&
    /^[^.][^\s]*\.[^.\s]+$/.test(domain) &&
    !domain.includes('..') &&
    !e.slice(0, at).includes('..') &&
    !e.startsWith('.') &&
    !e.slice(0, at).endsWith('.');
  if (ok) customerEmail = e;
}
if (!customerEmail) bad.push('customerEmail');

let subject = null;
if (typeof b.subject === 'string' && b.subject.trim() && b.subject.length <= 200 && !CONTROL.test(b.subject)) {
  subject = b.subject.trim();
} else bad.push('subject');

const norm = (s) => String(s).replace(/\r\n?/g, '\n').trim();
let messageBody = null;
if (typeof b.messageBody === 'string' && norm(b.messageBody) && norm(b.messageBody).length <= 10000) {
  messageBody = norm(b.messageBody);
} else bad.push('messageBody');

// Both fields carry the same text for an initial response; a mismatch means the payload was altered.
if (messageType === 'initial_response' && b.finalResponse !== undefined && messageBody !== null && norm(b.finalResponse) !== messageBody) {
  bad.push('finalResponse');
}
if (messageType === 'follow_up' && b.messageId !== undefined && b.messageId !== key) bad.push('messageId');
const attempt = Number.isInteger(b.attempt) && b.attempt >= 1 ? b.attempt : 1;

if (bad.length) {
  return [{ json: { ok: false, code: 400, body: { status: 'failed', error: 'Invalid payload', fields: bad } } }];
}
return [{ json: { ok: true, p: { ticketId, key, messageType, customerEmail, subject, messageBody, attempt } } }];
