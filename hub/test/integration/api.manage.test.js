import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/ids.js";
import { makeAsset, makePayload, makeToken, PNG_1X1_BASE64 } from "../helpers.js";

const CONFIGS_URL = "https://example.com/api/v1/themes/aurora/configs";

function configUrl(id) {
  return `${CONFIGS_URL}/${id}`;
}

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

// A second valid PNG fixture, distinct from helpers.js's PNG_1X1_BASE64 —
// only the 4-byte magic prefix is checked by the share/update pipeline, so
// arbitrary trailing bytes are fine and this hashes differently.
const ALT_PNG_BASE64 = bytesToBase64(
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xff, 0xee, 0xee])
);

// Minimal bytes passing the ICO magic-byte sniff (00 00 01 00 ...), used
// alongside favicon_png to exercise the multi-kind assets_status recompute.
const ICO_BASE64 = bytesToBase64(new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]));

function putJson(id, body) {
  return SELF.fetch(configUrl(id), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteJson(id, body) {
  return SELF.fetch(configUrl(id), {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function shareConfig({ token = makeToken(), name = "Original", payload = makePayload(), assets } = {}) {
  const body = { device_token: token, name, payload };
  if (assets !== undefined) body.assets = assets;

  const res = await SELF.fetch(CONFIGS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  const { id } = await res.json();
  return { id, token };
}

async function configRow(id) {
  return env.DB.prepare("SELECT * FROM configs WHERE id = ?").bind(id).first();
}

async function assetRow(id, kind) {
  return env.DB.prepare("SELECT * FROM assets WHERE config_id = ? AND kind = ?").bind(id, kind).first();
}

async function approveAsset(id, kind, bytes) {
  await env.DB.prepare("UPDATE assets SET status = 'approved' WHERE config_id = ? AND kind = ?").bind(id, kind).run();
  await env.R2.put(`approved/${id}/${kind}`, bytes);
}

describe("PUT /api/v1/themes/:theme/configs/:id", () => {
  it("unknown theme segment returns 404 unknown_theme", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/themes/nope/configs/whatever", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "unknown_theme", message: expect.any(String) } });
  });

  it("owner PUT updates name and payload: 200 {id, version:2}, content_hash changes", async () => {
    const { id, token } = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000101" } }) });
    const before = await configRow(id);

    const res = await putJson(id, {
      device_token: token,
      name: "Updated Name",
      payload: makePayload({ colors: { light_bg: "#000102" } }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, version: 2 });

    const after = await configRow(id);
    expect(after.name).toBe("Updated Name");
    expect(after.version).toBe(2);
    expect(after.content_hash).not.toBe(before.content_hash);
    expect(after.updated_at).toEqual(expect.any(String));
  });

  it("a well-formed but unregistered device_token returns 403 not_owner and leaves the config unchanged", async () => {
    const { id } = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000103" } }) });
    const before = await configRow(id);

    const res = await putJson(id, {
      device_token: makeToken(),
      name: "Hijacked",
      payload: makePayload({ colors: { light_bg: "#000104" } }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "not_owner", message: expect.any(String) } });
    expect(await configRow(id)).toEqual(before);
  });

  it("another registered device's token returns 403 not_owner and leaves the config unchanged", async () => {
    const { id } = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000105" } }) });
    const other = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000106" } }) });
    const before = await configRow(id);

    const res = await putJson(id, {
      device_token: other.token,
      name: "Hijacked Again",
      payload: makePayload({ colors: { light_bg: "#000107" } }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "not_owner", message: expect.any(String) } });
    expect(await configRow(id)).toEqual(before);
  });

  it("a malformed device_token returns 400 bad_token", async () => {
    const { id } = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000108" } }) });

    const res = await putJson(id, {
      device_token: "not-a-token",
      name: "Bad Token",
      payload: makePayload({ colors: { light_bg: "#000109" } }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "bad_token", message: expect.any(String) } });
  });

  it("a banned owner device returns 403 device_banned", async () => {
    const { id, token } = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000110" } }) });
    const hash = await sha256Hex(token);
    await env.DB.prepare("UPDATE devices SET banned = 1 WHERE secret_hash = ?").bind(hash).run();

    const res = await putJson(id, {
      device_token: token,
      name: "Banned Update",
      payload: makePayload({ colors: { light_bg: "#000111" } }),
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "device_banned", message: expect.any(String) } });
  });

  it("an unknown config id returns 404 not_found (for a real, registered device)", async () => {
    const { token } = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000112" } }) });

    const res = await putJson("nosuchid1", {
      device_token: token,
      name: "Ghost",
      payload: makePayload({ colors: { light_bg: "#000113" } }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("an unregistered device_token against a nonexistent id returns 404 not_found, not 403 (existence is checked first)", async () => {
    const res = await putJson("ghostid1", {
      device_token: makeToken(),
      name: "Ghost",
      payload: makePayload({ colors: { light_bg: "#000113a" } }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("PUT on a removed config returns 404 not_found", async () => {
    const { id, token } = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000114" } }) });
    await env.DB.prepare("UPDATE configs SET status = 'removed' WHERE id = ?").bind(id).run();

    const res = await putJson(id, {
      device_token: token,
      name: "Should 404",
      payload: makePayload({ colors: { light_bg: "#000115" } }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("invalid payload returns 400 and leaves the config unchanged", async () => {
    const { id, token } = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000116" } }) });
    const before = await configRow(id);

    const res = await putJson(id, {
      device_token: token,
      name: "Bad Payload",
      payload: { schema: 1, theme: "aurora" },
    });

    expect(res.status).toBe(400);
    expect(await configRow(id)).toEqual(before);
  });

  it("duplicate content vs another active config returns 409 duplicate_content and leaves both unchanged", async () => {
    const other = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000117" } }) });
    const { id, token } = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000118" } }) });
    const beforeThis = await configRow(id);
    const beforeOther = await configRow(other.id);

    const res = await putJson(id, {
      device_token: token,
      name: "Dup Attempt",
      payload: makePayload({ colors: { light_bg: "#000117" } }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "duplicate_content", message: expect.any(String) } });
    expect(await configRow(id)).toEqual(beforeThis);
    expect(await configRow(other.id)).toEqual(beforeOther);
  });

  it("keeping the same sha256 for an approved asset leaves it approved (not reset to pending)", async () => {
    const asset = await makeAsset("favicon_png");
    const { id, token } = await shareConfig({
      payload: makePayload({ colors: { light_bg: "#000119" }, assets: [asset.manifest] }),
      assets: [asset.body],
    });
    await approveAsset(id, "favicon_png", base64ToBytes(PNG_1X1_BASE64));

    const res = await putJson(id, {
      device_token: token,
      name: "Same Asset",
      payload: makePayload({ colors: { light_bg: "#000120" }, assets: [asset.manifest] }),
      assets: [asset.body],
    });

    expect(res.status).toBe(200);

    const row = await assetRow(id, "favicon_png");
    expect(row.status).toBe("approved");
    expect(row.sha256).toBe(asset.manifest.sha256);

    const config = await configRow(id);
    expect(config.assets_status).toBe("approved");

    const approvedObj = await env.R2.get(`approved/${id}/favicon_png`);
    expect(approvedObj).not.toBeNull();
    await approvedObj.arrayBuffer();
  });

  it("a changed sha256 for a previously approved asset resets it to pending with new R2 bytes", async () => {
    const assetV1 = await makeAsset("favicon_png");
    const { id, token } = await shareConfig({
      payload: makePayload({ colors: { light_bg: "#000121" }, assets: [assetV1.manifest] }),
      assets: [assetV1.body],
    });
    await approveAsset(id, "favicon_png", base64ToBytes(PNG_1X1_BASE64));

    const assetV2 = await makeAsset("favicon_png", ALT_PNG_BASE64);
    const res = await putJson(id, {
      device_token: token,
      name: "Changed Asset",
      payload: makePayload({ colors: { light_bg: "#000122" }, assets: [assetV2.manifest] }),
      assets: [assetV2.body],
    });

    expect(res.status).toBe(200);

    const row = await assetRow(id, "favicon_png");
    expect(row.status).toBe("pending");
    expect(row.sha256).toBe(assetV2.manifest.sha256);
    expect(row.size).toBe(assetV2.manifest.size);

    const config = await configRow(id);
    expect(config.assets_status).toBe("pending");

    const pendingObj = await env.R2.get(`pending/${id}/favicon_png`);
    expect(pendingObj).not.toBeNull();
    const stored = new Uint8Array(await pendingObj.arrayBuffer());
    expect(stored.byteLength).toBe(assetV2.manifest.size);

    // The stale approved copy from before is left as-is by this flow (the
    // row itself, not R2, is the gate on what's servable) — approved/ is
    // only cleaned up by the asset-drop path (see the next test) or a
    // future admin re-approval, not by a sha256-changed-but-kind-kept PUT.
    const approvedObj = await env.R2.get(`approved/${id}/favicon_png`);
    expect(approvedObj).not.toBeNull();
    await approvedObj.arrayBuffer();
  });

  it("dropping a kind from the manifest deletes its assets row and both R2 objects", async () => {
    const asset = await makeAsset("favicon_png");
    const { id, token } = await shareConfig({
      payload: makePayload({ colors: { light_bg: "#000123" }, assets: [asset.manifest] }),
      assets: [asset.body],
    });
    await approveAsset(id, "favicon_png", base64ToBytes(PNG_1X1_BASE64));
    const preexistingPending = await env.R2.get(`pending/${id}/favicon_png`);
    expect(preexistingPending).not.toBeNull();
    await preexistingPending.arrayBuffer();

    const res = await putJson(id, {
      device_token: token,
      name: "No More Asset",
      payload: makePayload({ colors: { light_bg: "#000124" } }),
    });

    expect(res.status).toBe(200);

    expect(await assetRow(id, "favicon_png")).toBeNull();
    expect(await env.R2.get(`pending/${id}/favicon_png`)).toBeNull();
    expect(await env.R2.get(`approved/${id}/favicon_png`)).toBeNull();

    const config = await configRow(id);
    expect(config.assets_status).toBe("none");
  });

  it("keeping one approved kind and adding a brand-new kind recomputes assets_status to 'pending', leaving the kept kind approved and the new kind pending", async () => {
    const faviconPng = await makeAsset("favicon_png");
    const { id, token } = await shareConfig({
      payload: makePayload({ colors: { light_bg: "#000125" }, assets: [faviconPng.manifest] }),
      assets: [faviconPng.body],
    });
    await approveAsset(id, "favicon_png", base64ToBytes(PNG_1X1_BASE64));

    const faviconIco = await makeAsset("favicon_ico", ICO_BASE64);
    const res = await putJson(id, {
      device_token: token,
      name: "Add A Kind",
      payload: makePayload({
        colors: { light_bg: "#000126" },
        assets: [faviconPng.manifest, faviconIco.manifest],
      }),
      assets: [faviconPng.body, faviconIco.body],
    });

    expect(res.status).toBe(200);

    const config = await configRow(id);
    expect(config.assets_status).toBe("pending");

    const pngRow = await assetRow(id, "favicon_png");
    expect(pngRow.status).toBe("approved");
    expect(pngRow.sha256).toBe(faviconPng.manifest.sha256);

    const icoRow = await assetRow(id, "favicon_ico");
    expect(icoRow.status).toBe("pending");
    expect(icoRow.sha256).toBe(faviconIco.manifest.sha256);

    const icoObj = await env.R2.get(`pending/${id}/favicon_ico`);
    expect(icoObj).not.toBeNull();
    await icoObj.arrayBuffer();
  });

  it("body over 12 MB is rejected with 413 too_large before any parsing", async () => {
    const bigBody = "x".repeat(12 * 1024 * 1024 + 10);
    const res = await SELF.fetch(configUrl("whatever1"), { method: "PUT", body: bigBody });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: { code: "too_large", message: expect.any(String) } });
  });
});

describe("DELETE /api/v1/themes/:theme/configs/:id", () => {
  it("unknown theme segment returns 404 unknown_theme", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/themes/nope/configs/whatever", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "unknown_theme", message: expect.any(String) } });
  });

  it("owner DELETE removes the config, its assets rows, and all R2 objects; detail 404s and it drops from the list", async () => {
    const asset = await makeAsset("favicon_png");
    const { id, token } = await shareConfig({
      name: "To Delete",
      payload: makePayload({ colors: { light_bg: "#000201" }, assets: [asset.manifest] }),
      assets: [asset.body],
    });
    await approveAsset(id, "favicon_png", base64ToBytes(PNG_1X1_BASE64));

    // Seed a dl_dedup row and a reports row against the still-active config
    // — the brief says these are left alone by DELETE (history for an
    // already-removed config stays meaningful), so both must still be
    // present afterwards.
    await env.DB.prepare("INSERT INTO dl_dedup (config_id, device_hash) VALUES (?, ?)").bind(id, "f".repeat(64)).run();
    await env.DB.prepare("INSERT INTO reports (config_id, reason, ip) VALUES (?, ?, ?)").bind(id, "spam", "203.0.113.99").run();

    const res = await deleteJson(id, { device_token: token });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, removed: true });

    const row = await configRow(id);
    expect(row.status).toBe("removed");

    expect(await assetRow(id, "favicon_png")).toBeNull();
    expect(await env.R2.get(`pending/${id}/favicon_png`)).toBeNull();
    expect(await env.R2.get(`approved/${id}/favicon_png`)).toBeNull();

    const detail = await SELF.fetch(configUrl(id));
    expect(detail.status).toBe(404);

    const list = await SELF.fetch(`${CONFIGS_URL}?sort=new`);
    const listBody = await list.json();
    expect(listBody.items.find((item) => item.id === id)).toBeUndefined();

    const dlDedupRow = await env.DB
      .prepare("SELECT * FROM dl_dedup WHERE config_id = ? AND device_hash = ?")
      .bind(id, "f".repeat(64))
      .first();
    expect(dlDedupRow).toMatchObject({ config_id: id, device_hash: "f".repeat(64) });

    const reportRow = await env.DB.prepare("SELECT * FROM reports WHERE config_id = ?").bind(id).first();
    expect(reportRow).toMatchObject({ config_id: id, reason: "spam", ip: "203.0.113.99" });
  });

  it("a well-formed but unregistered device_token returns 403 not_owner and leaves the config active", async () => {
    const { id } = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000202" } }) });

    const res = await deleteJson(id, { device_token: makeToken() });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "not_owner", message: expect.any(String) } });

    const row = await configRow(id);
    expect(row.status).toBe("active");
  });

  it("another registered device's token returns 403 not_owner and leaves the config active", async () => {
    const { id } = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000203" } }) });
    const other = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000204" } }) });

    const res = await deleteJson(id, { device_token: other.token });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "not_owner", message: expect.any(String) } });

    const row = await configRow(id);
    expect(row.status).toBe("active");
  });

  it("a banned owner device returns 403 device_banned", async () => {
    const { id, token } = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000205" } }) });
    const hash = await sha256Hex(token);
    await env.DB.prepare("UPDATE devices SET banned = 1 WHERE secret_hash = ?").bind(hash).run();

    const res = await deleteJson(id, { device_token: token });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "device_banned", message: expect.any(String) } });
  });

  it("an unknown config id returns 404 not_found (for a real, registered device)", async () => {
    const { token } = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000206" } }) });

    const res = await deleteJson("nosuchid2", { device_token: token });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("an unregistered device_token against a nonexistent id returns 404 not_found, not 403 (existence is checked first)", async () => {
    const res = await deleteJson("ghostid2", { device_token: makeToken() });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("DELETE on an already-removed config returns 404 not_found", async () => {
    const { id, token } = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000207" } }) });
    await env.DB.prepare("UPDATE configs SET status = 'removed' WHERE id = ?").bind(id).run();

    const res = await deleteJson(id, { device_token: token });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("re-sharing the exact same content after DELETE succeeds (dedup index freed)", async () => {
    const payload = makePayload({ colors: { light_bg: "#000208" } });
    const { id, token } = await shareConfig({ payload });
    await deleteJson(id, { device_token: token });

    const res = await SELF.fetch(CONFIGS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_token: makeToken(), name: "Reshared", payload }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).not.toBe(id);
  });
});
