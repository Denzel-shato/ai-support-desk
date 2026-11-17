# Authentication: deployment assumptions and accepted limitations

Scope: one shared admin account (`AUTH_USERNAME` / `AUTH_PASSWORD_HASH` / `AUTH_SESSION_SECRET`).

## What the code assumes about the host
- **HTTPS in production.** The session cookie is `Secure` (HttpOnly, SameSite=Lax). Over plain `http://` in production the browser drops it and sign-in appears to do nothing. Local `next dev` is unaffected.
- **`x-forwarded-for`.** The login limiter keys on the LAST entry, i.e. the address your own proxy appended. On Vercel this header is overwritten with the real client IP and client-supplied values are not forwarded ([Vercel docs](https://vercel.com/docs/headers/request-headers)), so the key is trustworthy there. Behind a different proxy, check that it appends the real client address; if another proxy sits in front of it, every visitor shares one key. With no proxy at all the header is attacker-controlled, which is why a global cap exists as well.
- **`Host` / `x-forwarded-host`** must match the browser's `Origin` (true on Vercel). A proxy that rewrites the host would make sign-in fail closed (403), not open.

## Verified
- Every API route calls `requireAuth` first (a test lists the route files on disk and fails if one is missing from the unauthenticated-access test). Only `login` and `logout` work signed out. With the AUTH_* settings missing everything answers 503.
- Pages contain no data (all data comes from the API); there are no Server Actions and no server-side data reads in pages. `proxy.ts` is a redirect convenience, not the boundary.
- State-changing routes require same-origin (`Sec-Fetch-Site` + `Origin`) and JSON.

## Accepted limitations
- **The limiter lives in process memory.** On serverless hosting each instance counts separately and a cold start resets it, so it slows guessing but is not a hard cap. The real defences are scrypt (~100 ms per guess) and a password of 12+ characters (enforced by `npm run auth:hash`). If you want a hard cap, add a Vercel WAF rate-limit rule on `POST /api/auth/login`.
- **The global cap can lock the admin out** for up to 15 minutes during a sustained attack (a lockout, not a break-in).
- **No server-side session revocation.** Logout clears the cookie; a stolen cookie works until it expires (8 h) or the password hash changes (which invalidates every session).
- **Single shared account:** no per-user audit identity beyond the username, no MFA.
