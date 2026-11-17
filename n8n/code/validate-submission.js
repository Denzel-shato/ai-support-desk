// n8n Code node "Validate submission"  (mode: Run Once for All Items)
//
// The FIRST step after the public Form Trigger, before Gemini, Firestore or
// Gmail. This is the only place the submission is really checked: the form's
// own "required" and "email" settings are enforced by the visitor's browser
// and can be bypassed by posting directly to the form URL.
//
// Output: ONE item.
//   valid: true  -> the cleaned values under the SAME field labels as the form,
//                   so downstream nodes read them from here, not from the raw form.
//   valid: false -> only `errors` (field + code, never the submitted text), and
//                   no values, so rejected content can't flow anywhere.
const MAX_NAME = 100;
const MAX_EMAIL = 254;
const MAX_MESSAGE = 5000;

const NAME = 'Your Name';
const EMAIL = 'Your Email';
const MESSAGE = 'What is it you would like us to fix ?';

const form = $('Form Trigger').first().json ?? {};
const errors = [];

// Control characters (incl. line breaks) have no place in a name or an address,
// and a line break in an address is how mail-header injection is attempted.
const CONTROL = /[\u0000-\u001f\u007f]/;

function field(label, key, max, { allowNewlines }) {
  const raw = form[label];
  if (raw === undefined || raw === null) {
    errors.push({ field: key, code: 'missing' });
    return null;
  }
  if (typeof raw !== 'string') {
    errors.push({ field: key, code: 'not_text' });
    return null;
  }
  let v = raw.replace(/\r\n?/g, '\n');
  if (!allowNewlines) {
    if (CONTROL.test(v)) {
      errors.push({ field: key, code: 'invalid_characters' });
      return null;
    }
    v = v.replace(/\s+/g, ' ');
  } else {
    // Keep line breaks and tabs in a message, drop every other control character.
    v = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  }
  v = v.trim();
  if (!v) {
    errors.push({ field: key, code: 'empty' });
    return null;
  }
  if (v.length > max) {
    errors.push({ field: key, code: 'too_long', max });
    return null;
  }
  return v;
}

const name = field(NAME, 'name', MAX_NAME, { allowNewlines: false });
const email = field(EMAIL, 'email', MAX_EMAIL, { allowNewlines: false });
const message = field(MESSAGE, 'message', MAX_MESSAGE, { allowNewlines: true });

// A practical address check (not full RFC 5322): one "@", a dotted domain,
// no spaces and none of , ; < > ( ) " \ in it.
if (email !== null) {
  const at = email.indexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const ok =
    at > 0 &&
    at === email.lastIndexOf('@') &&
    local.length <= 64 &&
    !/[\s,;<>()"\\]/.test(email) &&
    /^[^.][^\s]*\.[^.\s]+$/.test(domain) &&
    !domain.includes('..') &&
    !local.startsWith('.') &&
    !local.endsWith('.') &&
    !local.includes('..') &&
    !domain.split('.').some((p) => !p || p.startsWith('-') || p.endsWith('-'));
  if (!ok) errors.push({ field: 'email', code: 'invalid_format' });
}

if (errors.length) return [{ json: { valid: false, errors } }];

return [{ json: { valid: true, errors: [], [NAME]: name, [EMAIL]: email, [MESSAGE]: message } }];
