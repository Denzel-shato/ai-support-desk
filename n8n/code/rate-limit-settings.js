// n8n Code node "Rate limit settings"  (mode: Run Once for All Items)
//
// EVERY tunable value of the rate limiter lives here and nowhere else. Edit this object,
// nothing else in the workflow needs to change. Values outside the bounds below are clamped
// by 'Prepare rate limit' (limit 1-20 per window, window 10 s - 24 h).
//
// How a limit works: each submission must CLAIM one numbered slot (1..limit) for its source in
// the current fixed time window. A slot is a Firestore document created with "create", which
// fails if it already exists, so two simultaneous submissions can never both get the same slot
// and at most `limit` submissions per source per window can succeed.
const SETTINGS = {
  // What to do when the limiter itself cannot be reached (Firestore error other than "slot taken"):
  //   'closed' = refuse the submission, tell the visitor to try later, and email the staff inbox the
  //              submission so nothing is lost (a documented security decision: never silently bypass).
  //   'open'   = let the submission through unlimited. Only choose this if losing the limit is
  //              worse for you than abuse getting through while Firestore is failing.
  failMode: 'closed',

  // Mixed into every stored key so the stored hashes can't be reversed by guessing IP addresses or
  // emails. REPLACE WITH A LONG RANDOM STRING and keep it secret; changing it resets all counters.
  salt: 'CHANGE-ME-TO-A-LONG-RANDOM-STRING',

  // Where the visitor's IP comes from. The Form Trigger exposes request HEADERS only (no socket address),
  // and anyone can send any header themselves, so this is trustworthy ONLY when your own reverse proxy /
  // tunnel appends the real client address to this header and n8n is not reachable any other way.
  //   header: lower-case header name. 'x-forwarded-for' (list; proxies append), 'cf-connecting-ip'
  //           (Cloudflare, single value) or 'x-real-ip'. '' = no trusted source: everyone is "unknown".
  //   trustedProxyHops: for a list header, how many entries from the RIGHT were added by YOUR proxies.
  //           1 = take the last entry (one proxy). Entries further left are client-supplied and ignored.
  ipSource: { header: 'x-forwarded-for', trustedProxyHops: 1 },

  // Each check: enabled, limit (submissions) per windowSeconds. Fixed windows aligned to the clock.
  checks: {
    // Everyone together: stops floods (incl. ones that fake the IP header or rotate emails) from running up
    // Gemini/Firestore cost. Only a sustained 20+ per minute trips it.
    global: { enabled: true, limit: 20, windowSeconds: 60 },
    // Per source IP (IPv6 counted per /64). Generous because offices, schools and mobile carriers put many
    // real people behind one address.
    ip: { enabled: true, limit: 10, windowSeconds: 3600 },
    // Used instead of `ip` when no trustworthy IP is available: all such visitors share this one bucket.
    unknownIp: { limit: 20, windowSeconds: 3600 },
    // Per normalised email (lower-case, +tag removed, Gmail dots removed). A person rarely needs more than 3
    // support requests an hour.
    email: { enabled: true, limit: 3, windowSeconds: 3600 },
  },

  // Stored limiter documents get an `expireAt` this long after their window ends. Enable a Firestore TTL
  // policy on collection group `rate_limits`, field `expireAt`, so they are deleted automatically.
  retentionGraceSeconds: 3600,

  // Exactly what the visitor sees (the form shows this text). They deliberately reveal no limits or reasons.
  messages: {
    received:
      'Thank you. Your request has been submitted and is now being processed. If you do not hear from us, please contact us again.',
    invalid: "We couldn't accept your request. Please check your name, email address and message, then try again.",
    limited: "You've sent several requests recently, so we can't accept another one right now. Please try again later.",
    unavailable: "We couldn't process your request right now. Please try again in a little while.",
  },
};

// Pass the incoming item through unchanged; later nodes read SETTINGS from here.
return [{ json: { ...$input.first().json, settings: SETTINGS } }];
