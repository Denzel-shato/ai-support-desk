import "server-only";

import { readAuthConfig, missingAuthSettings } from "./config";
import { readCookie, SESSION_COOKIE, verifySessionToken, type SessionPayload } from "./session";

/** Thrown by requireAuth. The error mappers turn it into a JSON 401 or 503. */
export class AuthError extends Error {
  readonly status: 401 | 503;
  readonly code: string;
  readonly missing: string[];

  constructor(status: 401 | 503, code: string, message: string, missing: string[] = []) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
    this.missing = missing;
  }
}

/**
 * Call first in EVERY API route handler, before reading the body or touching
 * Firestore. Fails closed: when authentication isn't configured, nothing is
 * served (503), never "open by default".
 */
export async function requireAuth(
  request: Request,
  env: Record<string, string | undefined> = process.env,
  nowMs: number = Date.now(),
): Promise<SessionPayload> {
  const config = readAuthConfig(env);
  if (!config) {
    throw new AuthError(
      503,
      "auth_not_configured",
      "Sign-in is not set up on the server, so the dashboard is locked. Add the authentication settings and restart.",
      missingAuthSettings(env),
    );
  }
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  const session = await verifySessionToken(token, config.signingKey, nowMs);
  if (!session || session.sub !== config.username) {
    throw new AuthError(401, "unauthenticated", "Sign in to continue.");
  }
  return session;
}
