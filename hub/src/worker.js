import { createRouter } from "./router.js";
import {
  handleShare,
  handleListConfigs,
  handleConfigDetail,
  handleUpdateConfig,
  handleDeleteConfig,
  handleDownload,
  handleReport,
} from "./configs.js";
import { handleAssetServe } from "./assets.js";
import {
  handlePendingList,
  handlePendingAsset,
  handleApprove,
  handleReject,
  handleTakedown,
  handleBanDevice,
  handleReportsList,
  handleResolveReport,
} from "./admin.js";
import { jsonResponse, errorResponse, MAX_BODY_BYTES } from "./http.js";

const router = createRouter();

router.add("GET", "/api/v1/ping", () => jsonResponse({ pong: true }));

// Multi-theme ready routing: v1 only accepts "aurora" for every :theme route,
// checked before the handler runs.
function requireAuroraTheme(params) {
  return params.theme !== "aurora"
    ? errorResponse(404, "unknown_theme", "Unknown theme.")
    : null;
}

router.add("GET", "/api/v1/themes/:theme/configs", (request, env, params) => {
  const rejected = requireAuroraTheme(params);
  return rejected ?? handleListConfigs(request, env, params);
});

router.add("GET", "/api/v1/themes/:theme/configs/:id", (request, env, params) => {
  const rejected = requireAuroraTheme(params);
  return rejected ?? handleConfigDetail(request, env, params);
});

// No :theme segment (contract #8) — mounted at the worker level, already
// covered by run_worker_first's "/assets/*" entry.
router.add("GET", "/assets/:id/:kind", (request, env, params) => handleAssetServe(request, env, params));

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

// #4 PUT: same 12 MB cap as #3 share, since the body carries the same
// shape (full payload + assets).
router.add("PUT", "/api/v1/themes/:theme/configs/:id", async (request, env, params) => {
  if (params.theme !== "aurora") {
    await request.body?.cancel();
    return errorResponse(404, "unknown_theme", "Unknown theme.");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) {
    await request.body?.cancel();
    return errorResponse(413, "too_large", "Request body exceeds the maximum size.");
  }

  return handleUpdateConfig(request, env, params);
});

// #5 DELETE: body is just {device_token}, handled with the small-body cap
// inside handleDeleteConfig itself — no separate content-length fast path
// needed here.
router.add("DELETE", "/api/v1/themes/:theme/configs/:id", (request, env, params) => {
  const rejected = requireAuroraTheme(params);
  return rejected ?? handleDeleteConfig(request, env, params);
});

router.add("POST", "/api/v1/themes/:theme/configs/:id/download", (request, env, params) => {
  const rejected = requireAuroraTheme(params);
  return rejected ?? handleDownload(request, env, params);
});

router.add("POST", "/api/v1/themes/:theme/configs/:id/report", (request, env, params) => {
  const rejected = requireAuroraTheme(params);
  return rejected ?? handleReport(request, env, params);
});

// GET /admin — the static review console (Task 10). The run_worker_first
// table (wrangler config) routes this to the Worker rather than letting the
// SITE assets binding resolve it directly, so it must be served explicitly
// here. The admin page lives at site/admin/index.html (a directory index)
// rather than site/admin.html: the assets binding's default html_handling
// ("auto-trailing-slash") canonicalizes any exact "*.html" filename request
// to its extensionless form via a 307 — for a top-level "admin.html" that
// redirect target is "/admin" itself, which re-enters this very route and
// loops forever. For a directory index the canonical, redirect-free path is
// "/admin/" (with the trailing slash, verified against a local wrangler dev
// run) — bare "/admin" itself gets a 307 to "/admin/" from the assets
// binding, so the trailing slash is added here to serve the content
// directly instead of bouncing the client through that extra redirect.
router.add("GET", "/admin", (request, env) => {
  const url = new URL(request.url);
  url.pathname = "/admin/";
  return env.SITE.fetch(new Request(url, request));
});

// GET /c/:id — theme config detail page (Task 11). Mirrors the /admin
// approach (Task 10): the page is a single self-contained static file
// (site/config.html) that fetches its own data client-side from the API, so
// the Worker's only job here is to hand back that file's bytes for any
// config id — valid or not; the 404 for an unknown/removed id is rendered by
// the page itself once its own fetch to the detail API (#2) comes back 404.
//
// Just like /admin, the request to env.SITE can't ask for the exact
// "config.html" filename: the assets binding's html_handling
// ("auto-trailing-slash") 307-redirects an exact "*.html" filename request to
// its extensionless canonical form (here, that form is "/config" itself,
// since config.html is a top-level file rather than a directory index like
// admin's). Rewriting the sub-request's path to that already-canonical
// "/config" serves the file directly with no redirect in the loop at all.
router.add("GET", "/c/:id", (request, env) => {
  const url = new URL(request.url);
  url.pathname = "/config";
  return env.SITE.fetch(new Request(url, request));
});

// #9-#15 — admin/moderation API. Every handler in admin.js calls
// requireAdmin(request, env) as its first step, so no separate gate is
// needed here in the router table.
router.add("GET", "/api/v1/admin/pending", handlePendingList);
router.add("GET", "/api/v1/admin/assets/:id/:kind", handlePendingAsset);
router.add("POST", "/api/v1/admin/configs/:id/approve", handleApprove);
router.add("POST", "/api/v1/admin/configs/:id/reject", handleReject);
router.add("POST", "/api/v1/admin/configs/:id/takedown", handleTakedown);
router.add("POST", "/api/v1/admin/devices/:device_id/ban", handleBanDevice);
router.add("GET", "/api/v1/admin/reports", handleReportsList);
router.add("POST", "/api/v1/admin/reports/:rid/resolve", handleResolveReport);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // A percent-encoded path segment that isn't valid UTF-8 (e.g. GET
    // /c/%ff) makes router.dispatch's decodeURIComponent throw a raw
    // URIError synchronously, before any handler runs — left unguarded that
    // surfaces as an uncaught-exception 500 with no JSON body at all rather
    // than the standard {"error":{...}} envelope. Every other error path in
    // this Worker already converts to that envelope, so this one is caught
    // here and mapped to 400 bad_request the same way.
    let matched;
    try {
      matched = router.dispatch(request, env);
    } catch (err) {
      if (err instanceof URIError) {
        return errorResponse(400, "bad_request", "The request path is malformed.");
      }
      throw err;
    }
    if (matched) return matched;

    if (url.pathname.startsWith("/api/")) {
      return errorResponse(404, "not_found", "The requested resource was not found.");
    }

    return env.SITE.fetch(request);
  },
};
