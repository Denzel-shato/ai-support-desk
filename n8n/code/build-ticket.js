// n8n Code node "Build ticket"  (mode: Run Once for All Items)
//
// Produces EXACTLY ONE normalized ticket per form submission, including the
// priority routing fields, so the workflow needs ONE Firestore create and no
// later "update" step (which is what made the old update key inconsistent).
//
// Reads the form and both model outputs with .first(): by this point there is
// a single item on every path, and .first() does not depend on n8n's
// item-pairing, which a Code node in "all items" mode doesn't preserve.
const form = $('Form Trigger').first().json;

function readModelJson(label, nodeName) {
  const raw = $(nodeName).first().json?.content?.parts?.[0]?.text;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error(`${label}: the model returned no text`);
  }
  // Tolerate a Markdown fence even though the prompt forbids one.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`${label}: the model's answer is not valid JSON`);
  }
}

const classification = readModelJson('Classification', 'Message a model');
const evaluation = readModelJson('Knowledge-base evaluation', 'Message a model1');

const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []);

// Same routing rule as before: High and Urgent are escalated.
const escalate = classification.priority === 'High' || classification.priority === 'Urgent';
const now = new Date().toISOString();

const ticket = {
  // Customer details
  customerName: form['Your Name'],
  customerEmail: form['Your Email'],
  message: form['What is it you would like us to fix ?'],

  // Original ticket classification
  category: classification.category,
  reason: classification.reason,
  sentiment: classification.sentiment,
  priority: classification.priority,
  summary: classification.summary,

  // Knowledge-base evaluation
  kbStatus: evaluation.kbStatus,
  relevantSection: evaluation.relevantSection ?? null,
  coverageReason: evaluation.coverageReason,
  supportedSteps: list(evaluation.supportedSteps),
  unsupportedParts: list(evaluation.unsupportedParts),
  escalationRequired: evaluation.escalationRequired === true,

  // Customer-facing response (aiResponse kept for compatibility)
  customerResponse: evaluation.customerResponse,
  aiResponse: evaluation.customerResponse,

  // Ticket management
  status: 'pending_review',
  createdAt: now,

  // Priority routing, decided once, here
  escalationStatus: escalate ? 'required' : 'not_required',
  escalationReason: escalate ? 'High-priority ticket requires faster attention' : 'Normal priority handling',
  // The dashboard decides whether approval is needed from the PRIORITY, so this
  // value is ignored for Low/Medium tickets (as it already was).
  reviewStatus: 'awaiting_review',
};
if (escalate) ticket.escalatedAt = now;

return [{ json: ticket }];
