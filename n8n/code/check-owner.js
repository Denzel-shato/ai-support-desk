// n8n Code node "Check owner"  (mode: Run Once for All Items)
//
// Receives what 'Read claim' found at the slot we are about to give back. The slot is deleted ONLY when it
// exists and its stored claimId equals this submission's claimId. A missing document, an error, or a
// different claimId means "not ours (any more)": leave it alone. Firestore's delete does not complain about
// a missing document and has no ownership check, so this check is what stops one submission from releasing
// another's slot.
const want = $('Plan release').last().json;
const got = $input.first().json ?? {};
const owned = got.error === undefined && typeof got.claimId === 'string' && got.claimId.length > 0 && got.claimId === want.claimId;
return [{ json: { owned, docId: want.docId } }];
