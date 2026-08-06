import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeAsset, makePayload, makeToken } from "../helpers.js";

const SHARE_URL = "https://example.com/api/v1/themes/aurora/configs";

async function share({ colorSeed } = {}) {
  const asset = await makeAsset("login_bg");
  const res = await SELF.fetch(SHARE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_token: makeToken(),
      name: "Config",
      payload: makePayload({
        colors: colorSeed ? { light_bg: colorSeed } : undefined,
        assets: [asset.manifest],
      }),
      assets: [asset.body],
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).id;
}

function adminPost(path, token = "test-admin-token") {
  return SELF.fetch(`https://example.com/api/v1/admin${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

// The same POST, but carrying the optional {reason} the admin console's
// destructive-confirm dialog collects.
function adminPostWithBody(path, body, token = "test-admin-token") {
  return SELF.fetch(`https://example.com/api/v1/admin${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function logRows(targetId) {
  const { results } = await env.DB
    .prepare("SELECT * FROM admin_actions WHERE target_id = ? ORDER BY id ASC")
    .bind(targetId)
    .all();
  return results;
}

describe("admin actions leave an audit trail", () => {
  it("records takedown, restore and purge against the config", async () => {
    const id = await share({ colorSeed: "#0a0a0a" });

    await adminPost(`/configs/${id}/takedown`);
    await adminPost(`/configs/${id}/restore`);
    await adminPost(`/configs/${id}/takedown`);
    await adminPost(`/configs/${id}/purge`);

    const rows = await logRows(id);
    expect(rows.map((r) => r.action)).toEqual(["takedown", "restore", "takedown", "purge"]);
    expect(rows.every((r) => r.target_type === "config")).toBe(true);
    expect(rows.every((r) => r.actor === "root")).toBe(true);
  });

  it("attributes the action to the named token that made it", async () => {
    const id = await share({ colorSeed: "#0b0b0b" });

    // alice:alice-token 来自 vitest.config.js 的 ADMIN_TOKENS 绑定。
    await adminPost(`/configs/${id}/takedown`, "alice-token");

    const rows = await logRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe("alice");
  });

  it("records the ban and names the cascade on each config it took down", async () => {
    const id = await share({ colorSeed: "#0c0c0c" });
    const { device_id: deviceId } = await env.DB
      .prepare("SELECT device_id FROM configs WHERE id = ?")
      .bind(id)
      .first();

    await adminPost(`/devices/${deviceId}/ban`);

    const deviceRows = await logRows(deviceId);
    expect(deviceRows.map((r) => r.action)).toEqual(["ban"]);
    expect(deviceRows[0].target_type).toBe("device");
    expect(deviceRows[0].note).toContain("1");

    const configRows = await logRows(id);
    expect(configRows.map((r) => r.action)).toEqual(["takedown"]);
    expect(configRows[0].note).toBe(`banned device ${deviceId}`);
  });
});

// 「谁在什么时候删了什么」表结构里都有,「为什么」只有这段自由文本能说。
// 它必须是可选的:这两个端点在管理台之外(以及本文件其余每个用例里)都是
// 不带 body 的裸 POST,一次不可逆的销毁绝不能因为少了一段注解而失败。
describe("purge and ban carry an optional reason into the log", () => {
  it("writes the reason as the purge note", async () => {
    const id = await share({ colorSeed: "#0d0d0d" });
    await adminPost(`/configs/${id}/takedown`);

    const res = await adminPostWithBody(`/configs/${id}/purge`, { reason: "版权投诉" });
    expect(res.status).toBe(200);

    const rows = await logRows(id);
    expect(rows.map((r) => r.action)).toEqual(["takedown", "purge"]);
    expect(rows[1].note).toBe("版权投诉");
  });

  it("appends the reason to the ban's cascade count instead of replacing it", async () => {
    const id = await share({ colorSeed: "#0e0e0e" });
    const { device_id: deviceId } = await env.DB
      .prepare("SELECT device_id FROM configs WHERE id = ?")
      .bind(id)
      .first();

    const res = await adminPostWithBody(`/devices/${deviceId}/ban`, { reason: "批量刷屏" });
    expect(res.status).toBe(200);

    const deviceRows = await logRows(deviceId);
    expect(deviceRows).toHaveLength(1);
    // 做了什么(级联下架 1 条)和为什么(刷屏)都得留下来。
    expect(deviceRows[0].note).toBe("cascaded takedown of 1 config(s); 批量刷屏");
  });

  it("leaves the note empty when no body is sent at all", async () => {
    const id = await share({ colorSeed: "#0f0f0f" });
    const { device_id: deviceId } = await env.DB
      .prepare("SELECT device_id FROM configs WHERE id = ?")
      .bind(id)
      .first();

    // adminPost 不带 body —— 这正是这两个端点在这次改动之前唯一被调用的
    // 方式,行为必须一个字节都没变。
    expect((await adminPost(`/configs/${id}/takedown`)).status).toBe(200);
    expect((await adminPost(`/configs/${id}/purge`)).status).toBe(200);
    expect((await adminPost(`/devices/${deviceId}/ban`)).status).toBe(200);

    const rows = await logRows(id);
    expect(rows.map((r) => r.action)).toEqual(["takedown", "purge"]);
    expect(rows[1].note).toBe("");

    const deviceRows = await logRows(deviceId);
    expect(deviceRows[0].note).toBe("cascaded takedown of 0 config(s)");
  });

  it("treats a malformed or reasonless body as no reason rather than an error", async () => {
    const id = await share({ colorSeed: "#0f0f0e" });
    await adminPost(`/configs/${id}/takedown`);

    // 不是 JSON。
    const res = await adminPostWithBody(`/configs/${id}/purge`, "not json at all");
    expect(res.status).toBe(200);
    expect((await logRows(id))[1].note).toBe("");

    const other = await share({ colorSeed: "#0f0f0d" });
    await adminPost(`/configs/${other}/takedown`);
    // 是 JSON,但 reason 不是字符串。
    const res2 = await adminPostWithBody(`/configs/${other}/purge`, { reason: 42 });
    expect(res2.status).toBe(200);
    expect((await logRows(other))[1].note).toBe("");
  });
});

describe("GET /admin/stats", () => {
  it("counts the four things the header shows", async () => {
    const live = await share({ colorSeed: "#130001" });
    const down = await share({ colorSeed: "#130002" });
    await adminPost(`/configs/${down}/takedown`);

    await SELF.fetch(`https://example.com/api/v1/themes/aurora/configs/${live}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "spam" }),
    });

    const res = await SELF.fetch("https://example.com/api/v1/admin/stats", {
      headers: { Authorization: "Bearer test-admin-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // share() 建的配置都带一个待审的 login_bg,所以 live 同时算进
    // total_configs 和 pending;down 已下架,两个都不算。
    expect(body.total_configs).toBeGreaterThanOrEqual(1);
    expect(body.pending).toBeGreaterThanOrEqual(1);
    expect(body.open_reports).toBeGreaterThanOrEqual(1);
    expect(typeof body.banned_devices).toBe("number");
  });

  it("requires an admin token", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/admin/stats");
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/log", () => {
  it("returns the newest action first", async () => {
    const id = await share({ colorSeed: "#130003" });
    await adminPost(`/configs/${id}/takedown`);
    await adminPost(`/configs/${id}/restore`);

    const res = await SELF.fetch("https://example.com/api/v1/admin/log", {
      headers: { Authorization: "Bearer test-admin-token" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.items[0]).toMatchObject({ action: "restore", target_id: id, actor: "root" });
    expect(body.page).toBe(1);
    expect(body.total).toBeGreaterThanOrEqual(2);
  });
});
