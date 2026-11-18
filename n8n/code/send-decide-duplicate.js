// n8n Code node "Decide duplicate"  (Run Once for All Items)
//
// Looks at the two n8n-owned log documents for this idempotency key:
//   n8n_send_log/{key}__sent  exists -> Gmail already sent it: answer "sent", send nothing.
//   n8n_send_log/{key}__a{attempt} exists -> an earlier run of THIS attempt started and may or
//                                       may not have sent it: answer "unknown", send nothing.
//   neither                          -> this run may claim the send.
// The claim is scoped to the attempt number: the dashboard only raises it after an agent
// explicitly resolved an unconfirmed send (or after a known failure), so a resolved message
// can be re-sent, while the "sent" record (all attempts) still blocks a real duplicate.
// A missing document arrives as an EMPTY item ("Always Output Data"). ANY error item, even
// one that mentions "not found", is "unknown": we cannot rule out an earlier send.
const p = $('Validate payload').first().json.p;
const sentRec = $('Get sent record').first().json ?? {};
const claimRec = $('Get claim record').first().json ?? {};

const exists = (j) => j.error === undefined && Object.keys(j).length > 0;
const unknown = (error) => [{ json: { ok: false, code: 200, body: { status: 'unknown', error } } }];

if (exists(sentRec)) {
  return [
    {
      json: {
        ok: false,
        code: 200,
        body: {
          status: 'sent',
          sentAt: typeof sentRec.sentAt === 'string' ? sentRec.sentAt : null,
          messageId: typeof sentRec.gmailId === 'string' ? sentRec.gmailId : null,
          deduplicated: true,
        },
      },
    },
  ];
}
if (sentRec.error !== undefined) return unknown('The send log could not be read');
if (exists(claimRec)) return unknown('An earlier attempt did not finish');
if (claimRec.error !== undefined) return unknown('The send log could not be read');

// Fields the "Create claim" node stores.
return [{ json: { ok: true, status: 'sending', startedAt: new Date().toISOString(), ticketId: p.ticketId, messageType: p.messageType, attempt: p.attempt } }];
