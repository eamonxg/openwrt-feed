import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { makeToken, makePayload, makeAsset, PNG_1X1_BASE64 } from "../helpers.js";

function bytesOf(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const json = (path, body) =>
  SELF.fetch("https://hub.test" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function draftWithAsset(token, extra = {}) {
  const asset = await makeAsset("favicon_png");
  const res = await json("/api/v1/themes/aurora/configs/draft", {
    device_token: token,
    name: "Deep Ocean",
    description: "dark",
    payload: makePayload({
      assets: [asset.manifest],
      colors: {
        light_bg: "#" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0"),
      },
    }),
    ...extra,
  });
  return res.json();
}

const uploadFirstAsset = (draft) =>
  SELF.fetch("https://hub.test" + draft.assets[0].url, {
    method: "PUT",
    headers: { Authorization: "Bearer " + draft.assets[0].ticket },
    body: bytesOf(PNG_1X1_BASE64),
  });

describe("POST /drafts/:id/commit", () => {
  it("publishes the draft once its bytes are uploaded", async () => {
    const token = makeToken();
    const draft = await draftWithAsset(token);
    await uploadFirstAsset(draft);

    const res = await json(`/api/v1/drafts/${draft.draft_id}/commit`, { device_token: token });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.manage).toBe(true);

    const row = await env.DB.prepare("SELECT assets_status FROM configs WHERE id = ?")
      .bind(body.id).first();
    expect(row.assets_status).toBe("pending");
    expect(await env.R2.head(`pending/${body.id}/favicon_png`)).not.toBeNull();
    // 草稿字节和草稿行都清掉了
    expect(await env.R2.head(`draft/${draft.draft_id}/favicon_png`)).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM drafts WHERE id = ?").bind(draft.draft_id).first()
    ).toBeNull();
  });

  it("refuses to commit while an asset is still missing", async () => {
    const token = makeToken();
    const draft = await draftWithAsset(token);
    const res = await json(`/api/v1/drafts/${draft.draft_id}/commit`, { device_token: token });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("assets_incomplete");
  });

  it("refuses a device that does not own the draft", async () => {
    // deviceFromToken(register:false) 对陌生 token 返回 null，与"已注册但不是
    // 主人"走同一个 403 not_owner —— 两种情况都不该泄漏草稿是否存在。
    const draft = await draftWithAsset(makeToken());
    const res = await json(`/api/v1/drafts/${draft.draft_id}/commit`, {
      device_token: makeToken(),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("not_owner");
  });

  it("404s an unknown or already committed draft", async () => {
    const res = await json("/api/v1/drafts/zzzzzzzz/commit", { device_token: makeToken() });
    expect(res.status).toBe(404);
  });

  it("commits a target_id draft as an update, bumping version", async () => {
    const token = makeToken();
    const created = await json("/api/v1/themes/aurora/configs", {
      device_token: token, name: "Original", description: "",
      payload: makePayload({ colors: { light_bg: "#0a0b0c" } }), assets: [],
    });
    const { id } = await created.json();

    const draft = await draftWithAsset(token, { target_id: id });
    await uploadFirstAsset(draft);

    const res = await json(`/api/v1/drafts/${draft.draft_id}/commit`, { device_token: token });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT version, name FROM configs WHERE id = ?")
      .bind(id).first();
    expect(row.version).toBe(2);
    expect(row.name).toBe("Deep Ocean");
  });
});
