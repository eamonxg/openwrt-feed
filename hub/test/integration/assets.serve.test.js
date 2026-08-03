import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeAsset, makePayload, makeToken, PNG_1X1_BASE64 } from "../helpers.js";

const SHARE_URL = "https://example.com/api/v1/themes/aurora/configs";

// Minimal bytes that pass the JPEG magic-byte sniff (FF D8 FF ...) — the
// remaining bytes are arbitrary filler, since isJpeg only checks the prefix.
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
const JPEG_BASE64 = bytesToBase64(JPEG_BYTES);

const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
const SVG_BASE64 = btoa(SVG_TEXT);

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function shareWithAssets(assetSpecs, colorSeed) {
  const assets = [];
  for (const spec of assetSpecs) {
    // eslint-disable-next-line no-await-in-loop
    assets.push(await makeAsset(spec.kind, spec.base64));
  }
  const res = await SELF.fetch(SHARE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_token: makeToken(),
      name: "AssetHost",
      payload: makePayload({
        colors: { light_bg: colorSeed },
        assets: assets.map((a) => a.manifest),
      }),
      assets: assets.map((a) => a.body),
    }),
  });
  expect(res.status).toBe(201);
  const id = (await res.json()).id;
  return { id, assets };
}

async function approve(id, kind, bytes, customMetadata) {
  await env.DB.prepare("UPDATE assets SET status = 'approved' WHERE config_id = ? AND kind = ?")
    .bind(id, kind)
    .run();
  await env.R2.put(`approved/${id}/${kind}`, bytes, customMetadata ? { customMetadata } : undefined);
}

describe("GET /assets/:id/:kind", () => {
  it("returns 404 not_found while the asset is pending", async () => {
    const { id } = await shareWithAssets([{ kind: "favicon_png" }], "#100001");

    const res = await SELF.fetch(`https://example.com/assets/${id}/favicon_png`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("returns 404 not_found for an unknown config id", async () => {
    const res = await SELF.fetch("https://example.com/assets/nonexist/favicon_png");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("serves an approved logo_svg with svg Content-Type, cache headers, and CSP/nosniff", async () => {
    const { id, assets } = await shareWithAssets([{ kind: "logo_svg", base64: SVG_BASE64 }], "#100002");
    const bytes = base64ToBytes(SVG_BASE64);
    await approve(id, "logo_svg", bytes);

    const res = await SELF.fetch(`https://example.com/assets/${id}/logo_svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toBe("public, max-age=604800, immutable");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(bytes);
    expect(assets[0].manifest.kind).toBe("logo_svg");
  });

  it("serves an approved favicon_png with image/png Content-Type and no CSP header", async () => {
    const { id } = await shareWithAssets([{ kind: "favicon_png" }], "#100003");
    const bytes = base64ToBytes(PNG_1X1_BASE64);
    await approve(id, "favicon_png", bytes);

    const res = await SELF.fetch(`https://example.com/assets/${id}/favicon_png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=604800, immutable");
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBeNull();
    // Drain the R2-backed body stream fully — an unconsumed stream can leave
    // the isolated-storage snapshot for this test unable to pop cleanly (see
    // https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#isolated-storage).
    await res.arrayBuffer();
  });

  it("serves an approved login_bg as image/png or image/jpeg based on stored format metadata", async () => {
    const pngShare = await shareWithAssets([{ kind: "login_bg" }], "#100004");
    await approve(pngShare.id, "login_bg", base64ToBytes(PNG_1X1_BASE64), { format: "png" });

    const pngRes = await SELF.fetch(`https://example.com/assets/${pngShare.id}/login_bg`);
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get("content-type")).toBe("image/png");
    await pngRes.arrayBuffer();

    const jpegShare = await shareWithAssets([{ kind: "login_bg", base64: JPEG_BASE64 }], "#100005");
    await approve(jpegShare.id, "login_bg", base64ToBytes(JPEG_BASE64), { format: "jpeg" });

    const jpegRes = await SELF.fetch(`https://example.com/assets/${jpegShare.id}/login_bg`);
    expect(jpegRes.status).toBe(200);
    expect(jpegRes.headers.get("content-type")).toBe("image/jpeg");
    await jpegRes.arrayBuffer();
  });

  it("a rejected/never-approved asset among several stays 404 while its sibling is approved", async () => {
    const { id } = await shareWithAssets(
      [{ kind: "favicon_png" }, { kind: "logo_svg", base64: SVG_BASE64 }],
      "#100006"
    );
    await approve(id, "logo_svg", base64ToBytes(SVG_BASE64));

    const svgRes = await SELF.fetch(`https://example.com/assets/${id}/logo_svg`);
    expect(svgRes.status).toBe(200);
    await svgRes.arrayBuffer();

    const pngRes = await SELF.fetch(`https://example.com/assets/${id}/favicon_png`);
    expect(pngRes.status).toBe(404);
    await pngRes.json();
  });
});
