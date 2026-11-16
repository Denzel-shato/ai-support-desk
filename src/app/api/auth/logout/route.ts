import { connection, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/request-guard";
import { responseErrorResponse } from "@/lib/response-api-errors";
import { NO_STORE } from "@/lib/ticket-api-errors";

/** POST /api/auth/logout: clears the session cookie. Safe to call when signed out. */
export async function POST(request: Request) {
  await connection();
  try {
    assertSameOrigin(request);
    const res = NextResponse.json({ ok: true }, { status: 200, headers: NO_STORE });
    res.cookies.set(SESSION_COOKIE, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return res;
  } catch (error) {
    return responseErrorResponse(error, "api/auth/logout");
  }
}
