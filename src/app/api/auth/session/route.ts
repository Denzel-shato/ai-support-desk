import { connection, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { responseErrorResponse } from "@/lib/response-api-errors";
import { NO_STORE } from "@/lib/ticket-api-errors";

/**
 * GET /api/auth/session
 * 200 { user: { username } } when signed in, 401 when not, 503 when sign-in
 * is not configured (the response names the missing settings, never values).
 */
export async function GET(request: Request) {
  await connection();
  try {
    const session = await requireAuth(request);
    return NextResponse.json(
      { user: { username: session.sub }, expiresAt: new Date(session.exp * 1000).toISOString() },
      { status: 200, headers: NO_STORE },
    );
  } catch (error) {
    return responseErrorResponse(error, "api/auth/session");
  }
}
