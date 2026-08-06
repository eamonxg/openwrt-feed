import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeAsset, makePayload, makeToken } from "../helpers.js";

const SHARE_URL = "https://example.com/api/v1/themes/aurora/configs";
const ADMIN_TOKEN = "test-admin-token";
const ADMIN_HEADERS = { Authorization: `Bearer ${ADMIN_TOKEN}` };

async function share({ token = makeToken(), name = "Config", colorSeed, withAsset = true } = {}) {
  const asset = withAsset ? await makeAsset("login_bg") : null;
  const res = await SELF.fetch(SHARE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_token: token,
      name,
      payload: makePayload({
        colors: colorSeed ? { light_bg: colorSeed } : undefined,
        assets: asset ? [asset.manifest] : [],
      }),
      ...(asset ? { assets: [asset.body] } : {}),
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  return { id: body.id, token };
}

async function configRow(id) {
  return env.DB.prepare("SELECT * FROM configs WHERE id = ?").bind(id).first();
}

async function assetCount(id) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM assets WHERE config_id = ?").bind(id).first();
  return row.n;
}

function adminPost(path) {
  return SELF.fetch(`https://example.com/api/v1/admin${path}`, {
    method: "POST",
    headers: ADMIN_HEADERS,
  });
}

describe("takedown keeps every byte", () => {
  it("leaves the assets row and the R2 object in place", async () => {
    const { id } = await share();
    expect(await assetCount(id)).toBe(1);

    const res = await adminPost(`/configs/${id}/takedown`);
    expect(res.status).toBe(200);

    const row = await configRow(id);
    expect(row.status).toBe("removed");
    expect(row.purged_at).toBe(null);
    // 这是与旧行为的分水岭:以前这两个断言都会失败。
    expect(await assetCount(id)).toBe(1);
    const object = await env.R2.get(`pending/${id}/login_bg`);
    expect(object).not.toBe(null);
    // Drain the body: an R2Object fetched straight from the test (rather than
    // through a Worker request) leaves its underlying stream open if nothing
    // reads it, which the vitest-pool-workers isolated-storage snapshot then
    // fails to tear down at the end of the test. Every other R2.get in this
    // suite that asserts presence does the same for the same reason.
    await object.arrayBuffer();
  });
});

describe("the owner's own delete destroys the bytes", () => {
  it("stamps purged_at so nothing later offers to restore a shell", async () => {
    const { id, token } = await share();

    const res = await SELF.fetch(`https://example.com/api/v1/themes/aurora/configs/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_token: token }),
    });
    expect(res.status).toBe(200);

    const row = await configRow(id);
    expect(row.status).toBe("removed");
    expect(row.purged_at).not.toBe(null);
    expect(await assetCount(id)).toBe(0);
    expect(await env.R2.get(`pending/${id}/login_bg`)).toBe(null);
  });
});

describe("banning a device is reversible now", () => {
  it("soft-takes-down its configs instead of destroying them", async () => {
    const token = makeToken();
    const { id } = await share({ token, colorSeed: "#010203" });
    const deviceId = (await configRow(id)).device_id;

    const res = await adminPost(`/devices/${deviceId}/ban`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ banned: true, removed_configs: 1 });

    const row = await configRow(id);
    expect(row.status).toBe("removed");
    expect(row.purged_at).toBe(null);
    expect(await assetCount(id)).toBe(1);
  });
});

describe("restore", () => {
  it("brings a taken-down config back with its assets intact", async () => {
    const { id } = await share({ colorSeed: "#111111" });
    await adminPost(`/configs/${id}/takedown`);

    const res = await adminPost(`/configs/${id}/restore`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, restored: true });

    const row = await configRow(id);
    expect(row.status).toBe("active");
    expect(await assetCount(id)).toBe(1);
  });

  it("refuses a config that was never taken down", async () => {
    const { id } = await share({ colorSeed: "#222222" });
    const res = await adminPost(`/configs/${id}/restore`);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("not_removed");
  });

  it("refuses a purged config instead of restoring a shell", async () => {
    const { id, token } = await share({ colorSeed: "#333333" });
    await SELF.fetch(`https://example.com/api/v1/themes/aurora/configs/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_token: token }),
    });

    const res = await adminPost(`/configs/${id}/restore`);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("purged");
  });

  it("refuses when the same content went live again while it was down", async () => {
    // 同一个 payload 分享两次会撞 duplicate_content,所以先下架第一条腾出
    // idx_configs_dedup 的槽位,再用同样内容重新分享,最后试图恢复第一条。
    const first = await share({ colorSeed: "#444444" });
    await adminPost(`/configs/${first.id}/takedown`);
    const second = await share({ token: makeToken(), colorSeed: "#444444" });
    expect(second.id).not.toBe(first.id);

    const res = await adminPost(`/configs/${first.id}/restore`);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("duplicate_content");
    // 占位的那条 id 写进 message,管理员据此能直接去看是谁占了位置。
    expect(body.error.message).toContain(second.id);
  });
});

describe("purge", () => {
  it("destroys the bytes of a taken-down config", async () => {
    const { id } = await share({ colorSeed: "#555555" });
    await adminPost(`/configs/${id}/takedown`);

    const res = await adminPost(`/configs/${id}/purge`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, purged: true });

    const row = await configRow(id);
    expect(row.status).toBe("removed");
    expect(row.purged_at).not.toBe(null);
    expect(await assetCount(id)).toBe(0);
    expect(await env.R2.get(`pending/${id}/login_bg`)).toBe(null);
    // assets_status 跟着 assets 行一起归零。留着 'pending'/'approved' 是在说
    // 「有资产,且处于某个审核阶段」,而这一行已经一个资产都没有了 —— 管理台
    // 的徽章、顶栏的待审计数和列表的 pending 筛选读的都是这一列。'none' 正是
    // 0001_init.sql 给「没有资产」定的那个值。
    expect(row.assets_status).toBe("none");
  });

  it("refuses a config that is still listed", async () => {
    const { id } = await share({ colorSeed: "#666666" });
    const res = await adminPost(`/configs/${id}/purge`);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("not_removed");

    expect(await assetCount(id)).toBe(1);
  });

  it("is idempotent", async () => {
    const { id } = await share({ colorSeed: "#777777" });
    await adminPost(`/configs/${id}/takedown`);
    await adminPost(`/configs/${id}/purge`);

    const res = await adminPost(`/configs/${id}/purge`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, purged: true });
  });
});
