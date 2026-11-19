// n8n Code node "Build ticket"  (mode: Run Once for All Items)
//
// Produces EXACTLY ONE ticket per form submission and NEVER throws, so a Gemini
// or knowledge-base failure can no longer lose the customer's submission. The
// Gemini and Firestore-read nodes are set to "continue on error"; whatever
// they return is validated here.
//
// Rules (the dashboard applies the same ones: see approvalRequired in
// src/lib/overview.ts):
//  1. Priority and category must be one of the known values (case and spacing
//     are normalised; nothing else is accepted or guessed).
//  2. Only Low and Medium may be handled automatically. High, Urgent, missing
//     or invalid priority => human review.
//  3. Human review is ALSO required when the knowledge base does not cover the
//     issue (kbStatus "not_covered", or no active articles) or the model says
//     escalationRequired, and when classification or evaluation failed.
//  4. When a model step failed we store only what the customer submitted plus
//     `intakeIssue`. No classification and no customer response is invented.
//  5. An automatic answer is only possible when ALL of this holds: Low/Medium,
//     kbStatus "covered", escalationRequired false, no unsupported parts, no
//     intakeIssue, AND the GROUNDING block below verified every step against the
//     cited article. The email is then a fixed template filled with the ARTICLE's
//     own sentences: the model's prose is never emailed automatically (it is kept
//     as a draft for an agent). Otherwise escalationStatus is "required", which
//     sends the ticket to staff and sends the customer nothing. The original
//     submission is stored either way.
//  6. The document ID is DETERMINISTIC (see ticketIdFor): the same submission within the same hour
//     always maps to the same ID, so a double submit or a retried write cannot create two tickets.
//     `intakeExecutionId` lets the workflow tell "my own earlier attempt" from "someone else's".
// Cleaned, validated values (same labels as the form). Nothing reaches this node unless
// 'Validate submission' accepted it.
const form = $('Validate submission').first().json;

const PRIORITIES = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };
const CATEGORIES = {
  bug: 'Bug',
  'feature request': 'Feature Request',
  question: 'Question',
  other: 'Other',
};
const SENTIMENTS = { positive: 'Positive', neutral: 'Neutral', negative: 'Negative' };
const KB_STATUSES = {
  covered: 'covered',
  partially_covered: 'partially_covered',
  not_covered: 'not_covered',
};
const canon = (map, v) =>
  typeof v === 'string' ? (map[v.trim().toLowerCase().replace(/\s+/g, ' ')] ?? null) : null;

function modelObject(nodeName) {
  try {
    const raw = $(nodeName).first().json?.content?.parts?.[0]?.text;
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const obj = JSON.parse(cleaned);
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const list = (v) =>
  Array.isArray(v)
    ? v.filter((x) => typeof x === 'string' && x.trim())
    : typeof v === 'string' && v.trim()
      ? [v]
      : [];

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

// ---- deterministic ticket ID
// Pure-JS SHA-256: n8n's Code node does not allow require('crypto') unless the operator enables it.
function sha256Hex(text) {
  const bytes = [];
  const utf8 = unescape(encodeURIComponent(text));
  for (let i = 0; i < utf8.length; i++) bytes.push(utf8.charCodeAt(i));
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 0xff);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < bytes.length; off += 64) {
    const w = new Array(64);
    for (let i = 0; i < 16; i++) w[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
// Same customer email + same message text within the same clock hour => same ID. A bucket
// boundary can still let one repeat through; a genuinely new message always gets a new ID.
const ticketIdFor = (email, message, nowMs) =>
  'tk_' +
  sha256Hex(
    [String(email).trim().toLowerCase(), String(message).replace(/\s+/g, ' ').trim(), Math.floor(nowMs / 3600000)].join('\n'),
  ).slice(0, 32);

let kb = { articleCount: 0, kbUnavailable: true, articles: [] }; // unknown => treat as unavailable
try {
  kb = $('Select active articles').first().json ?? kb;
} catch {
  /* keep the safe default */
}

// ---- classification
const cls = modelObject('Message a model');
const priority = canon(PRIORITIES, cls?.priority);
const category = canon(CATEGORIES, cls?.category);
let intakeIssue = !cls
  ? 'classification_failed'
  : !priority || !category
    ? 'classification_invalid'
    : undefined;

// ---- knowledge-base evaluation
const noKnowledge = kb.kbUnavailable === true || !(kb.articleCount > 0);
const ev = modelObject('Message a model1');
const kbStatusRaw = canon(KB_STATUSES, ev?.kbStatus);
const evalUsable =
  !!ev &&
  !!kbStatusRaw &&
  typeof ev.escalationRequired === 'boolean' &&
  typeof ev.customerResponse === 'string' &&
  ev.customerResponse.trim().length > 0;

let kbFields;
if (noKnowledge) {
  // Nothing to answer from: the model's text (if any) is discarded.
  if (kb.kbUnavailable === true) intakeIssue = intakeIssue ?? 'knowledge_base_unavailable';
  kbFields = {
    kbStatus: 'not_covered',
    coverageReason:
      kb.kbUnavailable === true
        ? 'The knowledge base could not be read, so no automatic answer was given.'
        : 'There are no active knowledge-base articles, so this issue is not covered.',
    supportedSteps: [],
    unsupportedParts: [],
    escalationRequired: true,
  };
} else if (!cls || !evalUsable) {
  // No classification at all: the evaluation was made without one, so it is not used either.
  intakeIssue = intakeIssue ?? (ev ? 'evaluation_invalid' : 'evaluation_failed'); // classification_failed wins when set
  kbFields = {
    coverageReason: 'The knowledge-base evaluation did not complete, so no automatic answer was given.',
    supportedSteps: [],
    unsupportedParts: [],
    escalationRequired: true,
  };
} else {
  const notCovered = kbStatusRaw === 'not_covered';
  kbFields = {
    kbStatus: kbStatusRaw,
    relevantSection: notCovered ? null : (str(ev.relevantSection) ?? null),
    coverageReason: str(ev.coverageReason),
    // Never keep steps for an issue the knowledge base doesn't cover.
    supportedSteps: notCovered ? [] : list(ev.supportedSteps),
    unsupportedParts: list(ev.unsupportedParts),
    escalationRequired: notCovered ? true : ev.escalationRequired === true,
    customerResponse: ev.customerResponse.trim(),
  };
}

// ---- automatic-reply grounding (see the GROUNDING block above)
// Only a Low/Medium ticket with a complete, fully "covered" evaluation that asks for no escalation can be answered
// automatically, and only with sentences copied from the article it cites. Whatever the model wrote beyond that is
// kept as a draft for an agent and is never emailed to the customer.
const autoPriority = priority === 'Low' || priority === 'Medium';
let groundingIssue;
let autoReplyArticleId;
if (autoPriority && !intakeIssue && kbFields.escalationRequired === false) {
  let g;
  if (kbFields.kbStatus !== 'covered') g = { ok: false, code: 'not_fully_covered' };
  else if (list(ev.unsupportedParts).length) g = { ok: false, code: 'unsupported_parts_remain' };
  else {
    const r = GROUNDING.resolveArticle(ev.relevantArticleId, ev.relevantSection, kb.articles);
    g = r.ok ? GROUNDING.verify(r.article.id, r.article.title, list(ev.supportedSteps), kb.articles) : r;
  }
  if (g.ok) {
    kbFields.relevantSection = g.article.title;
    kbFields.supportedSteps = g.steps;
    kbFields.customerResponse = GROUNDING.render(g.article.title, g.steps);
    autoReplyArticleId = g.article.id;
  } else {
    groundingIssue = g.code;
    kbFields.escalationRequired = true;
    kbFields.supportedSteps = [];
    kbFields.relevantSection = null;
  }
}

// ---- routing: one decision
const humanReview =
  !autoPriority ||
  kbFields.escalationRequired === true ||
  kbFields.kbStatus === 'not_covered' ||
  !!intakeIssue ||
  !kbFields.customerResponse;

let escalationReason = 'Normal priority handling';
if (intakeIssue) {
  escalationReason = `Automatic processing did not complete (${intakeIssue}): manual handling required`;
} else if (priority === 'High' || priority === 'Urgent') {
  escalationReason = 'High-priority ticket requires faster attention';
} else if (!autoPriority) {
  escalationReason = 'Priority missing or invalid: human review required';
} else if (groundingIssue) {
  escalationReason = `Automatic reply blocked (${groundingIssue}): the answer could not be verified against the knowledge-base article, human review required`;
} else if (kbFields.kbStatus === 'not_covered' || kbFields.escalationRequired === true) {
  escalationReason = 'The knowledge base does not support an automatic answer: human review required';
} else if (!kbFields.customerResponse) {
  escalationReason = 'No response was generated: human review required';
}

const nowDate = new Date();
const now = nowDate.toISOString();
let executionId;
try {
  executionId = $execution.id === undefined || $execution.id === null ? undefined : String($execution.id);
} catch {
  executionId = undefined;
}
const ticket = {
  // Document ID for the Firestore node (not a stored column) and the run that built this ticket.
  ticketId: ticketIdFor(form['Your Email'], form['What is it you would like us to fix ?'], nowDate.getTime()),
  intakeExecutionId: executionId,

  // The customer's submission, always preserved exactly
  customerName: form['Your Name'],
  customerEmail: form['Your Email'],
  message: form['What is it you would like us to fix ?'],

  // Classification (only validated values)
  category: category ?? undefined,
  reason: cls ? str(cls.reason) : undefined,
  sentiment: cls ? canon(SENTIMENTS, cls.sentiment) ?? undefined : undefined,
  priority: priority ?? undefined,
  summary: cls ? str(cls.summary) : undefined,

  // Knowledge-base evaluation
  ...kbFields,

  // aiResponse kept for compatibility
  aiResponse: kbFields.customerResponse,

  status: 'pending_review',
  createdAt: now,

  escalationStatus: humanReview ? 'required' : 'not_required',
  escalationReason,
  // The dashboard recomputes approval from the same rule; this value is ignored for Low/Medium.
  reviewStatus: 'awaiting_review',
};
if (intakeIssue) ticket.intakeIssue = intakeIssue;
if (groundingIssue) ticket.groundingIssue = groundingIssue;
if (autoReplyArticleId) ticket.autoReplyArticleId = autoReplyArticleId;
if (humanReview) ticket.escalatedAt = now;

// Drop undefined keys so the Firestore node never receives them.
for (const k of Object.keys(ticket)) if (ticket[k] === undefined) delete ticket[k];

return [{ json: ticket }];
