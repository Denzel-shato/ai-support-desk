import "server-only";

import { ResponseWorkflowError } from "./response-workflow";

/**
 * Guards for state-changing API routes: JSON only, same-origin, size-capped.
 * These are defence in depth against cross-site requests; authentication
 * (requireAuth) is what decides WHO may call a route.
 */

export const MAX_BODY_BYTES = 64 * 1024;

/**
 * A browser request must come from this site. We check Sec-Fetch-Site (sent by
 * all current browsers and not forgeable from page JavaScript) and Origin.
 * Requests with neither header are not from a browser (curl, scripts, tests):
 * they can't ride on a victim's cookie, and still need to be signed in.
 */
export function isSameOriginRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function assertSameOrigin(request: Request): void {
  if (!isSameOriginRequest(request)) {
    throw new ResponseWorkflowError(
      403,
      "forbidden_origin",
      "This request came from a different site and was refused.",
    );
  }
}

export async function readJsonBody(
  request: Request,
  options: { maxBytes?: number; allowEmpty?: boolean } = {},
): Promise<unknown> {
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;

  assertSameOrigin(request);

  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    if (options.allowEmpty && !(await request.clone().text()).length) return {};
    throw new ResponseWorkflowError(
      415,
      "unsupported_media_type",
      "Send the request as JSON (Content-Type: application/json).",
    );
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ResponseWorkflowError(413, "body_too_large", "The request is too large.");
  }

  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new ResponseWorkflowError(413, "body_too_large", "The request is too large.");
  }
  if (!text.trim()) {
    if (options.allowEmpty) return {};
    throw new ResponseWorkflowError(400, "invalid_json", "The request body is empty.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ResponseWorkflowError(400, "invalid_json", "The request body is not valid JSON.");
  }
}
