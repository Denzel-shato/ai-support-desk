// n8n Code node "Evaluate rescue slot"  (mode: Run Once for All Items)
//
// Result of 'Claim rescue slot' (success output or error output).
//   created, slot <= maxEmails   -> rescue 'send'    (a full rescue email, as before)
//   created, slot == maxEmails+1 -> rescue 'notice'  (ONE short "more are being held" email, no customer data)
//   already exists               -> next slot; past the notice slot -> rescue 'suppress'
//   other error                  -> retried twice. If the throttle store is down (typically the same outage that
//                                   triggered the rescue) the cap falls back to a per-instance counter in the
//                                   workflow's static data: same limits, but NOT atomic across simultaneous
//                                   executions, so a burst can slightly overshoot. If even that is unavailable
//                                   the email is sent (never lose the notification of an outage), rescue 'send'
//                                   with degraded=true.
// Output route is 'next' (try the next slot) or 'unavailable' (the original refusal route, so
// 'Prepare rescue email' and the rest behave exactly as before) plus `rescue`.
const planned = $('Plan rescue slot').last().json;
const rs = { ...planned.rs };
const input = $input.first().json ?? {};
const carry = rs.carry ?? {};

// 'executionId' and a suppressed/failed record are written by 'Record held submission'.
const finish = (rescue, extra = {}) => [
  {
    json: {
      route: 'unavailable',
      rescue,
      error: carry.error,
      limiterError: carry.limiterError,
      held: {
        docId: `held_${rs.executionId || 'unknown'}_${rs.windowId}`,
        kind: 'rate_limit_unavailable',
        reason: 'suppressed',
        executionId: rs.executionId,
        createdAt: rs.createdAt,
        expireAt: rs.heldExpireAt,
      },
      ...extra,
    },
  },
];

if (input.error === undefined) {
  if (planned.slot <= rs.maxEmails) return finish('send');
  return finish('notice');
}

const e = input.error;
const message = typeof e === 'string' ? e : String(e?.message ?? e?.description ?? JSON.stringify(e ?? {}));
const httpCode = Number(e && typeof e === 'object' ? (e.httpCode ?? e.statusCode ?? e.code) : NaN);
const taken = httpCode === 409 || /already[ _-]?exists/i.test(`${message} ${typeof e === 'object' ? JSON.stringify(e ?? {}) : ''}`);

if (taken) {
  if (planned.slot > rs.maxEmails) return finish('suppress'); // the notice slot is taken too: nothing more to send
  rs.slot = planned.slot + 1;
  rs.errors = 0;
  return [{ json: { route: 'next', rs } }];
}

if ((rs.errors ?? 0) < 2) {
  rs.errors = (rs.errors ?? 0) + 1;
  return [{ json: { route: 'next', rs } }];
}

// The throttle store itself is failing: fall back to a local counter (best effort, see above).
try {
  const sd = $getWorkflowStaticData('global');
  const f = sd.rescueFallback && sd.rescueFallback.windowId === rs.windowId ? sd.rescueFallback : { windowId: rs.windowId, count: 0 };
  f.count += 1;
  sd.rescueFallback = f;
  if (f.count <= rs.maxEmails) return finish('send', { degraded: true });
  if (f.count === rs.maxEmails + 1) return finish('notice', { degraded: true });
  return finish('suppress', { degraded: true });
} catch {
  return finish('send', { degraded: true });
}
