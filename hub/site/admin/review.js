import { sanitizeSvg } from "./sanitize-svg.js";
import { apiFetch, el } from "./app.js";

// -----------------------------------------------------------------------------
// Bytes <-> base64
// -----------------------------------------------------------------------------

export function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// -----------------------------------------------------------------------------
// Per-kind sanitation
// -----------------------------------------------------------------------------

// createImageBitmap + canvas re-encode to PNG strips any embedded
// metadata/polyglot tricks in raster formats — this applies to every
// browser-decodable raster kind except favicon_ico (see note below).
const CANVAS_REENCODE_KINDS = new Set(["favicon_png", "pwa_icon_192", "pwa_icon_512", "login_bg", "main_bg"]);
const MAX_IMAGE_DIMENSION = 4096;
// Full-page backgrounds legitimately arrive as 5K/6K wallpapers; the store's
// 2 MiB byte cap already bounds decode cost, so they get a wider pixel budget
// than icons instead of being shareable-but-never-approvable.
const MAX_BG_DIMENSION = 8192;
const isBgKind = (kind) => kind === "login_bg" || kind === "main_bg";
// Mirrors validate.js's OTHER_ASSET_LIMIT: approve rejects re-encoded bytes
// past this, so the re-encoder below must aim under it, not just decode.
const BG_APPROVE_LIMIT = 2 * 1024 * 1024;

// A toolbar shortcut icon is SVG or PNG depending on what its author uploaded,
// so its sanitizer is picked from the bytes rather than from the kind: running
// an SVG through the canvas would rasterize it (and the approve endpoint's
// magic check would then still pass, so nothing downstream would notice), and
// running a PNG through sanitizeSvg would produce garbage.
//
// The Content-Type comes from the customMetadata format the share/update flow
// sniffed and stored, which is exactly the format approve re-sniffs from
// whatever this function returns.
const isToolbarIconKind = (kind) => /^toolbar_icon_(?:[0-9]|1[01])$/.test(kind);

function looksLikeSvg(bytes, contentType) {
  if (contentType && contentType.indexOf("svg") !== -1) return true;
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, 512))
    .replace(/^\s+/, "");
  return head.startsWith("<svg") || head.startsWith("<?xml");
}

export async function fetchPendingAsset(configId, kind) {
  const res = await apiFetch(
    "/api/v1/admin/assets/" + encodeURIComponent(configId) + "/" + encodeURIComponent(kind)
  );
  if (!res.ok) {
    throw new Error("Failed to fetch raw asset bytes (" + res.status + ").");
  }
  const contentType = res.headers.get("content-type") || "";
  const buf = await res.arrayBuffer();
  return { bytes: new Uint8Array(buf), contentType };
}

// Fetches an already-approved kind's live bytes purely for preview (mixed
// approved+pending configs, final-review Finding 1) — no sanitization runs
// on it, and it is never included in the approve POST body. #10 falls back
// to serving the approved/ bytes for a kind whose row is already
// 'approved' (its pending/ object was deleted the moment it was first
// approved), so the same fetchPendingAsset call works for both cases.
// Never throws — a failed preview fetch is shown inline, it never blocks
// Approve (only the pending kinds gate that button).
export async function fetchApprovedPreview(configId, kind) {
  try {
    const fetched = await fetchPendingAsset(configId, kind);
    return { ok: true, bytes: fetched.bytes, contentType: fetched.contentType };
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
}

let fontSampleCounter = 0;

export function renderAlreadyApprovedPreview(tile, kind, result) {
  const preview = el("div", { class: "preview" });
  tile.appendChild(preview);

  if (!result.ok) {
    const stateLine = el("div", { class: "state-error", text: "already approved (preview failed: " + result.message + ")" });
    tile.appendChild(stateLine);
    return;
  }

  const stateLine = el("div", { class: "state-ok", text: "already approved" });
  tile.appendChild(stateLine);

  const blob = new Blob([result.bytes], { type: result.contentType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  if (result.contentType && result.contentType.indexOf("font/") === 0) {
    fontSampleCounter += 1;
    const family = "admin-preview-font-" + fontSampleCounter;
    const sample = el("div", { class: "font-sample", text: "Aa 123" });
    preview.appendChild(sample);
    const face = new FontFace(family, "url(" + url + ")");
    face
      .load()
      .then((loaded) => {
        document.fonts.add(loaded);
        sample.style.fontFamily = family;
      })
      .catch(() => {});
  } else {
    const img = el("img", { src: url, alt: kind });
    preview.appendChild(img);
  }
}

// Returns { ok: true, bytes, blob, previewKind } or { ok: false, message }.
// Never throws — every failure path here is a sanitize failure the caller
// surfaces on the card and uses to disable "Approve".
export async function sanitizeAsset(configId, kind) {
  let fetched;
  try {
    fetched = await fetchPendingAsset(configId, kind);
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
  const { bytes, contentType } = fetched;
  const svgIcon = isToolbarIconKind(kind) && looksLikeSvg(bytes, contentType);

  if (kind === "logo_svg" || svgIcon) {
    try {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const sanitized = sanitizeSvg(text);
      const outBytes = new TextEncoder().encode(sanitized);
      const blob = new Blob([outBytes], { type: "image/svg+xml" });
      return { ok: true, bytes: outBytes, blob, previewKind: "svg" };
    } catch (err) {
      return { ok: false, message: "SVG sanitize failed: " + (err.message || err) };
    }
  }

  if (CANVAS_REENCODE_KINDS.has(kind) || isToolbarIconKind(kind)) {
    let bitmap;
    try {
      const srcBlob = new Blob([bytes], { type: contentType || "image/png" });
      bitmap = await createImageBitmap(srcBlob);
    } catch (err) {
      return { ok: false, message: "Not a decodable image." };
    }
    // Read the dimensions BEFORE close(): a closed ImageBitmap reports 0x0,
    // which used to turn every oversized wallpaper into a baffling "(0x0)".
    const bmWidth = bitmap.width;
    const bmHeight = bitmap.height;
    const cap = isBgKind(kind) ? MAX_BG_DIMENSION : MAX_IMAGE_DIMENSION;
    if (bmWidth > cap || bmHeight > cap) {
      bitmap.close();
      return {
        ok: false,
        message: "Image exceeds the " + cap + "x" + cap + " cap (" +
          bmWidth + "x" + bmHeight + ").",
      };
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bmWidth;
      canvas.height = bmHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      // The bg kinds re-encode to JPEG, stepping the quality down until the
      // bytes fit the store's 2 MiB asset cap: a canvas PNG of a photo
      // balloons well past it, which quietly resurrected the
      // shareable-but-never-approvable failure right here at approve time.
      // Backgrounds are full-bleed photos, so JPEG's lack of alpha is free.
      if (isBgKind(kind)) {
        for (const quality of [0.92, 0.85, 0.75, 0.65]) {
          const jpegBlob = await new Promise((resolve) =>
            canvas.toBlob(resolve, "image/jpeg", quality)
          );
          if (!jpegBlob) throw new Error("canvas.toBlob returned null.");
          if (jpegBlob.size <= BG_APPROVE_LIMIT) {
            const outBytes = new Uint8Array(await jpegBlob.arrayBuffer());
            return { ok: true, bytes: outBytes, blob: jpegBlob, previewKind: "image" };
          }
        }
        return {
          ok: false,
          message: "Re-encoded image cannot fit the 2 MiB store cap.",
        };
      }
      // Every other raster kind still lands as PNG, per the functional
      // contract (icons want lossless + alpha).
      const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!pngBlob) throw new Error("canvas.toBlob returned null.");
      const outBytes = new Uint8Array(await pngBlob.arrayBuffer());
      return { ok: true, bytes: outBytes, blob: pngBlob, previewKind: "image" };
    } catch (err) {
      return { ok: false, message: "Re-encode failed: " + (err.message || err) };
    }
  }

  // favicon_ico: deliberately NOT canvas-reencoded. canvas.toBlob only ever
  // produces png/jpeg/webp — never ico — and the admin approve endpoint
  // (src/admin.js, MAGIC_CHECKS.favicon_ico = isIco) requires the ICO magic
  // bytes (00 00 01 00) to survive into the approved asset. Re-encoding
  // this kind to PNG would make it permanently impossible to approve.
  // font_sans/font_mono (woff2): passthrough — the magic bytes were already
  // checked at upload time (assets.js), same rationale as the brief's
  // explicit woff2 passthrough.
  const blob = new Blob([bytes], { type: contentType || "application/octet-stream" });
  return { ok: true, bytes, blob, previewKind: kind === "favicon_ico" ? "image" : "font" };
}

export function renderAssetPreview(tile, kind, result) {
  const preview = el("div", { class: "preview" });
  const stateLine = el("div");
  tile.appendChild(preview);
  tile.appendChild(stateLine);

  if (!result.ok) {
    stateLine.className = "state-error";
    stateLine.textContent = result.message;
    return;
  }

  stateLine.className = "state-ok";
  stateLine.textContent = "sanitized ok (" + result.bytes.length + " bytes)";

  const url = URL.createObjectURL(result.blob);
  if (result.previewKind === "svg" || result.previewKind === "image") {
    const img = el("img", { src: url, alt: kind });
    preview.appendChild(img);
  } else if (result.previewKind === "font") {
    fontSampleCounter += 1;
    const family = "admin-preview-font-" + fontSampleCounter;
    const sample = el("div", { class: "font-sample", text: "Aa 123" });
    preview.appendChild(sample);
    const face = new FontFace(family, "url(" + url + ")");
    face
      .load()
      .then((loaded) => {
        document.fonts.add(loaded);
        sample.style.fontFamily = family;
      })
      .catch(() => {
        stateLine.className = "state-error";
        stateLine.textContent = "sanitized, but font failed to render for preview.";
      });
  }
}
