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
const CANVAS_REENCODE_KINDS = new Set(["favicon_png", "pwa_icon_192", "pwa_icon_512", "login_bg"]);
const MAX_IMAGE_DIMENSION = 4096;

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

  if (kind === "logo_svg") {
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

  if (CANVAS_REENCODE_KINDS.has(kind)) {
    let bitmap;
    try {
      const srcBlob = new Blob([bytes], { type: contentType || "image/png" });
      bitmap = await createImageBitmap(srcBlob);
    } catch (err) {
      return { ok: false, message: "Not a decodable image." };
    }
    if (bitmap.width > MAX_IMAGE_DIMENSION || bitmap.height > MAX_IMAGE_DIMENSION) {
      bitmap.close();
      return {
        ok: false,
        message: "Image exceeds the " + MAX_IMAGE_DIMENSION + "x" + MAX_IMAGE_DIMENSION + " cap (" +
          bitmap.width + "x" + bitmap.height + ").",
      };
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      // login_bg accepts jpeg input at share time but is always
      // re-encoded to png here, per the functional contract.
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
