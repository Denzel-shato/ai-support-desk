// n8n Code node "Prepare email fields"  (mode: Run Once for All Items)
//
// Customer and model text goes into HTML emails (some to staff), so it is
// HTML-escaped here once, and the templates only use `$json.safe.*`.
const t = $input.first().json;

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []);

const steps = list(t.supportedSteps);
const unsupported = list(t.unsupportedParts);
const cell = 'border-top:1px solid #ece6dc;';

const stepsHtml = steps.length
  ? steps
      .map(
        (s, i) =>
          `<tr><td width="40" style="vertical-align:top; padding:10px 0; ${cell} font-family:Georgia, serif; font-size:16px; color:#991b1b;">0${i + 1}</td>` +
          `<td style="vertical-align:top; padding:10px 0; ${cell} font-size:14px; line-height:1.65; color:#1f1a17;">${esc(s)}</td></tr>`,
      )
      .join('')
  : `<tr><td style="padding:10px 0; ${cell} font-size:14px; color:#4a423b;">None identified.</td></tr>`;

return [
  {
    json: {
      ...t,
      safe: {
        customerName: esc(t.customerName),
        customerEmail: esc(t.customerEmail),
        message: esc(t.message),
        category: esc(t.category),
        priority: esc(t.priority),
        sentiment: esc(t.sentiment),
        summary: esc(t.summary),
        kbStatus: esc(t.kbStatus),
        relevantSection: esc(t.relevantSection ?? 'None'),
        coverageReason: esc(t.coverageReason),
        escalationReason: esc(t.escalationReason),
        escalationStatus: esc(t.escalationStatus),
        customerResponse: esc(t.customerResponse),
        stepsHtml,
        unsupportedHtml: unsupported.length ? unsupported.map(esc).join('<br>') : 'None identified.',
        // Plain text for the subject line: no control characters or line breaks.
        subjectName: String(t.customerName ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80),
      },
    },
  },
];
