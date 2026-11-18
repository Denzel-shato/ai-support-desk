// n8n Code node "Check ticket"  (Run Once for All Items)
//
// Compares the request with the stored ticket. Nothing has been sent at this
// point, so every refusal here is a certain "not delivered" (status "failed").
const p = $('Validate payload').first().json.p;
const t = $input.first().json ?? {};

const fail = (code, error) => [{ json: { ok: false, code, body: { status: 'failed', error } } }];

// A missing document arrives as an empty item ("Always Output Data"); an error item is a
// genuine read failure, never "not found".
if (t.error !== undefined) return fail(502, 'The ticket could not be read, so nothing was sent');
if (!t._id && !t.customerEmail && !t.reviewStatus) return fail(404, 'Ticket not found');

const norm = (s) => String(s ?? '').replace(/\r\n?/g, '\n').trim();
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

if (!same(t.customerEmail, p.customerEmail)) return fail(409, 'The recipient does not match the ticket');

if (p.messageType === 'initial_response') {
  if (String(t.reviewStatus ?? '').trim().toLowerCase() !== 'approved') return fail(409, 'The response is not approved');
  if (norm(t.finalResponse) !== p.messageBody) return fail(409, 'The text does not match the approved response');
}
return [{ json: { ok: true } }];
