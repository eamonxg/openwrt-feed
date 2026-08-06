import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeAsset, makePayload, makeToken, PNG_1X1_BASE64 } from "../helpers.js";
import { ASSET_SIZE_LIMITS } from "../../src/validate.js";
import { ADMIN_APPROVE_BODY_BYTES } from "../../src/admin.js";

const SHARE_URL = "https://example.com/api/v1/themes/aurora/configs";
const ADMIN_TOKEN = "test-admin-token"; // matches vitest.config.js's miniflare bindings
const ADMIN_HEADERS = { Authorization: `Bearer ${ADMIN_TOKEN}` };

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// A second PNG fixture, distinct bytes/hash from PNG_1X1_BASE64 — used as
// the admin's "sanitized replacement" bytes during approve, so the test can
// assert the stored sha256/size actually changed to the replacement's.
const SANITIZED_PNG_BASE64 = bytesToBase64(
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xaa, 0xbb, 0xcc, 0xdd])
);
const SANITIZED_JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66]);
const SANITIZED_JPEG_BASE64 = bytesToBase64(SANITIZED_JPEG_BYTES);

async function shareWithAssets({ token = makeToken(), name = "Config", assetSpecs = [], colorSeed } = {}) {
  const assets = [];
  for (const spec of assetSpecs) {
    // eslint-disable-next-line no-await-in-loop
    assets.push(await makeAsset(spec.kind, spec.base64));
  }
  const res = await SELF.fetch(SHARE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_token: token,
      name,
      payload: makePayload({
        colors: colorSeed ? { light_bg: colorSeed } : undefined,
        assets: assets.map((a) => a.manifest),
      }),
      ...(assets.length ? { assets: assets.map((a) => a.body) } : {}),
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  return { id: body.id, token, assets };
}

async function configRow(id) {
  return env.DB.prepare("SELECT * FROM configs WHERE id = ?").bind(id).first();
}

async function assetRow(id, kind) {
  return env.DB.prepare("SELECT * FROM assets WHERE config_id = ? AND kind = ?").bind(id, kind).first();
}

function adminFetch(path, init = {}) {
  return SELF.fetch(`https://example.com${path}`, {
    ...init,
    headers: { ...ADMIN_HEADERS, ...(init.headers ?? {}) },
  });
}

// ---------------------------------------------------------------------------
// 401 sweep: every admin route, with no Bearer and with a wrong Bearer.
// ---------------------------------------------------------------------------

describe("admin routes require a valid Bearer token", () => {
  const routes = [
    { method: "GET", path: "/api/v1/admin/pending" },
    { method: "GET", path: "/api/v1/admin/assets/whatever/favicon_png" },
    { method: "POST", path: "/api/v1/admin/configs/whatever/approve" },
    { method: "POST", path: "/api/v1/admin/configs/whatever/reject" },
    { method: "POST", path: "/api/v1/admin/configs/whatever/takedown" },
    { method: "POST", path: "/api/v1/admin/devices/whatever/ban" },
    { method: "GET", path: "/api/v1/admin/reports" },
    { method: "POST", path: "/api/v1/admin/reports/1/resolve" },
  ];

  for (const { method, path } of routes) {
    it(`${method} ${path} -> 401 unauthorized with no Authorization header`, async () => {
      const res = await SELF.fetch(`https://example.com${path}`, { method });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
    });

    it(`${method} ${path} -> 401 unauthorized with a wrong Bearer token`, async () => {
      const res = await SELF.fetch(`https://example.com${path}`, {
        method,
        headers: { Authorization: "Bearer wrong-token" },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
    });
  }
});

// ---------------------------------------------------------------------------
// #9 GET /api/v1/admin/pending
// ---------------------------------------------------------------------------

describe("GET /api/v1/admin/pending", () => {
  it("lists only assets_status='pending' active configs, oldest first, with their assets", async () => {
    const pending1 = await shareWithAssets({
      name: "Pending One",
      assetSpecs: [{ kind: "favicon_png" }],
      colorSeed: "#200001",
    });
    const pending2 = await shareWithAssets({
      name: "Pending Two",
      assetSpecs: [{ kind: "logo_svg", base64: btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>') }],
      colorSeed: "#200002",
    });
    // No assets at all -> assets_status 'none', must not appear.
    const noAssetsRes = await SELF.fetch(SHARE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_token: makeToken(),
        name: "No Assets",
        payload: makePayload({ colors: { light_bg: "#200003" } }),
      }),
    });
    expect(noAssetsRes.status).toBe(200);

    // Force a stable created_at order regardless of same-second timestamps.
    await env.DB.prepare("UPDATE configs SET created_at = ? WHERE id = ?")
      .bind("2026-01-01 00:00:01", pending1.id)
      .run();
    await env.DB.prepare("UPDATE configs SET created_at = ? WHERE id = ?")
      .bind("2026-01-01 00:00:02", pending2.id)
      .run();

    const res = await adminFetch("/api/v1/admin/pending");
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.items.map((item) => item.config_id);
    expect(ids).toEqual([pending1.id, pending2.id]);
    expect(ids).not.toContain(undefined);

    const item1 = body.items.find((item) => item.config_id === pending1.id);
    expect(item1.name).toBe("Pending One");
    expect(item1.assets).toEqual([
      {
        kind: "favicon_png",
        sha256: pending1.assets[0].manifest.sha256,
        size: pending1.assets[0].manifest.size,
        status: "pending",
      },
    ]);
  });

  it("includes a per-asset status so a mixed approved+pending config's already-approved kinds are distinguishable", async () => {
    const SVG_BASE64 = btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const token = makeToken();

    const { id } = await shareWithAssets({
      token,
      name: "Mixed",
      assetSpecs: [{ kind: "logo_svg", base64: SVG_BASE64 }],
      colorSeed: "#201001",
    });
    await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [{ kind: "logo_svg", data_b64: SVG_BASE64 }] }),
    });

    const icoBase64 = bytesToBase64(new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]));
    const logoAsset = await makeAsset("logo_svg", SVG_BASE64);
    const icoAsset = await makeAsset("favicon_ico", icoBase64);
    await SELF.fetch(`https://example.com/api/v1/themes/aurora/configs/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_token: token,
        name: "Mixed",
        payload: makePayload({
          colors: { light_bg: "#201002" },
          assets: [logoAsset.manifest, icoAsset.manifest],
        }),
        assets: [logoAsset.body, icoAsset.body],
      }),
    });

    const res = await adminFetch("/api/v1/admin/pending");
    const body = await res.json();
    const item = body.items.find((i) => i.config_id === id);
    expect(item.assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "logo_svg", status: "approved" }),
        expect.objectContaining({ kind: "favicon_ico", status: "pending" }),
      ])
    );
  });

  it("excludes a removed config even if its assets_status is still pending", async () => {
    const { id } = await shareWithAssets({ assetSpecs: [{ kind: "favicon_png" }], colorSeed: "#200010" });
    await env.DB.prepare("UPDATE configs SET status = 'removed' WHERE id = ?").bind(id).run();

    const res = await adminFetch("/api/v1/admin/pending");
    const body = await res.json();
    expect(body.items.map((i) => i.config_id)).not.toContain(id);
  });
});

// ---------------------------------------------------------------------------
// #10 GET /api/v1/admin/assets/:id/:kind
// ---------------------------------------------------------------------------

describe("GET /api/v1/admin/assets/:id/:kind", () => {
  it("returns the raw pending bytes with no-store cache and nosniff", async () => {
    const { id } = await shareWithAssets({ assetSpecs: [{ kind: "favicon_png" }], colorSeed: "#210001" });

    const res = await adminFetch(`/api/v1/admin/assets/${id}/favicon_png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(base64ToBytes(PNG_1X1_BASE64));
  });

  it("404 not_found for an unknown config id", async () => {
    const res = await adminFetch("/api/v1/admin/assets/nonexist/favicon_png");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("404 not_found for a kind the config doesn't have", async () => {
    const { id } = await shareWithAssets({ assetSpecs: [{ kind: "favicon_png" }], colorSeed: "#210002" });
    const res = await adminFetch(`/api/v1/admin/assets/${id}/logo_svg`);
    expect(res.status).toBe(404);
  });

  it("falls back to serving the approved/ bytes for a kind whose row is already 'approved' (no pending/ object left)", async () => {
    const SVG_BASE64 = btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const { id } = await shareWithAssets({ assetSpecs: [{ kind: "logo_svg", base64: SVG_BASE64 }], colorSeed: "#210003" });
    await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [{ kind: "logo_svg", data_b64: SVG_BASE64 }] }),
    });

    // The pending/ object is gone the moment approval happens — confirm the
    // premise before checking the fallback.
    expect(await env.R2.get(`pending/${id}/logo_svg`)).toBeNull();

    const res = await adminFetch(`/api/v1/admin/assets/${id}/logo_svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).toBe(atob(SVG_BASE64));
  });
});

// ---------------------------------------------------------------------------
// #11 POST /api/v1/admin/configs/:id/approve
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/configs/:id/approve", () => {
  it("happy path: R2 approved/ written, pending/ deleted, assets row updated, public asset now serves", async () => {
    const { id } = await shareWithAssets({ assetSpecs: [{ kind: "favicon_png" }], colorSeed: "#220001" });
    const sanitizedBytes = base64ToBytes(SANITIZED_PNG_BASE64);

    const res = await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [{ kind: "favicon_png", data_b64: SANITIZED_PNG_BASE64 }] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, approved: true });

    const config = await configRow(id);
    expect(config.assets_status).toBe("approved");

    const asset = await assetRow(id, "favicon_png");
    expect(asset.status).toBe("approved");
    expect(asset.size).toBe(sanitizedBytes.byteLength);
    expect(asset.r2_key).toBe(`approved/${id}/favicon_png`);

    const approvedObject = await env.R2.get(`approved/${id}/favicon_png`);
    expect(approvedObject).not.toBeNull();
    expect(new Uint8Array(await approvedObject.arrayBuffer())).toEqual(sanitizedBytes);
    expect(asset.sha256).toBe(await (async () => {
      const digest = await crypto.subtle.digest("SHA-256", sanitizedBytes);
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    })());

    const pendingObject = await env.R2.get(`pending/${id}/favicon_png`);
    expect(pendingObject).toBeNull();

    const publicRes = await SELF.fetch(`https://example.com/assets/${id}/favicon_png`);
    expect(publicRes.status).toBe(200);
    expect(new Uint8Array(await publicRes.arrayBuffer())).toEqual(sanitizedBytes);
  });

  it("re-sniffs login_bg's sanitized bytes and stores the matching format in customMetadata", async () => {
    const { id } = await shareWithAssets({ assetSpecs: [{ kind: "login_bg" }], colorSeed: "#220002" });

    const res = await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [{ kind: "login_bg", data_b64: SANITIZED_JPEG_BASE64 }] }),
    });
    expect(res.status).toBe(200);

    const publicRes = await SELF.fetch(`https://example.com/assets/${id}/login_bg`);
    expect(publicRes.status).toBe(200);
    expect(publicRes.headers.get("content-type")).toBe("image/jpeg");
    await publicRes.arrayBuffer();
  });

  it("400 missing_asset when the body omits a kind the config has pending", async () => {
    const { id } = await shareWithAssets({
      assetSpecs: [{ kind: "favicon_png" }, { kind: "favicon_ico", base64: bytesToBase64(new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00])) }],
      colorSeed: "#220003",
    });

    const res = await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [{ kind: "favicon_png", data_b64: SANITIZED_PNG_BASE64 }] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "missing_asset", message: expect.any(String) } });

    // Nothing should have been mutated by the rejected request.
    const config = await configRow(id);
    expect(config.assets_status).toBe("pending");
  });

  it("400 missing_asset when the body includes an extra kind not on the config", async () => {
    const { id } = await shareWithAssets({ assetSpecs: [{ kind: "favicon_png" }], colorSeed: "#220004" });

    const res = await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assets: [
          { kind: "favicon_png", data_b64: SANITIZED_PNG_BASE64 },
          { kind: "logo_svg", data_b64: btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>') },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "missing_asset", message: expect.any(String) } });
  });

  it("400 bad_asset when the replacement fails the magic-byte check for its kind", async () => {
    const { id } = await shareWithAssets({ assetSpecs: [{ kind: "favicon_png" }], colorSeed: "#220005" });

    const res = await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [{ kind: "favicon_png", data_b64: btoa("not a png") }] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "bad_asset", message: expect.any(String) } });
  });

  it("400 bad_asset when the replacement exceeds the kind's size limit", async () => {
    const { id } = await shareWithAssets({ assetSpecs: [{ kind: "favicon_png" }], colorSeed: "#220006" });

    // 2 MiB limit for favicon_png; build a payload just over it that still
    // starts with the PNG magic bytes.
    const oversized = new Uint8Array(2 * 1024 * 1024 + 1);
    oversized.set([0x89, 0x50, 0x4e, 0x47]);
    const oversizedBase64 = bytesToBase64(oversized);

    const res = await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [{ kind: "favicon_png", data_b64: oversizedBase64 }] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "bad_asset", message: expect.any(String) } });
  });

  // -------------------------------------------------------------------------
  // Final-review Finding 1: mixed approved+pending state must not deadlock
  // approval. Full chain: share logo_svg -> admin approves it -> owner PUTs
  // keeping logo_svg (same sha256, stays 'approved') and adds a brand new
  // favicon_ico ('pending') -> admin approve with ONLY favicon_ico bytes
  // must succeed even though logo_svg is untouched and has no pending/
  // bytes left to submit.
  // -------------------------------------------------------------------------

  it("mixed approved+pending state: approve with only the pending kind's bytes succeeds; the already-approved kind is left untouched", async () => {
    const SVG_BASE64 = btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const token = makeToken();

    const { id } = await shareWithAssets({
      token,
      name: "Mixed Approve",
      assetSpecs: [{ kind: "logo_svg", base64: SVG_BASE64 }],
      colorSeed: "#221001",
    });
    const firstApprove = await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [{ kind: "logo_svg", data_b64: SVG_BASE64 }] }),
    });
    expect(firstApprove.status).toBe(200);
    const approvedLogoAsset = await assetRow(id, "logo_svg");

    // Owner PUT: keep logo_svg unchanged (identical sha256 -> stays
    // 'approved') and add a brand new favicon_ico ('pending'). Overall
    // assets_status recomputes to 'pending'.
    const icoBase64 = bytesToBase64(new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]));
    const logoAsset = await makeAsset("logo_svg", SVG_BASE64);
    const icoAsset = await makeAsset("favicon_ico", icoBase64);
    expect(logoAsset.manifest.sha256).toBe(approvedLogoAsset.sha256);

    const putRes = await SELF.fetch(`https://example.com/api/v1/themes/aurora/configs/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_token: token,
        name: "Mixed Approve",
        payload: makePayload({
          colors: { light_bg: "#221002" },
          assets: [logoAsset.manifest, icoAsset.manifest],
        }),
        assets: [logoAsset.body, icoAsset.body],
      }),
    });
    expect(putRes.status).toBe(200);
    expect((await configRow(id)).assets_status).toBe("pending");
    expect((await assetRow(id, "logo_svg")).status).toBe("approved");
    expect((await assetRow(id, "favicon_ico")).status).toBe("pending");

    // Before the fix, approve demanded the body cover ALL kinds (including
    // logo_svg, which has no pending/ bytes left) -> 400 missing_asset,
    // deadlocking approval forever. After the fix, submitting ONLY the
    // pending favicon_ico kind is exactly the required set -> 200.
    const sanitizedIco = bytesToBase64(new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x20, 0x20]));
    const approveRes = await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [{ kind: "favicon_ico", data_b64: sanitizedIco }] }),
    });
    expect(approveRes.status).toBe(200);
    expect(await approveRes.json()).toEqual({ id, approved: true });

    const finalConfig = await configRow(id);
    expect(finalConfig.assets_status).toBe("approved");

    // logo_svg: untouched by the second approve — same sha256/status as
    // after the first approval — and still served.
    const finalLogoAsset = await assetRow(id, "logo_svg");
    expect(finalLogoAsset.status).toBe("approved");
    expect(finalLogoAsset.sha256).toBe(approvedLogoAsset.sha256);
    const logoRes = await SELF.fetch(`https://example.com/assets/${id}/logo_svg`);
    expect(logoRes.status).toBe(200);
    await logoRes.arrayBuffer();

    // favicon_ico: freshly approved with the sanitized replacement bytes,
    // and now served too.
    const finalIcoAsset = await assetRow(id, "favicon_ico");
    expect(finalIcoAsset.status).toBe("approved");
    const icoRes = await SELF.fetch(`https://example.com/assets/${id}/favicon_ico`);
    expect(icoRes.status).toBe(200);
    expect(new Uint8Array(await icoRes.arrayBuffer())).toEqual(base64ToBytes(sanitizedIco));
  });

  it("400 missing_asset when the body includes an already-approved kind alongside the pending one (exact-set invariant)", async () => {
    const SVG_BASE64 = btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const token = makeToken();

    const { id } = await shareWithAssets({
      token,
      name: "Mixed Reject Extra",
      assetSpecs: [{ kind: "logo_svg", base64: SVG_BASE64 }],
      colorSeed: "#221003",
    });
    await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [{ kind: "logo_svg", data_b64: SVG_BASE64 }] }),
    });

    const icoBase64 = bytesToBase64(new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]));
    const logoAsset = await makeAsset("logo_svg", SVG_BASE64);
    const icoAsset = await makeAsset("favicon_ico", icoBase64);
    await SELF.fetch(`https://example.com/api/v1/themes/aurora/configs/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_token: token,
        name: "Mixed Reject Extra",
        payload: makePayload({
          colors: { light_bg: "#221004" },
          assets: [logoAsset.manifest, icoAsset.manifest],
        }),
        assets: [logoAsset.body, icoAsset.body],
      }),
    });

    // Including the already-approved logo_svg kind (an "extra" kind, since
    // only favicon_ico is actually pending) is rejected the same way any
    // other extra kind would be, keeping the exact-set invariant simple.
    const res = await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assets: [
          { kind: "logo_svg", data_b64: SVG_BASE64 },
          { kind: "favicon_ico", data_b64: icoBase64 },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "missing_asset", message: expect.any(String) } });

    // Nothing mutated by the rejected request.
    expect((await configRow(id)).assets_status).toBe("pending");
    expect((await assetRow(id, "logo_svg")).status).toBe("approved");
    expect((await assetRow(id, "favicon_ico")).status).toBe("pending");
  });

  it("409 not_pending for a config with no pending assets (assets_status 'none')", async () => {
    const res0 = await SELF.fetch(SHARE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_token: makeToken(),
        name: "No Assets",
        payload: makePayload({ colors: { light_bg: "#220007" } }),
      }),
    });
    const { id } = await res0.json();

    const res = await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [] }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "not_pending", message: expect.any(String) } });
  });

  it("409 not_pending for an unknown config id", async () => {
    const res = await adminFetch("/api/v1/admin/configs/nonexist/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [] }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "not_pending", message: expect.any(String) } });
  });
});

// ---------------------------------------------------------------------------
// #12 POST /api/v1/admin/configs/:id/reject
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/configs/:id/reject", () => {
  it("clears pending R2 objects and assets rows, sets assets_status='rejected', config stays active", async () => {
    const { id } = await shareWithAssets({ assetSpecs: [{ kind: "favicon_png" }], colorSeed: "#230001" });

    const res = await adminFetch(`/api/v1/admin/configs/${id}/reject`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, rejected: true });

    const config = await configRow(id);
    expect(config.status).toBe("active");
    expect(config.assets_status).toBe("rejected");

    const asset = await assetRow(id, "favicon_png");
    expect(asset).toBeNull();

    const pendingObject = await env.R2.get(`pending/${id}/favicon_png`);
    expect(pendingObject).toBeNull();

    // Still active -> still visible in the public browse list.
    const listRes = await SELF.fetch("https://example.com/api/v1/themes/aurora/configs?sort=new");
    const listBody = await listRes.json();
    expect(listBody.items.map((i) => i.id)).toContain(id);
  });

  it("mixed pending+approved state: reject drops only the pending kind, leaves the approved kind live", async () => {
    const SVG_BASE64 = btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const token = makeToken();

    // 1. Share with just logo_svg, then admin-approve it (reusing the same
    // bytes as the "sanitized" replacement, for simplicity).
    const { id } = await shareWithAssets({
      token,
      assetSpecs: [{ kind: "logo_svg", base64: SVG_BASE64 }],
      colorSeed: "#270001",
    });
    const approveRes = await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [{ kind: "logo_svg", data_b64: SVG_BASE64 }] }),
    });
    expect(approveRes.status).toBe(200);
    const approvedAsset = await assetRow(id, "logo_svg");
    expect(approvedAsset.status).toBe("approved");

    // 2. Owner PUT: keep logo_svg unchanged (identical sha256 to the approved
    // row, so updateConfig's diff treats it as "kept") and add a brand new
    // favicon_ico. This produces the mixed state: logo_svg stays 'approved',
    // favicon_ico is freshly 'pending', and the config's overall
    // assets_status recomputes to 'pending' because anything is pending.
    const icoBase64 = bytesToBase64(new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]));
    const logoAsset = await makeAsset("logo_svg", SVG_BASE64);
    const icoAsset = await makeAsset("favicon_ico", icoBase64);
    expect(logoAsset.manifest.sha256).toBe(approvedAsset.sha256);

    const putRes = await SELF.fetch(`https://example.com/api/v1/themes/aurora/configs/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_token: token,
        name: "Mixed State",
        payload: makePayload({
          colors: { light_bg: "#270002" },
          assets: [logoAsset.manifest, icoAsset.manifest],
        }),
        assets: [logoAsset.body, icoAsset.body],
      }),
    });
    expect(putRes.status).toBe(200);

    const midConfig = await configRow(id);
    expect(midConfig.assets_status).toBe("pending");
    expect((await assetRow(id, "logo_svg")).status).toBe("approved");
    expect((await assetRow(id, "favicon_ico")).status).toBe("pending");

    // 3. Admin reject: only the pending favicon_ico kind should be dropped —
    // the already-approved logo_svg row/object must survive untouched.
    const rejectRes = await adminFetch(`/api/v1/admin/configs/${id}/reject`, { method: "POST" });
    expect(rejectRes.status).toBe(200);
    expect(await rejectRes.json()).toEqual({ id, rejected: true });

    const afterConfig = await configRow(id);
    expect(afterConfig.assets_status).toBe("approved");

    expect((await assetRow(id, "logo_svg")).status).toBe("approved");
    expect(await assetRow(id, "favicon_ico")).toBeNull();

    expect(await env.R2.get(`pending/${id}/favicon_ico`)).toBeNull();
    const stillApprovedObject = await env.R2.get(`approved/${id}/logo_svg`);
    expect(stillApprovedObject).not.toBeNull();
    await stillApprovedObject.arrayBuffer();

    const publicRes = await SELF.fetch(`https://example.com/assets/${id}/logo_svg`);
    expect(publicRes.status).toBe(200);
    await publicRes.arrayBuffer();
  });

  it("409 not_pending for a config that is not currently pending", async () => {
    const res0 = await SELF.fetch(SHARE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_token: makeToken(),
        name: "No Assets",
        payload: makePayload({ colors: { light_bg: "#230002" } }),
      }),
    });
    const { id } = await res0.json();

    const res = await adminFetch(`/api/v1/admin/configs/${id}/reject`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "not_pending", message: expect.any(String) } });
  });
});

// ---------------------------------------------------------------------------
// #13 POST /api/v1/admin/configs/:id/takedown
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/configs/:id/takedown", () => {
  it("removes the config, deletes assets rows and both R2 states; public detail 404s", async () => {
    const { id } = await shareWithAssets({ assetSpecs: [{ kind: "favicon_png" }], colorSeed: "#240001" });
    await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [{ kind: "favicon_png", data_b64: SANITIZED_PNG_BASE64 }] }),
    });

    const res = await adminFetch(`/api/v1/admin/configs/${id}/takedown`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, removed: true });

    const config = await configRow(id);
    expect(config.status).toBe("removed");

    const asset = await assetRow(id, "favicon_png");
    expect(asset).toBeNull();

    expect(await env.R2.get(`approved/${id}/favicon_png`)).toBeNull();
    expect(await env.R2.get(`pending/${id}/favicon_png`)).toBeNull();

    const detailRes = await SELF.fetch(`https://example.com/api/v1/themes/aurora/configs/${id}`);
    expect(detailRes.status).toBe(404);
  });

  it("404 not_found for an unknown config id", async () => {
    const res = await adminFetch("/api/v1/admin/configs/nonexist/takedown", { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("404 not_found for an already-removed config", async () => {
    const { id } = await shareWithAssets({ colorSeed: "#240002" });
    await env.DB.prepare("UPDATE configs SET status = 'removed' WHERE id = ?").bind(id).run();

    const res = await adminFetch(`/api/v1/admin/configs/${id}/takedown`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// #14 POST /api/v1/admin/devices/:device_id/ban
// ---------------------------------------------------------------------------

describe("POST /api/v1/admin/devices/:device_id/ban", () => {
  it("bans the device, removes all its active configs (both R2 states gone), and blocks future shares", async () => {
    const token = makeToken();
    // idA gets an approved asset (so the cascade's approved/ cleanup is
    // exercised too); idB is left with a still-pending one.
    const { id: idA } = await shareWithAssets({
      token,
      name: "A",
      assetSpecs: [{ kind: "favicon_png" }],
      colorSeed: "#250001",
    });
    await adminFetch(`/api/v1/admin/configs/${idA}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [{ kind: "favicon_png", data_b64: SANITIZED_PNG_BASE64 }] }),
    });
    const { id: idB } = await shareWithAssets({
      token,
      name: "B",
      assetSpecs: [{ kind: "favicon_ico", base64: bytesToBase64(new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00])) }],
      colorSeed: "#250002",
    });

    const deviceId = (await configRow(idA)).device_id;

    const res = await adminFetch(`/api/v1/admin/devices/${deviceId}/ban`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ device_id: deviceId, banned: true, removed_configs: 2 });

    const device = await env.DB.prepare("SELECT banned FROM devices WHERE id = ?").bind(deviceId).first();
    expect(device.banned).toBe(1);

    expect((await configRow(idA)).status).toBe("removed");
    expect((await configRow(idB)).status).toBe("removed");

    expect(await env.R2.get(`approved/${idA}/favicon_png`)).toBeNull();
    expect(await env.R2.get(`pending/${idA}/favicon_png`)).toBeNull();
    expect(await env.R2.get(`approved/${idB}/favicon_ico`)).toBeNull();
    expect(await env.R2.get(`pending/${idB}/favicon_ico`)).toBeNull();

    const listRes = await SELF.fetch("https://example.com/api/v1/themes/aurora/configs?sort=new");
    const listIds = (await listRes.json()).items.map((i) => i.id);
    expect(listIds).not.toContain(idA);
    expect(listIds).not.toContain(idB);

    const shareRes = await SELF.fetch(SHARE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_token: token,
        name: "Banned Retry",
        payload: makePayload({ colors: { light_bg: "#250003" } }),
      }),
    });
    expect(shareRes.status).toBe(403);
    expect(await shareRes.json()).toEqual({ error: { code: "device_banned", message: expect.any(String) } });
  });

  it("404 not_found for an unknown device id", async () => {
    const res = await adminFetch("/api/v1/admin/devices/nonexist/ban", { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("removed_configs:0 for a device with no active configs left", async () => {
    const token = makeToken();
    const { id } = await shareWithAssets({ token, colorSeed: "#250004" });
    const deviceId = (await configRow(id)).device_id;
    await env.DB.prepare("UPDATE configs SET status = 'removed' WHERE id = ?").bind(id).run();

    const res = await adminFetch(`/api/v1/admin/devices/${deviceId}/ban`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ device_id: deviceId, banned: true, removed_configs: 0 });
  });
});

// ---------------------------------------------------------------------------
// #15 GET /api/v1/admin/reports, POST /api/v1/admin/reports/:rid/resolve
// ---------------------------------------------------------------------------

describe("admin reports", () => {
  async function fileReport(configId, reason) {
    const res = await SELF.fetch(`https://example.com/api/v1/themes/aurora/configs/${configId}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    expect(res.status).toBe(200);
  }

  it("lists only unresolved reports, newest first, and resolve flips resolved=1", async () => {
    const { id } = await shareWithAssets({ colorSeed: "#260001" });
    await fileReport(id, "spam content");
    await fileReport(id, "offensive content");

    const listRes = await adminFetch("/api/v1/admin/reports");
    expect(listRes.status).toBe(200);
    const body = await listRes.json();
    const mine = body.items.filter((r) => r.config_id === id);
    expect(mine).toHaveLength(2);
    expect(mine[0].created_at >= mine[1].created_at || mine[0].id > mine[1].id).toBe(true);
    expect(mine[0]).toEqual({
      id: expect.any(Number),
      config_id: id,
      reason: expect.any(String),
      ip: expect.any(String),
      created_at: expect.any(String),
    });

    const rid = mine[0].id;
    const resolveRes = await adminFetch(`/api/v1/admin/reports/${rid}/resolve`, { method: "POST" });
    expect(resolveRes.status).toBe(200);
    expect(await resolveRes.json()).toEqual({ id: rid, resolved: true });

    const afterRes = await adminFetch("/api/v1/admin/reports");
    const afterBody = await afterRes.json();
    expect(afterBody.items.map((r) => r.id)).not.toContain(rid);
  });

  it("404 not_found when resolving an unknown report id", async () => {
    const res = await adminFetch("/api/v1/admin/reports/999999/resolve", { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("404 not_found when resolving a non-numeric report id", async () => {
    const res = await adminFetch("/api/v1/admin/reports/not-a-number/resolve", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Fonts are approved from the bytes already in storage, never round-tripped
// through the request body. A full-coverage CJK woff2 is several MB, and
// base64ing two of them alongside the images pushes the approve body past
// ADMIN_APPROVE_BODY_BYTES -- a config that can be shared but never approved.
//
// This whole path had no coverage before: the console was free to change the
// wire format without a single test noticing.
// ---------------------------------------------------------------------------

describe("admin approve: fonts come from pending/, not the body", () => {
  const WOFF2_BYTES = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0x02, 0x03]);
  const WOFF2_BASE64 = bytesToBase64(WOFF2_BYTES);
  const SVG_BASE64 = btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

  it("approves a font from its stored bytes and keeps them byte-for-byte", async () => {
    const { id } = await shareWithAssets({
      name: "Fonted",
      assetSpecs: [{ kind: "font_sans", base64: WOFF2_BASE64 }],
      colorSeed: "#301001",
    });

    const res = await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [{ kind: "font_sans", passthrough: true }] }),
    });
    expect(res.status).toBe(200);

    const row = await assetRow(id, "font_sans");
    expect(row.status).toBe("approved");
    expect(row.size).toBe(WOFF2_BYTES.byteLength);

    const object = await env.R2.get(`approved/${id}/font_sans`);
    expect(object).not.toBeNull();
    const stored = new Uint8Array(await object.arrayBuffer());
    expect(bytesToBase64(stored)).toBe(WOFF2_BASE64);
  });

  // The passthrough form must not become a way to post arbitrary bytes under
  // a name that says nobody looked at them.
  it("refuses a font that also carries data_b64", async () => {
    const { id } = await shareWithAssets({
      name: "Smuggler",
      assetSpecs: [{ kind: "font_sans", base64: WOFF2_BASE64 }],
      colorSeed: "#301002",
    });

    const res = await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        assets: [{ kind: "font_sans", passthrough: true, data_b64: WOFF2_BASE64 }],
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("missing_asset");
    expect(await assetRow(id, "font_sans")).toMatchObject({ status: "pending" });
  });

  it("refuses a font sent the old way, as data_b64", async () => {
    const { id } = await shareWithAssets({
      name: "OldClient",
      assetSpecs: [{ kind: "font_sans", base64: WOFF2_BASE64 }],
      colorSeed: "#301003",
    });

    const res = await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [{ kind: "font_sans", data_b64: WOFF2_BASE64 }] }),
    });
    expect(res.status).toBe(400);
    expect(await assetRow(id, "font_sans")).toMatchObject({ status: "pending" });
  });

  // The guard that matters most: if a kind that DOES get rewritten could be
  // waved through as passthrough, approve would store bytes no sanitizer ever
  // touched. That is the whole risk this wire format exists to prevent.
  it("refuses passthrough for a kind the console must sanitize", async () => {
    const { id } = await shareWithAssets({
      name: "Unsanitized",
      assetSpecs: [{ kind: "logo_svg", base64: SVG_BASE64 }],
      colorSeed: "#301004",
    });

    const res = await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [{ kind: "logo_svg", passthrough: true }] }),
    });
    expect(res.status).toBe(400);
    // The code matters as much as the status: this must be refused for
    // claiming passthrough on a sanitized kind, not incidentally because
    // some downstream check choked on a missing body. Asserting only the
    // status let a mutation that dropped the server's own opinion of which
    // kinds are passthrough still pass this test.
    expect((await res.json()).error.code).toBe("missing_asset");
    expect(await assetRow(id, "logo_svg")).toMatchObject({ status: "pending" });
  });

  it("409 when the pending bytes are gone from storage", async () => {
    const { id } = await shareWithAssets({
      name: "Vanished",
      assetSpecs: [{ kind: "font_mono", base64: WOFF2_BASE64 }],
      colorSeed: "#301005",
    });

    await env.R2.delete(`pending/${id}/font_mono`);

    const res = await adminFetch(`/api/v1/admin/configs/${id}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assets: [{ kind: "font_mono", passthrough: true }] }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("assets_incomplete");
    expect(await assetRow(id, "font_mono")).toMatchObject({ status: "pending" });
  });

  // The size arithmetic that made this necessary, asserted rather than
  // narrated: with fonts in the body, a maxed-out config would not fit.
  it("a maxed-out config's images fit the approve cap once fonts are out of the body", async () => {
    const IMAGE_KINDS = ["logo_svg", "favicon_png", "favicon_ico", "pwa_icon_192", "pwa_icon_512", "login_bg"];
    const base64Size = (bytes) => Math.ceil(bytes / 3) * 4;
    const imagesOnly = IMAGE_KINDS.reduce((sum, kind) => sum + base64Size(ASSET_SIZE_LIMITS[kind]), 0);
    const withFonts =
      imagesOnly +
      base64Size(ASSET_SIZE_LIMITS.font_sans) +
      base64Size(ASSET_SIZE_LIMITS.font_mono);

    expect(imagesOnly).toBeLessThan(ADMIN_APPROVE_BODY_BYTES);
    expect(withFonts).toBeGreaterThan(ADMIN_APPROVE_BODY_BYTES);
  });
});
