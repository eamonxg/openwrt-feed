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

    const matched = router.dispatch(request, env);
    if (matched) return matched;

    if (url.pathname.startsWith("/api/")) {
      return errorResponse(404, "not_found", "The requested resource was not found.");
    }

    return env.SITE.fetch(request);
  },
};
