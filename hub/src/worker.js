import { createRouter } from "./router.js";
import { handleShare } from "./configs.js";
import { jsonResponse, errorResponse, MAX_BODY_BYTES } from "./http.js";

const router = createRouter();

router.add("GET", "/api/v1/ping", () => jsonResponse({ pong: true }));

router.add("POST", "/api/v1/themes/:theme/configs", async (request, env, params) => {
  // Multi-theme ready routing: v1 only accepts "aurora". Checked before any
  // body parsing, per contract.
  if (params.theme !== "aurora") {
    await request.body?.cancel();
    return errorResponse(404, "unknown_theme", "Unknown theme.");
  }

  // 12 MB body cap, enforced from the Content-Length header alone — before
  // the body is read at all.
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    await request.body?.cancel();
    return errorResponse(413, "too_large", "Request body exceeds the maximum size.");
  }

  return handleShare(request, env, params);
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const matched = router.dispatch(request, env);
    if (matched) return matched;

    if (url.pathname.startsWith("/api/")) {
      return errorResponse(404, "not_found", "The requested resource was not found.");
    }

    return env.SITE.fetch(request);
  },
};
