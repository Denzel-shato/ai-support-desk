// n8n Code node "Plan rescue slot"  (mode: Run Once for All Items)
//
// Protects the staff inbox when the limiter store is down. Only reached for submissions the limiter REFUSED
// because its store failed (the visitor was told to try again). Per time window there are `maxEmails`
// "send" slots, then ONE "notice" slot, then nothing, so an outage can produce at most maxEmails + 1 emails
// per window however many submissions arrive. Slots are claimed with the same atomic create-if-absent
// pattern as the limiter, so concurrent submissions cannot send more than that.
// This only affects refused submissions. Rescue emails for ACCEPTED submissions that could not be saved
// or acknowledged never pass through here.
// First pass: the input is the finished release step. Later passes: 'Evaluate rescue slot' passes the updated state in `rs`.
const prev = $input.first().json ?? {};

let rs;
if (prev && prev.rs) {
  rs = prev.rs;
} else {
  const S = $('Rate limit settings').first().json.settings;
  const r = $('Plan release').last().json;
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.floor(Number(v)))) : d);
  const maxEmails = num(S.rescue?.maxEmails, 1, 10, 3);
  const windowSeconds = num(S.rescue?.windowSeconds, 60, 86400, 3600);
  const retention = num(S.rescue?.heldRetentionSeconds, 3600, 365 * 86400, 30 * 86400);
  const nowMs = Date.now();
  const windowId = Math.floor(nowMs / 1000 / windowSeconds);
  let executionId = '';
  try {
    executionId = String($execution.id ?? '');
  } catch {
    /* not available */
  }
  rs = {
    slot: 1,
    errors: 0,
    maxEmails,
    windowId,
    windowEnd: (windowId + 1) * windowSeconds * 1000,
    expireAt: new Date((windowId + 1) * windowSeconds * 1000 + 3600 * 1000).toISOString(),
    heldExpireAt: new Date(nowMs + retention * 1000).toISOString(),
    createdAt: new Date(nowMs).toISOString(),
    executionId,
    carry: { error: r.error, limiterError: r.limiterError },
  };
}
return [
  {
    json: {
      rs,
      docId: `rs_limiter_${rs.windowId}_${rs.slot}`,
      kind: 'rescue_limiter',
      slot: rs.slot,
      createdAt: rs.createdAt,
      expireAt: rs.expireAt,
    },
  },
];
