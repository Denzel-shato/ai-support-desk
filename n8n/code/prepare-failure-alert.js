// n8n Code node "Prepare alert"  (mode: Run Once for All Items)   [workflow: AI Support Desk failure alert]
//
// Runs after an Error Trigger: one of the AI Support Desk workflows failed in a way nothing handled. Builds a short
// staff notification that contains NO customer data. n8n's Error Trigger supplies only the workflow name, the
// execution id/url, the failing node and the error text. The error text is the only free-form part, so it is
// shortened and e-mail addresses and links are masked before it is printed (a Gmail or Firestore error can echo
// the address it was working with). The stack trace is never forwarded. Everything is HTML-escaped here.
const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const one = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const mask = (s) =>
  s
    .replace(/https?:\/\/\S+/gi, '[link removed]')
    .replace(/[^\s@<>"'()[\],;]+@[^\s@<>"'()[\],;]+/g, '[email removed]');

const e = $input.first().json ?? {};
const ex = e.execution && typeof e.execution === 'object' ? e.execution : {};
const wf = e.workflow && typeof e.workflow === 'object' ? e.workflow : {};

const workflowName = one(wf.name, 120) || 'Unknown workflow';
const failedNode = one(ex.lastNodeExecuted, 120) || 'Unknown node';
const executionId = one(ex.id, 40);
const mode = one(ex.mode, 20);
const errorText = mask(one(typeof ex.error === 'string' ? ex.error : (ex.error?.message ?? ex.error?.description ?? ''), 300));
// Only an https link to the n8n editor is shown, and never one that carries a query string or credentials.
const rawUrl = one(ex.url, 300);
const url = /^https?:\/\/[^\s?#@]+$/i.test(rawUrl) ? rawUrl : '';

const row = (label, value) =>
  `<tr><td style="padding:6px 16px 6px 0; vertical-align:top; color:#6b625a;">${esc(label)}</td><td style="padding:6px 0;">${esc(value)}</td></tr>`;

const html =
  `<div style="font-family:Arial, Helvetica, sans-serif; color:#1f1a17; max-width:640px;">` +
  `<h2 style="margin:0 0 12px; color:#991b1b;">An automation failed</h2>` +
  `<p style="margin:0 0 8px;">A workflow stopped on an error that nothing handled, so work may not have finished.</p>` +
  `<p style="margin:0 0 16px;"><strong>Open the execution in n8n now. For the intake workflow, the failed execution still holds the original customer submission, and n8n deletes it after the retention period.</strong></p>` +
  `<table style="border-collapse:collapse; font-size:14px;">` +
  row('Workflow', workflowName) +
  row('Failed node', failedNode) +
  (executionId ? row('Execution', executionId) : '') +
  (mode ? row('Mode', mode) : '') +
  (errorText ? row('Error', errorText) : '') +
  (url ? row('Open in n8n', url) : '') +
  `</table>` +
  `<p style="margin-top:20px; font-size:11px; color:#9a9086;">No customer details are included in this message. Generated automatically by the AI Support Desk.</p></div>`;

const subject = `🚨 Automation failed: ${workflowName} (${failedNode})`.slice(0, 160);
return [{ json: { subject, html } }];
