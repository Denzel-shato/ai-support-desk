// n8n Code node "Plan release"  (mode: Run Once for All Items)
//
// After a submission was REFUSED (limited, or the limiter store failed) this walks through the slots it
// holds (rl.held, recorded by 'Evaluate claim') one at a time and gives them back, so a refused
// submission never keeps capacity (in particular global capacity) that it is not using.
//
// Each pass outputs the next slot to give back (route 'release') or route 'release_done'. State travels in
// `rel`. A release that fails is counted, never retried and never blocks anything: a slot that is NOT given
// back just stays taken until its window ends, which is the safe direction (stricter, never a bypass).
let prev = null;
try {
  if ($('Plan release').isExecuted === true) prev = $('Plan release').last().json;
} catch {
  prev = null;
}
const input = $input.first().json ?? {};

let rel;
if (prev && prev.rel) {
  // The previous pass is finished; its outcome is what arrived here:
  //   { success: true }  the delete ran (the slot was ours)    { error }  the delete failed
  //   { owned: false }   'Check owner' found the slot was not ours, so nothing was deleted
  const failed = input.error !== undefined ? 1 : 0;
  rel = {
    ...prev.rel,
    i: prev.rel.i + 1,
    failed: prev.rel.failed + failed,
    released: prev.rel.released + (!failed && input.success === true ? 1 : 0),
    skipped: prev.rel.skipped + (input.owned === false ? 1 : 0),
  };
} else {
  const e = $('Evaluate claim').last().json;
  rel = { held: (e.rl.held ?? []).slice(), i: 0, failed: 0, skipped: 0, released: 0, route: e.route, carry: { error: e.error, limiterError: e.limiterError } };
}

if (rel.i >= rel.held.length) {
  return [{ json: { route: 'release_done', finalRoute: rel.route, rel, ...rel.carry } }];
}
const h = rel.held[rel.i];
return [{ json: { route: 'release', docId: h.docId, claimId: h.claimId, finalRoute: rel.route, rel } }];
