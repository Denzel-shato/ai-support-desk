// n8n Code node "Prepare sent record"  (Run Once for All Items)
// Gmail has accepted the message. Builds the log document that makes every later
// repeat of this idempotency key answer "sent" without emailing again.
const p = $('Validate payload').first().json.p;
const gmail = $input.first().json ?? {};
return [
  {
    json: {
      status: 'sent',
      sentAt: new Date().toISOString(),
      gmailId: typeof gmail.id === 'string' ? gmail.id : null,
      ticketId: p.ticketId,
      messageType: p.messageType,
    },
  },
];
