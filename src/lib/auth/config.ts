import { secretIsUsable } from "./session";

export const AUTH_ENV = {
  username: "AUTH_USERNAME",
  passwordHash: "AUTH_PASSWORD_HASH",
  sessionSecret: "AUTH_SESSION_SECRET",
} as const;

export interface AuthConfig {
  username: string;
  passwordHash: string;
  sessionSecret: string;
  /**
   * What session tokens are actually signed with: the secret combined with the
   * password hash. Changing the password therefore signs every existing
   * session out, which is the only revocation this single-account setup has.
   */
  signingKey: string;
}

/** Names (never values) of settings that are missing or unusable. */
export function missingAuthSettings(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const missing: string[] = [];
  if (!env[AUTH_ENV.username]?.trim()) missing.push(AUTH_ENV.username);
  if (!env[AUTH_ENV.passwordHash]?.trim().startsWith("scrypt:")) {
    missing.push(AUTH_ENV.passwordHash);
  }
  if (!secretIsUsable(env[AUTH_ENV.sessionSecret]?.trim())) {
    missing.push(AUTH_ENV.sessionSecret);
  }
  return missing;
}

/** The settings, or null when authentication is not fully configured. */
export function readAuthConfig(
  env: Record<string, string | undefined> = process.env,
): AuthConfig | null {
  if (missingAuthSettings(env).length) return null;
  const passwordHash = env[AUTH_ENV.passwordHash]!.trim();
  const sessionSecret = env[AUTH_ENV.sessionSecret]!.trim();
  return {
    username: env[AUTH_ENV.username]!.trim(),
    passwordHash,
    sessionSecret,
    signingKey: `${sessionSecret}\n${passwordHash}`,
  };
}
