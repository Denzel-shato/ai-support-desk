// n8n Code node "Alert config"  (mode: Run Once for All Items)   [workflow: AI Support Desk failure alert]
//
// The ONLY deployment-specific value of the failure-alert workflow: the staff inbox that receives failure alerts.
// It is a separate workflow (n8n runs an error workflow on its own), so it cannot read the intake workflow's
// 'Deployment config' node; set the SAME inbox here (docs/n8n-failure-alerts.md). Like that node, this one ships a
// PLACEHOLDER on purpose and fails closed: while the value is a placeholder, missing or invalid this node THROWS, so
// the alert run fails visibly and nothing is ever sent to a placeholder address. A bad value is never echoed.
// Nothing in Git may hold a real address; set it inside the imported workflow in the n8n editor.
const CONFIG = {
  alertInbox: 'REPLACE_WITH_ESCALATION_INBOX@example.com',
};

const PLACEHOLDER_PATTERN = /replace[-_ ]?with|change[-_ ]?me|placeholder|your[-_ ]?(salt|secret|email|inbox|address)/i;

// One plain mailbox: no display name, no list, no whitespace or line breaks, and never a reserved
// example/test domain (RFC 2606 / 6761), which is what the shipped placeholder uses.
const RESERVED_DOMAIN = /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost)$/i;
const EMAIL_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`|~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`|~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
function inboxProblems(value) {
  if (typeof value !== 'string' || value.trim() === '') return ['escalation_inbox_missing'];
  if (PLACEHOLDER_PATTERN.test(value)) return ['escalation_inbox_placeholder'];
  if (value.length > 254 || value.split('@')[0].length > 64 || !EMAIL_PATTERN.test(value)) return ['escalation_inbox_invalid'];
  if (RESERVED_DOMAIN.test(value.slice(value.lastIndexOf('@') + 1))) return ['escalation_inbox_placeholder'];
  return [];
}

const errors = inboxProblems(CONFIG.alertInbox);
if (errors.length > 0) throw new Error(`Failure alert not sent: invalid alert inbox configuration (${errors.join(', ')})`);
return [{ json: { ...$input.first().json, alertInbox: CONFIG.alertInbox } }];
