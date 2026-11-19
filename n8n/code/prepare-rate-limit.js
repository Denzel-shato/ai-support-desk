// n8n Code node "Prepare rate limit"  (mode: Run Once for All Items)
//
// Runs only for submissions that passed 'Validate submission'. Works out WHO is submitting
// (trusted IP header, normalised email), turns that into salted hashes, and lists the checks to
// claim in order. Raw IP addresses and emails are never written anywhere.
const S = $('Rate limit settings').first().json.settings;
const form = $('Form Trigger').first().json ?? {};
const email = String($('Validate submission').first().json['Your Email'] ?? '');

// ---- pure-JS SHA-256 (the Code node allows no built-in modules unless the operator enables them).
// Identical to the function in 'Build ticket'.
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

const num = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.floor(Number(v)))) : dflt);

// ---- trusted client IP (or null)
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function cleanIp(raw) {
  const s = String(raw ?? '').trim().replace(/^\[|\]$/g, '');
  const m = IPV4.exec(s);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((n) => n > 255)) return null;
    const [a, b] = o;
    // Private, loopback, link-local, CGNAT and "this network" are never a real client: a proxy that
    // reports one is misconfigured, so the source is treated as unknown instead of sharing a bucket.
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return null;
    return o.join('.');
  }
  if (/^[0-9a-f:.]+$/i.test(s) && s.includes(':') && !s.includes(':::')) {
    const lower = s.toLowerCase();
    if (lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)) return null;
    const halves = lower.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
    const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
    if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
    return groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':') + '::/64';
  }
  return null;
}
function sourceIp() {
  const header = String(S.ipSource?.header ?? '').toLowerCase().trim();
  if (!header) return null;
  const headers = form.headers && typeof form.headers === 'object' ? form.headers : {};
  const value = headers[header];
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts = value.split(',').map((p) => p.trim()).filter(Boolean);
  const hops = num(S.ipSource?.trustedProxyHops, 1, 10, 1);
  if (parts.length < hops) return null; // fewer entries than trusted proxies: cannot be ours
  return cleanIp(parts[parts.length - hops]);
}

// ---- normalised email: lower-case, drop +tag, drop dots for Gmail
function normEmail(e) {
  const v = e.trim().toLowerCase();
  const at = v.lastIndexOf('@');
  if (at < 1) return v;
  let local = v.slice(0, at).split('+')[0];
  let domain = v.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

const nowMs = Date.now();
// At least 5 minutes: a slot can never expire (and be deleted by the TTL policy) while the request that
// holds it is still running or releasing it.
const grace = num(S.retentionGraceSeconds, 300, 7 * 86400, 3600);
const hash = (kind, value) => sha256Hex(`${S.salt}|${kind}|${value}`).slice(0, 24);

const ip = sourceIp();
// ORDER MATTERS. Narrow checks (this source, this email) are claimed first and the global flood cap LAST, so a
// submission refused by a narrow limit never touches global capacity. If a later check refuses, the slots
// already held are released again ('Plan release'), so a refusal costs nobody anything.
const defs = [];
if (S.checks?.ip?.enabled !== false) {
  defs.push(ip ? { kind: 'ip', key: hash('ip', ip), cfg: S.checks.ip } : { kind: 'unknown', key: 'all', cfg: S.checks.unknownIp });
}
if (S.checks?.email?.enabled !== false) defs.push({ kind: 'email', key: hash('email', normEmail(email)), cfg: S.checks.email });
if (S.checks?.global?.enabled !== false) defs.push({ kind: 'global', key: 'all', cfg: S.checks.global });

let executionId = '';
try {
  executionId = String($execution.id ?? '');
} catch {
  /* not available */
}
// Identifies THIS submission's claims. Stored in every slot it creates; a release only deletes a slot whose
// stored claimId matches, so one submission can never give back another's slot.
const claimId = sha256Hex(`${S.salt}|claim|${nowMs}|${executionId}|${Math.random()}|${Math.random()}`).slice(0, 32);

const checks = defs.map(({ kind, key, cfg }) => {
  const limit = num(cfg?.limit, 1, 20, 3);
  const windowSeconds = num(cfg?.windowSeconds, 10, 86400, 3600);
  const windowId = Math.floor(nowMs / 1000 / windowSeconds);
  return { kind, key, limit, windowSeconds, windowId, expireAt: new Date((windowId + 1) * windowSeconds * 1000 + grace * 1000).toISOString() };
});

return [
  {
    json: {
      rl: {
        checks,
        idx: 0,
        slot: 1,
        errors: 0,
        nowIso: new Date(nowMs).toISOString(),
        failMode: S.failMode === 'open' ? 'open' : 'closed',
        messages: S.messages,
        sourceKnown: ip !== null,
        degraded: false,
        claimId,
        held: [],
      },
    },
  },
];
