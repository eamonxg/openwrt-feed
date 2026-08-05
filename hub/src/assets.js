// Magic-byte sniffing, Content-Type mapping and R2 key layout for uploaded
// theme assets (API contract §4, flow step ④).
//
// R2 objects live under one of two states while a config's assets_status
// walks pending -> approved (or rejected): `pending/{id}/{kind}` for
// unreviewed bytes, `approved/{id}/{kind}` once an admin has re-encoded and
// approved them (Task 6/9 write the "approved" side; this file only needs to
// know the key shape).

import { HttpError } from "./auth.js";
import { errorResponse } from "./http.js";

function startsWithBytes(bytes, magic) {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const ICO_MAGIC = [0x00, 0x00, 0x01, 0x00];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const WOFF2_MAGIC = [0x77, 0x4f, 0x46, 0x32]; // ascii "wOF2"

function isPng(bytes) {
  return startsWithBytes(bytes, PNG_MAGIC);
}

function isIco(bytes) {
  return startsWithBytes(bytes, ICO_MAGIC);
}

function isJpeg(bytes) {
  return startsWithBytes(bytes, JPEG_MAGIC);
}

function isWoff2(bytes) {
  return startsWithBytes(bytes, WOFF2_MAGIC);
}

function isSvg(bytes) {
  let text;
  try {
    // TextDecoder strips a leading UTF-8 BOM by default (ignoreBOM: false),
    // so only leading whitespace needs handling here before the opening tag.
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return false;
  }
  text = text.replace(/^\s+/, "");
  return text.startsWith("<svg") || text.startsWith("<?xml");
}

// login_bg accepts either PNG or JPEG bytes; callers that need to know which
// one matched (to record it for Content-Type on download) should use
// `sniffLoginBgFormat` directly instead of the boolean-only MAGIC_CHECKS
// entry.
export function sniffLoginBgFormat(bytes) {
  if (isPng(bytes)) return "png";
  if (isJpeg(bytes)) return "jpeg";
  return null;
}

export const MAGIC_CHECKS = {
  logo_svg: isSvg,
  favicon_png: isPng,
  favicon_ico: isIco,
  pwa_icon_192: isPng,
  pwa_icon_512: isPng,
  login_bg: (bytes) => sniffLoginBgFormat(bytes) !== null,
  font_sans: isWoff2,
  font_mono: isWoff2,
};

const STATIC_CONTENT_TYPES = {
  logo_svg: "image/svg+xml",
  favicon_png: "image/png",
  favicon_ico: "image/x-icon",
  pwa_icon_192: "image/png",
  pwa_icon_512: "image/png",
  font_sans: "font/woff2",
  font_mono: "font/woff2",
};

// login_bg's Content-Type depends on which format was sniffed at share time
// (recorded in R2 customMetadata) — pass that in as `sniffedJpeg`.
export function contentTypeFor(kind, sniffedJpeg) {
  if (kind === "login_bg") {
    return sniffedJpeg ? "image/jpeg" : "image/png";
  }
  return STATIC_CONTENT_TYPES[kind];
}

// "draft" is where a browser-direct upload lands before its config exists
// (drafts.js): the config id is only minted at commit time, so the bytes
// cannot be written straight to pending/. An R2 lifecycle rule expires the
// draft/ prefix, which is why abandoned uploads need no application-level GC.
const R2_STATES = new Set(["draft", "pending", "approved"]);

export function r2Key(state, id, kind) {
  if (!R2_STATES.has(state)) {
    throw new Error(`r2Key: invalid state "${state}"`);
  }
  return `${state}/${id}/${kind}`;
}

// ---------------------------------------------------------------------------
// #8 GET /assets/:id/:kind — stream an approved asset from R2.
// ---------------------------------------------------------------------------

async function serveAsset(env, id, kind) {
  // The D1 row is the source of truth for "may this be served at all" — an
  // asset is only ever public once its row's status flips to 'approved'
  // (Task 9's approval flow). The R2 key itself is always recomputed as
  // approved/{id}/{kind} here rather than trusted from the row's stored
  // r2_key column, so serving never depends on that column having been
  // rewritten by the (not-yet-built) approval flow.
  const row = await env.DB.prepare(
    "SELECT 1 FROM assets WHERE config_id = ? AND kind = ? AND status = 'approved'"
  )
    .bind(id, kind)
    .first();

  if (!row) {
    throw new HttpError(404, "not_found", "Asset not found.");
  }

  const object = await env.R2.get(r2Key("approved", id, kind));
  if (!object) {
    throw new HttpError(404, "not_found", "Asset not found.");
  }

  const sniffedJpeg = object.customMetadata?.format === "jpeg";
  const headers = {
    "content-type": contentTypeFor(kind, sniffedJpeg),
    "cache-control": "public, max-age=604800, immutable",
    // Every /assets/ response gets nosniff, not just SVG — it costs nothing
    // and closes off MIME-sniffing surprises for any kind.
    "x-content-type-options": "nosniff",
  };
  if (kind === "logo_svg") {
    headers["content-security-policy"] = "default-src 'none'";
  }

  return new Response(object.body, { headers });
}

export async function handleAssetServe(request, env, params) {
  try {
    return await serveAsset(env, params.id, params.kind);
  } catch (err) {
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.code, err.message);
    }
    console.error(err);
    return errorResponse(500, "internal_error", "Something went wrong.");
  }
}
