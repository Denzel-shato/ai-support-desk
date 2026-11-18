// n8n Code node "Check existing ticket"  (mode: Run Once for All Items)
//
// The Create node refused because support_tickets/<ticketId> already exists. Two very different
// situations look identical to Firestore:
//   ours      the document was written by THIS run (an earlier attempt succeeded but its reply was
//             lost, so n8n retried). The ticket is safe; carry on to the emails.
//   duplicate the document belongs to another run: the same submission arrived twice. The first run
//             owns the emails, so this one stops without creating or sending anything.
//   unclear   the existing document could not be read: we cannot tell, so staff are told.
// A missing document arrives as an empty item ("Always Output Data"); an error item is a read failure.
const mine = $('Build ticket').first().json;
const existing = $input.first().json ?? {};

if (existing.error !== undefined || Object.keys(existing).length === 0) {
  return [{ json: { route: 'unclear', error: 'The existing ticket could not be read' } }];
}
const mineId = mine.intakeExecutionId === undefined ? '' : String(mine.intakeExecutionId);
if (mineId && String(existing.intakeExecutionId ?? '') === mineId) {
  return [{ json: { ...mine, route: 'ours' } }];
}
return [{ json: { route: 'duplicate' } }];
