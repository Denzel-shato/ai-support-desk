// n8n Code node "Decide duplicate"  (Run Once for All Items)
//
// Looks at the two n8n-owned log documents for this idempotency key:
//   n8n_send_log/{key}__sent  exists -> Gmail already sent it: answer "sent", send nothing.
//   n8n_send_log/{key}        exists -> an earlier run started and may or may not have sent it:
//                                       answer "unknown", send nothing.
//   neither                          -> this run may claim the send.
// A read that fails for any reason other than "not found" is also "unknown": we cannot
// rule out an earlier send, so we must not send.
const p = $('Validate payload').first().json.p;
const sentRec = $('Get sent record').first().json ?? {};
const claimRec = $('Get claim record').first().json ?? {};

const errText = (j) => (j.error === undefined ? '' : typeof j.error === 'string' ? j.error : JSON.stringify(j.error)).toLowerCase();
const isNotFound = (j) => j.error !== undefined && /not[ _-]?found|\b404\b/.test(errText(j));
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
if (sentRec.error !== undefined && !isNotFound(sentRec)) return unknown('The send log could not be read');
if (exists(claimRec)) return unknown('An earlier attempt did not finish');
if (claimRec.error !== undefined && !isNotFound(claimRec)) return unknown('The send log could not be read');

// Fields the "Create claim" node stores.
return [{ json: { ok: true, status: 'sending', startedAt: new Date().toISOString(), ticketId: p.ticketId, messageType: p.messageType, attempt: p.attempt } }];
