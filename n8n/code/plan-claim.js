// n8n Code node "Plan claim"  (mode: Run Once for All Items)
//
// Builds the one Firestore document this attempt will try to create: slot `rl.slot` of check `rl.idx`.
// The document name is deterministic (kind, hashed source, window, slot), so "create" fails exactly
// when another submission already holds that slot. Only hashes and timestamps are stored.
const rl = $input.first().json.rl;
const c = rl.checks[rl.idx];
return [
  {
    json: {
      rl,
      docId: `rl_${c.kind}_${c.key}_${c.windowId}_${rl.slot}`,
      kind: c.kind,
      slot: rl.slot,
      createdAt: rl.nowIso,
      expireAt: c.expireAt,
    },
  },
];
