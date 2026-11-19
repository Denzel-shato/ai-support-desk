// n8n Code node "Build held record"  (mode: Run Once for All Items)
//
// A submission whose rescue email was suppressed by the cap. Flattens the record that 'Evaluate rescue slot' prepared
// so 'Record held submission' can store it. Identifiers only (kind, n8n execution id, time): no name, email or message.
// The submission itself stays in that n8n execution's data.
const h = $input.first().json.held;
return [{ json: { docId: h.docId, kind: h.kind, reason: h.reason, executionId: h.executionId, createdAt: h.createdAt, expireAt: h.expireAt } }];
