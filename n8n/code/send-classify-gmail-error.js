// n8n Code node "Classify Gmail error"  (Run Once for All Items)
//
// Gmail's error output does NOT always prove nothing was sent (a timeout can follow a
// successful send). Only an immediate, explicit rejection is "failed": a bad request
// (400), or an authentication/permission problem (401/403), or an address Gmail refuses.
// Everything else is "unknown", and the claim is kept so a repeat can't email twice.
const j = $input.first().json ?? {};
const e = j.error ?? j;
const text = (typeof e === 'string' ? e : JSON.stringify(e ?? {})).toLowerCase();
const httpCode = Number(e && (e.httpCode ?? e.statusCode ?? e.code));

const clearRejection =
  [400, 401, 403].includes(httpCode) ||
  /invalid (to|recipient)|recipient address required|invalid_grant|unauthorized|forbidden|invalid credentials|insufficient permission|the (credentials|access token) .*(invalid|expired|revoked)/.test(text);

return [
  {
    json: clearRejection
      ? { releaseClaim: true, code: 502, body: { status: 'failed', error: 'Gmail could not send the email' } }
      : { releaseClaim: false, code: 200, body: { status: 'unknown', error: 'The email may or may not have been sent' } },
  },
];
