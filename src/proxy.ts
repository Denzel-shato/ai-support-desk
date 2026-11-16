import { NextResponse, type NextRequest } from "next/server";
import { readAuthConfig } from "@/lib/auth/config";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";

/**
 * Page gate: a signed-out visitor is sent to /login instead of seeing the
 * dashboard shell. This is a convenience, NOT the security boundary: the shell
 * holds no data, and every /api route checks the session itself (requireAuth),
 * so skipping or bypassing this file exposes nothing.
 *
 * /api is excluded from the matcher on purpose: API clients need a JSON 401,
 * not a redirect to an HTML page.
 */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const config = readAuthConfig();
  const session = config
    ? await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value, config.sessionSecret)
    : null;
  const signedIn = Boolean(session && session.sub === config?.username);

  if (pathname === "/login") {
    return signedIn ? NextResponse.redirect(new URL("/", request.url)) : NextResponse.next();
  }
  if (signedIn) return NextResponse.next();

  const url = new URL("/login", request.url);
  if (pathname !== "/") url.searchParams.set("next", pathname + request.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!api/|_next/|favicon.ico|.*\\..*).*)"],
};
