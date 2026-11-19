// n8n Code node "Deployment config"  (mode: Run Once for All Items)
//
// The ONLY place the two deployment-specific values live:
//   escalationInbox  the staff inbox that receives escalation AND rescue emails
//   rateLimitSalt    secret mixed into every stored rate-limit hash
//
// This file ships with PLACEHOLDERS on purpose. Nothing in Git may hold a real inbox or a real secret.
// The operator replaces both values inside the imported workflow in the n8n editor (see
// docs/n8n-deployment-config.md). The placeholders are never valid: this node refuses them, and so does
// every node that uses them, so a freshly imported or half-configured workflow cannot process anything.
//
// Why a Code node and not `$env`: n8n 2.x can block environment-variable access in Code nodes and in
// expressions (N8N_BLOCK_ENV_ACCESS_IN_NODE, and task runners isolate the environment), so the workflow
// must not depend on it. If you have confirmed `$env` works on YOUR instance you may put
// `$env.YOUR_VARIABLE` in place of a literal below; the validation still applies to whatever comes out.
//
// Outputs (the form submission passes through unchanged, plus `deployment`):
//   ok            true only when BOTH values are valid
//   errors        machine-readable problem codes only; a bad value is never echoed
//   escalationInbox / rateLimitSalt   the values, ONLY when ok (empty strings otherwise)
//   formSubmittedText   what the visitor sees when the deployment is misconfigured
const CONFIG = {
  escalationInbox: 'REPLACE_WITH_ESCALATION_INBOX@example.com',
  rateLimitSalt: 'CHANGE-ME-TO-A-LONG-RANDOM-STRING',
};

const PLACEHOLDER_PATTERN = /replace[-_ ]?with|change[-_ ]?me|placeholder|your[-_ ]?(salt|secret|email|inbox|address)/i;

// ---- BEGIN salt validator (identical in 'Deployment config' and 'Prepare rate limit'; a test enforces this)
function saltProblems(value) {
  if (typeof value !== 'string' || value.trim() === '') return ['rate_limit_salt_missing'];
  if (PLACEHOLDER_PATTERN.test(value)) return ['rate_limit_salt_placeholder'];
  // Printable ASCII with no spaces: what `openssl rand -hex 32` / `-base64 48` produce. No template or markup characters.
  if (!/^[\x21-\x7e]+$/.test(value) || /[{}<>]/.test(value)) return ['rate_limit_salt_invalid_characters'];
  const problems = [];
  if (value.length < 32 || value.length > 256) problems.push('rate_limit_salt_length');
  if (new Set(value).size < 8) problems.push('rate_limit_salt_low_variety');
  return problems;
}
// ---- END salt validator

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

const errors = [...inboxProblems(CONFIG.escalationInbox), ...saltProblems(CONFIG.rateLimitSalt)];
const ok = errors.length === 0;

return [
  {
    json: {
      ...$input.first().json,
      deployment: {
        ok,
        errors,
        formSubmittedText: "We couldn't process your request right now. Please try again in a little while.",
        escalationInbox: ok ? CONFIG.escalationInbox : '',
        rateLimitSalt: ok ? CONFIG.rateLimitSalt : '',
      },
    },
  },
];
