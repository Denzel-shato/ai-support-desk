/**
 * Signed session tokens. Uses only Web Crypto, so the same code runs in the
 * route handlers, in proxy.ts and in tests.
 *
 * Token = base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload)).
 * The cookie is httpOnly, so the browser's JavaScript never sees it.
 */

export const SESSION_COOKIE = "asd_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
export const MIN_SECRET_LENGTH = 32;

export interface SessionPayload {
  /** The signed-in username. */
  sub: string;
  /** Issued at / expires at, in seconds since the epoch. */
  iat: number;
  exp: number;
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export function secretIsUsable(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

export async function createSessionToken(
  username: string,
  secret: string,
  nowMs: number = Date.now(),
  ttlSeconds: number = SESSION_TTL_SECONDS,
): Promise<string> {
  if (!secretIsUsable(secret)) throw new Error("Session secret is too short.");
  const iat = Math.floor(nowMs / 1000);
  const payload: SessionPayload = { sub: username, iat, exp: iat + ttlSeconds };
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body)),
  );
  return `${body}.${toBase64Url(sig)}`;
}

/** The payload when the token is genuine and unexpired, otherwise null. */
export async function verifySessionToken(
  token: string | null | undefined,
  secret: string | undefined,
  nowMs: number = Date.now(),
): Promise<SessionPayload | null> {
  if (!token || !secretIsUsable(secret) || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const sigBytes = fromBase64Url(sig);
  if (!sigBytes) return null;

  const ok = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    sigBytes as BufferSource,
    encoder.encode(body),
  );
  if (!ok) return null;

  const raw = fromBase64Url(body);
  if (!raw) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(raw)) as Partial<SessionPayload>;
    if (
      typeof p.sub !== "string" ||
      !p.sub ||
      typeof p.iat !== "number" ||
      typeof p.exp !== "number"
    ) {
      return null;
    }
    const now = Math.floor(nowMs / 1000);
    if (p.exp <= now || p.iat > now + 60) return null;
    return { sub: p.sub, iat: p.iat, exp: p.exp };
  } catch {
    return null;
  }
}

/** Reads one cookie from a Cookie header. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
