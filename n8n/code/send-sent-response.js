// n8n Code node "Build sent response"  (Run Once for All Items)
// Answer for a message Gmail accepted. Reached even if writing the log failed,
// because the email WAS sent and the dashboard must record that.
const rec = $('Prepare sent record').first().json;
return [{ json: { code: 200, body: { status: 'sent', sentAt: rec.sentAt, messageId: rec.gmailId } } }];
