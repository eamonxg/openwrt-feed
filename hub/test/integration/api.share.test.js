import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/ids.js";
import { makeAsset, makePayload, makeToken } from "../helpers.js";

const SHARE_URL = "https://example.com/api/v1/themes/aurora/configs";

function shareRequest(body) {
  return SELF.fetch(SHARE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/themes/:theme/configs", () => {
  it("unknown theme segment returns 404 unknown_theme", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/themes/nope/configs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: { code: "unknown_theme", message: expect.any(String) } });
  });

  it("body over 12 MB is rejected with 413 too_large before any parsing", async () => {
    const bigBody = "x".repeat(12 * 1024 * 1024 + 10);
    const res = await SELF.fetch(SHARE_URL, { method: "POST", body: bigBody });

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body).toEqual({ error: { code: "too_large", message: expect.any(String) } });
  });

  it("a chunked body with no Content-Length that exceeds the cap is still rejected with 413 (streaming reader)", async () => {
    const chunkSize = 1024 * 1024; // 1 MiB
    const totalChunks = 13; // 13 MiB total, over the 12 MiB cap
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < totalChunks; i++) {
          controller.enqueue(new Uint8Array(chunkSize));
        }
        controller.close();
      },
    });

    const res = await SELF.fetch(SHARE_URL, { method: "POST", body: stream, duplex: "half" });

    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body).toEqual({ error: { code: "too_large", message: expect.any(String) } });
  });

  it("a small chunked body with no Content-Length parses normally: 200", async () => {
    const token = makeToken();
    const json = JSON.stringify({
      device_token: token,
      name: "Streamed",
      payload: makePayload({ colors: { light_bg: "#000004" } }),
    });
    const bytes = new TextEncoder().encode(json);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    const res = await SELF.fetch(SHARE_URL, { method: "POST", body: stream, duplex: "half" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: expect.any(String), manage: true });
  });

  it("shares a config with no assets: 200, D1 row, assets_status='none'", async () => {
    const token = makeToken();
    const res = await shareRequest({
      device_token: token,
      name: "My Theme",
      payload: makePayload(),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ id: expect.any(String), manage: true });

    // No author column here any more -- the config row only records which
    // device owns it, and the display name is joined from that device's
    // profile at read time.
    const row = await env.DB.prepare("SELECT * FROM configs WHERE id = ?").bind(body.id).first();
    expect(row).toMatchObject({
      id: body.id,
      theme: "aurora",
      name: "My Theme",
      assets_status: "none",
      status: "active",
    });
    expect(row).not.toHaveProperty("author");
  });

  it("shares a config with a PNG asset: 200, R2 object at pending/{id}/{kind}, assets_status='pending'", async () => {
    const token = makeToken();
    const asset = await makeAsset("favicon_png");
    const res = await shareRequest({
      device_token: token,
      name: "With Asset",
      payload: makePayload({ assets: [asset.manifest] }),
      assets: [asset.body],
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    const row = await env.DB.prepare("SELECT assets_status FROM configs WHERE id = ?").bind(body.id).first();
    expect(row.assets_status).toBe("pending");

    const assetRow = await env.DB
      .prepare("SELECT * FROM assets WHERE config_id = ? AND kind = ?")
      .bind(body.id, "favicon_png")
      .first();
    expect(assetRow).toMatchObject({
      config_id: body.id,
      kind: "favicon_png",
      r2_key: `pending/${body.id}/favicon_png`,
      sha256: asset.manifest.sha256,
      size: asset.manifest.size,
      status: "pending",
    });

    const object = await env.R2.get(`pending/${body.id}/favicon_png`);
    expect(object).not.toBeNull();
    const stored = new Uint8Array(await object.arrayBuffer());
    expect(stored.byteLength).toBe(asset.manifest.size);
  });

  it("duplicate content returns 200 {id, duplicate:true} and does not insert a new row", async () => {
    const payload = makePayload({ colors: { light_bg: "#000001" } });

    const first = await shareRequest({ device_token: makeToken(), name: "First", payload });
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const countBefore = await env.DB.prepare("SELECT COUNT(*) AS n FROM configs").first();

    const second = await shareRequest({ device_token: makeToken(), name: "Second", payload });
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody).toEqual({ id: firstBody.id, duplicate: true });

    const countAfter = await env.DB.prepare("SELECT COUNT(*) AS n FROM configs").first();
    expect(countAfter.n).toBe(countBefore.n);
  });

  it("malformed device_token returns 400 bad_token", async () => {
    const res = await shareRequest({
      device_token: "not-a-token",
      name: "Bad Token",
      payload: makePayload(),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: { code: "bad_token", message: expect.any(String) } });
  });

  it("a banned device is rejected with 403 device_banned", async () => {
    const token = makeToken();
    const hash = await sha256Hex(token);
    await env.DB.prepare(
      "INSERT INTO devices (id, secret_hash, banned) VALUES (?, ?, 1)"
    )
      .bind("bandev01", hash)
      .run();

    const res = await shareRequest({
      device_token: token,
      name: "Should Be Banned",
      payload: makePayload(),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: { code: "device_banned", message: expect.any(String) } });
  });

  it("the 11th share in a day is rejected with 429 quota_exceeded", async () => {
    const token = makeToken();

    for (let i = 0; i < 10; i++) {
      const res = await shareRequest({
        device_token: token,
        name: `Quota ${i}`,
        payload: makePayload({ colors: { light_bg: `#00000${i}` } }),
      });
      expect(res.status).toBe(200);
    }

    const eleventh = await shareRequest({
      device_token: token,
      name: "Quota 11",
      payload: makePayload({ colors: { light_bg: "#00000a" } }),
    });

    expect(eleventh.status).toBe(429);
    const body = await eleventh.json();
    expect(body).toEqual({ error: { code: "quota_exceeded", message: expect.any(String) } });
  });

  it("a sha256 mismatch between manifest and provided bytes returns 400 asset_mismatch", async () => {
    const token = makeToken();
    const asset = await makeAsset("favicon_png");
    const badManifest = { ...asset.manifest, sha256: "f".repeat(64) };

    const res = await shareRequest({
      device_token: token,
      name: "Mismatch",
      payload: makePayload({ assets: [badManifest] }),
      assets: [asset.body],
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: { code: "asset_mismatch", message: expect.any(String) } });
  });

  it("bytes that fail the PNG magic check return 400 bad_asset", async () => {
    const token = makeToken();
    const notPngBase64 = btoa("this is not a png file at all!!!");
    const asset = await makeAsset("favicon_png", notPngBase64);

    const res = await shareRequest({
      device_token: token,
      name: "Bad Magic",
      payload: makePayload({ assets: [asset.manifest] }),
      assets: [asset.body],
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: { code: "bad_asset", message: expect.any(String) } });
  });

  it("signs a config with the creator profile and ignores any author in the body", async () => {
    const token = makeToken();
    await SELF.fetch("https://example.com/api/v1/me", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_token: token, nickname: "Signed By Profile" }),
    });

    const res = await shareRequest({
      device_token: token,
      name: "Attributed",
      author: "Someone Else",
      payload: makePayload({ colors: { light_bg: "#0a0a0a" } }),
    });
    expect(res.status).toBe(200);
    const { id } = await res.json();

    const detail = await (await SELF.fetch(`${SHARE_URL}/${id}`)).json();
    expect(detail.author).toBe("Signed By Profile");
    expect(detail.author_id).toBeTruthy();
  });

  it("signs an anonymous device with an empty author", async () => {
    const res = await shareRequest({
      device_token: makeToken(),
      name: "Unsigned",
      payload: makePayload({ colors: { light_bg: "#0b0b0b" } }),
    });
    const { id } = await res.json();

    const detail = await (await SELF.fetch(`${SHARE_URL}/${id}`)).json();
    expect(detail.author).toBe("");
  });
});
