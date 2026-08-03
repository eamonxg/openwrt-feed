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
