// n8n Code node "Claim failed"  (Run Once for All Items)
// The send log refused the claim (the document already exists, or Firestore failed).
// Either way nothing was sent by THIS run, but an earlier run may have, so answer "unknown".
return [{ json: { code: 200, body: { status: 'unknown', error: 'The send could not be claimed' } } }];
