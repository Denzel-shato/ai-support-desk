// n8n Code node "Prepare email fields"  (mode: Run Once for All Items)
//
// Customer and model text goes into HTML emails (some to staff), so it is
// HTML-escaped here once, and the templates only use `$json.safe.*`.
//
// SECOND, independent gate for the automatic customer email: this node re-verifies the stored steps against the
// article text from 'Select active articles' and builds the email text itself from the fixed template
// (`safe.autoReplyText`). If anything does not verify, the ticket is routed to staff instead and the customer
// email's text is empty. The customer email never prints the model's `customerResponse`.
const t = $input.first().json;
// The Create node normally returns `_id`; when this item came from the duplicate-recovery path
// it did not, so fall back to the deterministic ticket ID from 'Build ticket'.
let ticketId = t._id ?? t.id ?? t.ticketId;
if (ticketId === undefined) {
  try {
    ticketId = $('Build ticket').first().json.ticketId;
  } catch {
    /* leave undefined */
  }
}

// ---- BEGIN GROUNDING (byte-identical in 'Build ticket' and 'Prepare email fields'; a test enforces it)
// An automatic customer email is NEVER written by the model. It is assembled here from a fixed template and
// sentences copied word for word from a knowledge-base article that staff wrote. A step the model proposes is
// accepted only when it can be located inside the article it cites, and what is emailed is the ARTICLE's wording,
// never the model's. Anything that cannot be verified, or that could carry a link or address, needs a human.
const GROUNDING = (() => {
  const MAX_STEPS = 8;
  const MAX_UNIT = 400;
  const MIN_STEP = 12;
  const UNSAFE = /https?:|ftp:|www\.|mailto:|javascript:|\bdata:|[a-z0-9-]+\.[a-z]{2,}(?:\/|\b)|@|\]\(|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/i;
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const cleanLine = (l) => String(l).replace(/^\s*(?:#{1,6}\s+|[-*+•]\s+|\d+[.)]\s+)/, '').replace(/[*_`~]+/g, '').replace(/\s+/g, ' ').trim();
  const unitsOf = (content) => {
    const seen = new Set();
    const out = [];
    const add = (t) => {
      if (!t || t.length > MAX_UNIT) return;
      const n = norm(t);
      if (!n || seen.has(n)) return;
      seen.add(n);
      out.push({ text: t, n });
    };
    for (const raw of String(content ?? '').split(/\r?\n/)) {
      const line = cleanLine(raw);
      add(line);
      const parts = line.split(/(?<=[.!?])\s+/);
      if (parts.length > 1) for (const p of parts) add(p.trim());
    }
    return out;
  };
  // The shortest article sentence/line that contains the step and that the step substantially covers.
  const ground = (step, units) => {
    const ns = norm(step);
    if (ns.length < MIN_STEP) return null;
    let best = null;
    for (const u of units) {
      if ((' ' + u.n + ' ').includes(' ' + ns + ' ') && ns.length * 2 >= u.n.length && (!best || u.n.length < best.n.length)) best = u;
    }
    return best;
  };
  const resolveArticle = (articleId, title, articles) => {
    const list = Array.isArray(articles) ? articles.filter((a) => a && typeof a.id === 'string' && a.id && typeof a.title === 'string' && typeof a.content === 'string') : [];
    if (articleId !== undefined && articleId !== null && typeof articleId !== 'string') return { ok: false, code: 'article_mismatch' };
    const id = typeof articleId === 'string' ? articleId.trim() : '';
    const t = typeof title === 'string' ? norm(title) : '';
    if (id) {
      const hit = list.filter((a) => a.id === id);
      if (hit.length !== 1) return { ok: false, code: 'article_not_found' };
      if (t && norm(hit[0].title) !== t) return { ok: false, code: 'article_mismatch' };
      return { ok: true, article: hit[0] };
    }
    if (t) {
      const hit = list.filter((a) => norm(a.title) === t);
      if (hit.length === 0) return { ok: false, code: 'article_not_found' };
      if (hit.length > 1) return { ok: false, code: 'ambiguous_article' };
      return { ok: true, article: hit[0] };
    }
    return { ok: false, code: 'article_not_cited' };
  };
  const verify = (articleId, title, steps, articles) => {
    const r = resolveArticle(articleId, title, articles);
    if (!r.ok) return r;
    const a = r.article;
    if (!norm(a.title) || a.title.length > 150 || UNSAFE.test(a.title)) return { ok: false, code: 'unsafe_title' };
    const given = Array.isArray(steps) ? steps : [];
    if (!given.length || given.length > MAX_STEPS || given.some((s) => typeof s !== 'string')) return { ok: false, code: 'no_steps' };
    const units = unitsOf(a.content);
    const out = [];
    for (const s of given) {
      const u = ground(s, units);
      if (!u) return { ok: false, code: 'step_not_in_article' };
      if (UNSAFE.test(u.text)) return { ok: false, code: 'unsafe_text' };
      if (!out.includes(u.text)) out.push(u.text);
    }
    return { ok: true, article: a, steps: out };
  };
  // Only a plain first name may appear in a greeting; the submitted name is otherwise untrusted text.
  const firstName = (name) => {
    const f = String(name ?? '').trim().split(/\s+/)[0] ?? '';
    if (!/^[\p{L}\p{M}][\p{L}\p{M}'’-]{0,29}$/u.test(f)) return '';
    // Name-Case only (Ada, Mary-Jane, O'Neil): ALL-CAPS words and mid-word capitals are not used as a greeting.
    return /\p{Lu}/u.test(f.replace(/[-'’]\p{Lu}/gu, '-').slice(1)) ? '' : f;
  };
  const render = (title, steps) =>
    'We found guidance in our knowledge base that may help with your request.\n\nArticle: ' + title + '\n\n' +
    steps.map((s, i) => `${i + 1}. ${s}`).join('\n') +
    '\n\nThese steps are general guidance and may not resolve your issue.';
  return { verify, resolveArticle, firstName, render, UNSAFE };
})();
// ---- END GROUNDING

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []);

let articles = [];
try {
  const kb = $('Select active articles').first().json;
  if (Array.isArray(kb?.articles)) articles = kb.articles;
} catch {
  /* no article data: nothing can be verified, so nothing is sent automatically */
}
let auto = { ok: false, code: 'not_attempted' };
if (t.escalationStatus !== 'required') {
  const prio = String(t.priority ?? '');
  if (prio !== 'Low' && prio !== 'Medium') auto = { ok: false, code: 'priority_not_automatic' };
  else if (t.kbStatus !== 'covered') auto = { ok: false, code: 'not_fully_covered' };
  else if (!(t.escalationRequired === false || t.escalationRequired === 'false')) auto = { ok: false, code: 'escalation_required' };
  else if (t.intakeIssue) auto = { ok: false, code: 'intake_issue' };
  else if (typeof t.autoReplyArticleId !== 'string' || !t.autoReplyArticleId) auto = { ok: false, code: 'article_not_cited' };
  else auto = GROUNDING.verify(t.autoReplyArticleId, t.relevantSection, Array.isArray(t.supportedSteps) ? t.supportedSteps : [], articles);
}
const blocked = t.escalationStatus !== 'required' && !auto.ok;
const effective = blocked
  ? { ...t, escalationStatus: 'required', escalationReason: `Automatic reply blocked (${auto.code}): human review required` }
  : t;
const autoText = auto.ok ? GROUNDING.render(auto.article.title, auto.steps) : '';
const firstName = GROUNDING.firstName(t.customerName);

const steps = list(t.supportedSteps);
const unsupported = list(t.unsupportedParts);
const na = (v) => (v === undefined || v === null || v === '' ? 'Not available' : v);
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
      ...effective,
      _id: ticketId,
      safe: {
        customerName: esc(t.customerName),
        customerEmail: esc(t.customerEmail),
        message: esc(t.message),
        category: esc(na(t.category)),
        priority: esc(na(t.priority)),
        sentiment: esc(na(t.sentiment)),
        summary: esc(na(t.summary)),
        kbStatus: esc(na(t.kbStatus)),
        relevantSection: esc(t.relevantSection ?? 'None'),
        coverageReason: esc(na(t.coverageReason)),
        escalationReason: esc(effective.escalationReason),
        escalationStatus: esc(effective.escalationStatus),
        customerResponse: esc(t.customerResponse),
        // The ONLY text the customer email prints as the answer: empty unless the grounding gate passed.
        autoReplyText: esc(autoText),
        // The only part of the submitted name that may appear in a customer email.
        greeting: firstName ? `Hello ${esc(firstName)},` : 'Hello,',
        stepsHtml,
        unsupportedHtml: unsupported.length ? unsupported.map(esc).join('<br>') : 'None identified.',
        // Plain text for the subject line. Priority is only ever a validated value; "Unknown" when missing.
        subjectPriority: /^(Low|Medium|High|Urgent)$/.test(String(t.priority ?? '')) ? t.priority : 'Unknown',
        // Plain text for the subject line: no control characters or line breaks.
        subjectName: String(t.customerName ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80),
      },
    },
  },
];
