// n8n Code node "Evaluate claim"  (mode: Run Once for All Items)
//
// Receives the result of "Claim slot": the success output (the slot was created) or the error output.
//   created                      -> next check, or ALLOWED when every check has a slot
//   error "already exists"       -> that slot is held by another submission: try the next slot, or
//                                   LIMITED once all `limit` slots are taken
//   any other error              -> retried twice immediately (a single blip must not reject a genuine
//                                   visitor); if it persists the limiter store is unavailable:
//                                   'unavailable' (failMode closed) or ALLOWED with degraded=true (open)
// Output: { route: 'next' | 'allowed' | 'limited' | 'unavailable', rl, formSubmittedText?, ... }
const planned = $('Plan claim').last().json;
const rl = { ...planned.rl };
const input = $input.first().json ?? {};
const check = rl.checks[rl.idx];

const done = (route, extra = {}) => [{ json: { route, rl, ...extra } }];
const text = (k) => rl.messages[k];

if (input.error === undefined) {
  // Slot claimed. Move on to the next check, starting at its first slot.
  if (rl.idx + 1 >= rl.checks.length) return done('allowed', { formSubmittedText: text('received') });
  rl.idx += 1;
  rl.slot = 1;
  return done('next');
}

const e = input.error;
const message = typeof e === 'string' ? e : String(e?.message ?? e?.description ?? JSON.stringify(e ?? {}));
const httpCode = Number(e && typeof e === 'object' ? (e.httpCode ?? e.statusCode ?? e.code) : NaN);
const taken = httpCode === 409 || /already[ _-]?exists/i.test(`${message} ${typeof e === 'object' ? JSON.stringify(e ?? {}) : ''}`);

if (taken) {
  if (rl.slot >= check.limit) return done('limited', { limitedBy: check.kind, formSubmittedText: text('limited') });
  rl.slot += 1;
  return done('next');
}

// Not "slot taken": the limiter store failed. Retry the same slot twice before giving up.
if ((rl.errors ?? 0) < 2) {
  rl.errors = (rl.errors ?? 0) + 1;
  return done('next');
}
// Keep this distinguishable from Gemini / Firestore-ticket / email failures: route 'unavailable' / degraded.
const failure = message.replace(/\s+/g, ' ').slice(0, 300);
if (rl.failMode === 'open') {
  rl.degraded = true;
  return done('allowed', { degraded: true, limiterError: failure, formSubmittedText: text('received') });
}
return done('unavailable', { limiterError: failure, error: failure, formSubmittedText: text('unavailable') });
