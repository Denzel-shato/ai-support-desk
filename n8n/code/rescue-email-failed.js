// n8n Code node "Rescue email failed"  (mode: Run Once for All Items)
//
// 'Send rescue email' failed even after its retries. That must never be silent. This builds a record for
// 'Record failed notification' (identifiers only: kind, n8n execution id, time; no name, email or message) and the
// error text for the 'Rescue email not sent' node, which marks this execution as FAILED so it shows up in n8n's
// execution list (and in any error workflow you attach). The submission itself is still in this execution's data.
const input = $input.first().json ?? {};
const prepared = (() => {
  try {
    return $('Prepare rescue email').last().json ?? {};
  } catch {
    return {};
  }
})();
const S = $('Rate limit settings').first().json.settings;
let executionId = '';
try {
  executionId = String($execution.id ?? '');
} catch {
  /* not available */
}
const clean = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
const reason = clean(typeof input.error === 'string' ? input.error : (input.error?.message ?? input.error?.description ?? 'unknown error')).slice(0, 300);
const retention = Number.isFinite(Number(S.rescue?.heldRetentionSeconds)) ? Math.max(3600, Number(S.rescue.heldRetentionSeconds)) : 30 * 86400;
const now = Date.now();
return [
  {
    json: {
      // flat, because 'Record failed notification' stores these fields as they are
      docId: `held_${executionId || 'unknown'}_email_failed`,
      kind: clean(prepared.kind) || 'unknown',
      reason: 'email_failed',
      executionId,
      createdAt: new Date(now).toISOString(),
      expireAt: new Date(now + retention * 1000).toISOString(),
      failureMessage: `Rescue email could not be sent (${clean(prepared.kind) || 'unknown kind'}): ${reason}. The submission is only in the data of n8n execution ${executionId || '(unknown)'}.`,
    },
  },
];
