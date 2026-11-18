// n8n Code node "Prepare rescue email"  (mode: Run Once for All Items)
//
// One staff email for every situation where the automation could not finish normally and the
// customer's submission must not be lost. All values are HTML-escaped here; Gmail only prints
// `html`. The submission always comes from 'Build ticket' (validated, trimmed) and the failure
// text is shortened, so no stack trace or credential detail is forwarded.
//
// kind (decided from where the item came from):
//   ticket_not_saved        Firestore failed; no ticket exists; no email was sent to anyone
//   ticket_unclear          the ticket ID already existed but could not be confirmed
//   acknowledgement_failed  ticket saved; the customer's acknowledgement email failed
//   escalation_failed       ticket saved; the staff escalation email failed
const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const ran = (name) => {
  try {
    return $(name).isExecuted === true;
  } catch {
    return false;
  }
};

let t = {};
try {
  t = $('Build ticket').first().json ?? {};
} catch {
  /* nothing to show */
}
const input = $input.first().json ?? {};

let kind;
if (input.route === 'unclear') kind = 'ticket_unclear';
else if (input.kind === 'failure') kind = 'ticket_not_saved';
else if (ran('Send a message1')) kind = 'acknowledgement_failed';
else if (ran('Send a message')) kind = 'escalation_failed';
else kind = 'ticket_not_saved';

const TEXT = {
  ticket_not_saved: {
    label: 'Ticket NOT saved',
    what: 'The ticket could not be saved to Firestore, so it will not appear in the dashboard. No email was sent to the customer or to staff. The customer was shown a "submitted" message.',
    todo: 'Please handle this request manually and contact the customer.',
  },
  ticket_unclear: {
    label: 'Ticket status unclear',
    what: 'A ticket with this ID already exists but could not be confirmed as part of this submission. No email was sent.',
    todo: 'Check the dashboard for this customer. If there is no ticket, handle this request manually.',
  },
  acknowledgement_failed: {
    label: 'Customer acknowledgement failed',
    what: 'The ticket was saved, but the acknowledgement email to the customer could not be sent.',
    todo: 'The ticket is in the dashboard. Consider replying to the customer yourself.',
  },
  escalation_failed: {
    label: 'Escalation email failed',
    what: 'The ticket was saved, but the escalation email to the staff inbox could not be sent (this message is the fallback).',
    todo: 'The ticket is in the dashboard. Please review it now.',
  },
}[kind];

const clean = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
const failure = clean(
  typeof input.error === 'string' ? input.error : (input.error?.message ?? input.error?.description ?? ''),
).slice(0, 300);
let executionId = '';
try {
  executionId = String($execution.id ?? '');
} catch {
  /* not available */
}

const row = (label, value, pre) =>
  `<tr><td style="padding:6px 16px 6px 0; vertical-align:top; color:#6b625a;">${esc(label)}</td>` +
  `<td style="padding:6px 0; ${pre ? 'white-space:pre-line;' : ''}">${esc(value)}</td></tr>`;

const html =
  `<div style="font-family:Arial, Helvetica, sans-serif; color:#1f1a17; max-width:640px;">` +
  `<h2 style="margin:0 0 12px; color:#991b1b;">${esc(TEXT.label)}</h2>` +
  `<p style="margin:0 0 8px;">${esc(TEXT.what)}</p>` +
  `<p style="margin:0 0 16px;"><strong>${esc(TEXT.todo)}</strong></p>` +
  `<table style="border-collapse:collapse; font-size:14px;">` +
  row('Customer', clean(t.customerName)) +
  row('Email', clean(t.customerEmail)) +
  row('Message', String(t.message ?? ''), true) +
  row('Ticket ID', clean(t.ticketId)) +
  row('Priority', clean(t.priority) || 'Unknown') +
  (failure ? row('Error', failure) : '') +
  (executionId ? row('n8n execution', executionId) : '') +
  `</table>` +
  `<p style="margin-top:20px; font-size:11px; color:#9a9086;">Generated automatically by the AI Support Desk</p></div>`;

const subject = `⚠️ ${TEXT.label} — ${clean(t.customerName).slice(0, 80)}`;
return [{ json: { kind, subject, html } }];
