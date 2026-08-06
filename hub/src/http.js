// Shared HTTP response helpers and a streaming-bounded JSON body reader.
// Used by worker.js and configs.js (and, per the fix-round note, admin.js
// once it lands) so the error envelope and the 12 MB body cap have exactly
// one implementation each.

import { HttpError } from "./auth.js";

export function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

export function errorResponse(status, code, message) {
  return jsonResponse({ error: { code, message } }, { status });
}

// CORS: LuCI frontends call the API straight from the router's origin.
// Read endpoints are public data and write endpoints authenticate via the
// device token carried in the body, so a wildcard origin does not widen
// access. The static site is intentionally left same-origin (see worker.js).
export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
  // Authorization is what a ticketed asset upload carries (see drafts.js).
  // A browser sending it triggers a preflight, and a preflight that does not
  // list the header here fails — so without this entry browser-direct upload
  // never sends a single byte, no matter how correct the PUT handler is.
  "access-control-allow-headers": "Content-Type, Authorization",
  "access-control-max-age": "86400",
};

export function withCors(response) {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Global Constraint: request bodies are capped at 12 MB.
export const MAX_BODY_BYTES = 12 * 1024 * 1024;

// Reads a request body as JSON while enforcing `maxBytes` as a genuine
// streaming cap. A Content-Length precheck alone (see worker.js's fast path)
// can be bypassed by a chunked request that omits the header entirely; this
// reader counts bytes as they arrive and cancels the stream — throwing
// HttpError(413, 'too_large') — the instant the running total exceeds the
// cap, so an oversized chunked body is never buffered in full.
export async function readJsonBounded(request, maxBytes) {
  if (!request.body) {
    throw new HttpError(400, "bad_json", "Request body must be valid JSON.");
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "too_large", "Request body exceeds the maximum size.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, "bad_json", "Request body must be valid JSON.");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_json", "Request body must be valid JSON.");
  }
}

// The optional `{reason}` that purge and ban accept. Deliberately total: an
// absent body, an empty body, a non-JSON body and a JSON body carrying no
// `reason` string all mean the same thing — no reason given — and none of
// them is an error. Both endpoints have always been called with no body at
// all (the admin console's plain POST, and every existing test), and a
// permanent delete that 400s because a piece of optional free text was
// malformed is the worst possible way for it to fail. The reason is a note
// for the audit log, never an input the action depends on.
export async function readOptionalReason(request, maxBytes = 2048) {
  let body;
  try {
    body = await readJsonBounded(request, maxBytes);
  } catch {
    return "";
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "";
  return typeof body.reason === "string" ? body.reason.trim() : "";
}
