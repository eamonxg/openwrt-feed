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

// login_bg / main_bg accept either PNG or JPEG bytes; callers that need to
// know which one matched (to record it for Content-Type on download) should
// use `sniffBgFormat` directly instead of the boolean-only MAGIC_CHECKS
// entry.
export function sniffBgFormat(bytes) {
  if (isPng(bytes)) return "png";
  if (isJpeg(bytes)) return "jpeg";
  return null;
}

// The two full-page background kinds share one pipeline end to end: same
// magic sniff, same format tracking, same review-console re-encode.
export function isBgKind(kind) {
  return kind === "login_bg" || kind === "main_bg";
}

// A toolbar shortcut icon is whichever of SVG/PNG its author uploaded, so it
// is format-tracked the same way the bg kinds are. Those two are the only formats
// on offer because they are the only two the review console can sanitize
// (sanitizeSvg and the canvas re-encode) — an icon in any other format could
// be shared but never approved.
export function sniffToolbarIconFormat(bytes) {
  if (isPng(bytes)) return "png";
  if (isSvg(bytes)) return "svg";
  return null;
}

// A toolbar shortcut icon per distinct custom icon the config's shortcuts
// name, numbered by first appearance. Both the sharing router and the
// receiving one derive that numbering from the shortcut list itself, so
// nothing about the mapping travels on the wire and the toolbar item shape in
// the payload is unchanged — see nth_custom_toolbar_icon in the LuCI app.
//
// 12 because that is TOOLBAR_MAX_ITEMS: a shortcut list is capped there, so no
// config can name a thirteenth distinct icon.
export const TOOLBAR_ICON_KINDS = Array.from(
  { length: 12 },
  (_, i) => `toolbar_icon_${i}`
);

const TOOLBAR_ICON_KIND_SET = new Set(TOOLBAR_ICON_KINDS);

export function isToolbarIconKind(kind) {
  return TOOLBAR_ICON_KIND_SET.has(kind);
}

// Kinds whose stored Content-Type cannot be derived from the kind alone: the
// bytes decide, and the format sniffed when they were accepted is carried in
// R2 customMetadata. Every path that writes such an object has to record it,
// and every path that serves one has to read it back.
export function isFormatTrackedKind(kind) {
  return isBgKind(kind) || isToolbarIconKind(kind);
}

// The format to record for `kind`, or undefined when the kind pins its own
// Content-Type. Returns null when the bytes match no accepted format — every
// caller has already run MAGIC_CHECKS by then, so that cannot happen; it is
// the same "sniff the real bytes rather than assume" posture approve takes
// after the console has rewritten them.
export function sniffFormat(kind, bytes) {
  if (isBgKind(kind)) return sniffBgFormat(bytes);
  if (isToolbarIconKind(kind)) return sniffToolbarIconFormat(bytes);
  return undefined;
}

// Kinds whose approved bytes are byte-for-byte the pending bytes, so the
// admin console has no reason to download them, base64 them, and post them
// straight back: approve reads these from pending/ in the Worker instead.
//
// This is what keeps the approve body inside ADMIN_APPROVE_BODY_BYTES. With
// fonts in the body, one config's assets can reach 6*2 MiB + 2*8 MiB = 28 MiB,
// ~37 MB base64 — over the 25 MB cap, i.e. a config that can be shared but
// never approved.
//
// favicon_ico is deliberately NOT here even though it is also passed through
// today: at 2 MiB it is no part of the size problem, and its passthrough is
// forced (canvas cannot emit ICO) rather than intended, so it is the kind
// most likely to grow a real sanitizer later. Anything added here must be
// bytes the console genuinely never rewrites -- the console declares its own
// view per asset and approve rejects any disagreement, so this list and the
// console's cannot drift apart in silence.
export const APPROVE_FROM_R2_KINDS = new Set(["font_sans", "font_mono"]);

export const MAGIC_CHECKS = {
  logo_svg: isSvg,
  favicon_png: isPng,
  favicon_ico: isIco,
  pwa_icon_192: isPng,
  pwa_icon_512: isPng,
  login_bg: (bytes) => sniffBgFormat(bytes) !== null,
  main_bg: (bytes) => sniffBgFormat(bytes) !== null,
  font_sans: isWoff2,
  font_mono: isWoff2,
  ...Object.fromEntries(
    TOOLBAR_ICON_KINDS.map((kind) => [
      kind,
      (bytes) => sniffToolbarIconFormat(bytes) !== null,
    ])
  ),
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

// For a format-tracked kind (see isFormatTrackedKind) the Content-Type comes
// from the format recorded in R2 customMetadata at write time — pass that
// string in as `format`. Every other kind pins its own and ignores it.
//
// The fallbacks are the format the review console produces: it re-encodes
// login_bg to PNG unconditionally, and leaves a toolbar icon in whichever of
// the two formats it arrived as (an SVG through sanitizeSvg, a PNG through the
// canvas). Missing metadata therefore reads as PNG, never as SVG — guessing
// "svg" for a raster byte stream would hand a browser a mislabelled image,
// while the reverse merely renders nothing.
export function contentTypeFor(kind, format) {
  if (isBgKind(kind)) {
    return format === "jpeg" ? "image/jpeg" : "image/png";
  }
  if (isToolbarIconKind(kind)) {
    return format === "svg" ? "image/svg+xml" : "image/png";
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
  // D1 行是「这份字节能不能公开」的唯一真相来源，判断由两部分组成：资产
  // 自己过了审(assets.status)，且它所属的配置仍在架上(configs.status)。
  //
  // 后半条是 Task 1 补的。在此之前 takedown 会顺手删掉 assets 行，配置状态
  // 因此从来不需要被检查；一旦下架改成保留字节以便恢复，缺了这个 JOIN 就
  // 意味着被下架配置的字体和登录背景仍然人人可取。
  //
  // R2 key 始终就地重算成 approved/{id}/{kind}，而不信任行里存的 r2_key 列。
  const row = await env.DB.prepare(
    `SELECT 1 FROM assets a
       JOIN configs c ON c.id = a.config_id
      WHERE a.config_id = ? AND a.kind = ? AND a.status = 'approved'
        AND c.status = 'active'`
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

  const contentType = contentTypeFor(kind, object.customMetadata?.format);
  const headers = {
    "content-type": contentType,
    "cache-control": "public, max-age=604800, immutable",
    // Every /assets/ response gets nosniff, not just SVG — it costs nothing
    // and closes off MIME-sniffing surprises for any kind.
    "x-content-type-options": "nosniff",
  };
  // Keyed off the resolved Content-Type, not off the kind: a toolbar icon is
  // SVG or PNG depending on its bytes, and the whole point of this header is
  // that an SVG the browser is willing to parse can reach nothing else.
  if (contentType === "image/svg+xml") {
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
