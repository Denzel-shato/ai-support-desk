import { connection, NextResponse } from "next/server";
import { missingAuthSettings, readAuthConfig } from "@/lib/auth/config";
import { verifyPassword } from "@/lib/auth/password";
import { loginLimiter } from "@/lib/auth/rate-limit";
import {
  createSessionToken,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "@/lib/auth/session";
import { readJsonBody } from "@/lib/request-guard";
import { responseErrorResponse } from "@/lib/response-api-errors";
import { errorResponse, NO_STORE } from "@/lib/ticket-api-errors";

const GENERIC_FAILURE = "That username or password is not correct.";

/** A hash that never matches, so an unknown username still costs one scrypt. */
const DUMMY_HASH =
  "scrypt:16384:8:1:AAAAAAAAAAAAAAAAAAAAAA==:" + "A".repeat(86) + "==";

/**
 * The client address as the nearest proxy saw it. The LAST x-forwarded-for
 * entry is the one our own proxy appended; earlier entries are whatever the
 * client chose to send, so they must not decide the rate-limit key. Capped in
 * length because the value ends up in a Map key and a log line.
 */
function clientKey(request: Request): string {
  const parts = request.headers.get("x-forwarded-for")?.split(",") ?? [];
  const last = parts[parts.length - 1]?.trim();
  return (last || request.headers.get("x-real-ip") || "unknown").replace(/[^\w.:-]/g, "?").slice(0, 64);
}

/**
 * POST /api/auth/login   Body: { username, password }
 * Same-origin JSON only. Rate limited per client. The answer never says which
 * of the two was wrong. On success sets an httpOnly, SameSite=Lax session
 * cookie (Secure in production).
 */
export async function POST(request: Request) {
  await connection();
  try {
    const body = (await readJsonBody(request, { maxBytes: 4096 })) as Record<string, unknown> | null;

    const config = readAuthConfig();
    if (!config) {
      return errorResponse(
        503,
        "auth_not_configured",
        "Sign-in is not set up on the server. Add the authentication settings and restart.",
        { missing: missingAuthSettings() },
      );
    }

    const key = clientKey(request);
    const wait = loginLimiter.reserve(key, Date.now());
    if (wait > 0) {
      const res = errorResponse(
        429,
        "too_many_attempts",
        "Too many failed attempts. Wait a few minutes and try again.",
      );
      res.headers.set("Retry-After", String(wait));
      return res;
    }

    const username = typeof body?.username === "string" ? body.username : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!username || !password || password.length > 1024 || username.length > 200) {
      return errorResponse(400, "invalid_credentials_format", "Enter a username and password.");
    }

    const userOk = username === config.username;
    const passOk = await verifyPassword(password, userOk ? config.passwordHash : DUMMY_HASH);
    if (!userOk || !passOk) {
      console.warn(`[api/auth/login] failed sign-in attempt from ${key}`);
      return errorResponse(401, "invalid_credentials", GENERIC_FAILURE);
    }

    loginLimiter.recordSuccess(key);
    const token = await createSessionToken(config.username, config.signingKey);
    const res = NextResponse.json(
      { user: { username: config.username } },
      { status: 200, headers: NO_STORE },
    );
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
    return res;
  } catch (error) {
    return responseErrorResponse(error, "api/auth/login");
  }
}
