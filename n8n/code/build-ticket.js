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
//     kbStatus covered or partially_covered, escalationRequired false, no
//     intakeIssue, and a response exists. Otherwise escalationStatus is
//     "required", which sends the ticket to staff and sends the customer nothing.
const form = $('Form Trigger').first().json;

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

let kb = { articleCount: 0, kbUnavailable: true }; // unknown => treat as unavailable
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

// ---- routing: one decision
const autoPriority = priority === 'Low' || priority === 'Medium';
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
} else if (kbFields.kbStatus === 'not_covered' || kbFields.escalationRequired === true) {
  escalationReason = 'The knowledge base does not support an automatic answer: human review required';
} else if (!kbFields.customerResponse) {
  escalationReason = 'No response was generated: human review required';
}

const now = new Date().toISOString();
const ticket = {
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
if (humanReview) ticket.escalatedAt = now;

// Drop undefined keys so the Firestore node never receives them.
for (const k of Object.keys(ticket)) if (ticket[k] === undefined) delete ticket[k];

return [{ json: ticket }];
