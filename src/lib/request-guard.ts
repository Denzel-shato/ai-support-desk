import "server-only";

import { ResponseWorkflowError } from "./response-workflow";

/**
 * Guards for state-changing API routes: JSON only, same-origin, size-capped.
 * (There is no login in this demo, so these only stop casual cross-site posts.)
 */

export const MAX_BODY_BYTES = 64 * 1024;

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // non-browser callers (curl, tests) send no Origin
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function readJsonBody(
  request: Request,
  options: { maxBytes?: number; allowEmpty?: boolean } = {},
): Promise<unknown> {
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;

  if (!sameOrigin(request)) {
    throw new ResponseWorkflowError(
      403,
      "forbidden_origin",
      "This request came from a different site and was refused.",
    );
  }

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
