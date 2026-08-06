import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makePayload, makeToken } from "../helpers.js";

const ADMIN_HEADERS = { Authorization: "Bearer test-admin-token" };

// POST /api/v1/me always answers { id, nickname, configs } (me.js) — no
// three-way guess needed, just read `id`.
async function claim(nickname) {
  const token = makeToken();
  const res = await SELF.fetch("https://example.com/api/v1/me", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_token: token, nickname }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  return { token, deviceId: body.id };
}

async function share(token, colorSeed) {
  const res = await SELF.fetch("https://example.com/api/v1/themes/aurora/configs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_token: token,
      name: "Config",
      payload: makePayload({ colors: { light_bg: colorSeed } }),
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).id;
}

function adminGet(path) {
  return SELF.fetch(`https://example.com/api/v1/admin${path}`, { headers: ADMIN_HEADERS });
}

function adminPost(path) {
  return SELF.fetch(`https://example.com/api/v1/admin${path}`, {
    method: "POST",
    headers: ADMIN_HEADERS,
  });
}

describe("GET /admin/devices", () => {
  it("requires an admin token", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/admin/devices");
    expect(res.status).toBe(401);
  });

  it("counts each creator's configs and downloads", async () => {
    const { token, deviceId } = await claim("prolific");
    const first = await share(token, "#120001");
    await share(token, "#120002");
    await env.DB.prepare("UPDATE configs SET downloads = 7 WHERE id = ?").bind(first).run();

    const body = await (await adminGet("/devices?q=prolific")).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: deviceId,
      nickname: "prolific",
      banned: false,
      configs_active: 2,
      configs_total: 2,
      downloads_total: 7,
    });
  });

  it("includes a device that has never shared anything", async () => {
    // LEFT JOIN 而不是 INNER:注册了但没分享过的设备也要在列表里,否则
    // 「这个 device id 是谁」在管理端无从查起。
    const { deviceId } = await claim("lurker");
    const body = await (await adminGet("/devices?q=lurker")).json();
    expect(body.items.map((i) => i.id)).toEqual([deviceId]);
    expect(body.items[0].configs_total).toBe(0);
    expect(body.items[0].downloads_total).toBe(0);
  });

  it("filters by banned state", async () => {
    const { deviceId } = await claim("troublemaker");
    await adminPost(`/devices/${deviceId}/ban`);

    const banned = await (await adminGet("/devices?banned=yes")).json();
    expect(banned.items.map((i) => i.id)).toContain(deviceId);

    const clean = await (await adminGet("/devices?banned=no")).json();
    expect(clean.items.map((i) => i.id)).not.toContain(deviceId);
  });

  it("falls back to the default when banned is a prototype property name", async () => {
    // LOOKUP TABLE GOTCHA (Task 5): `TABLE[key] ?? TABLE.default` resolves
    // "constructor" through the prototype chain instead of falling back,
    // and a Function would get interpolated straight into the SQL string.
    const res = await adminGet("/devices?banned=constructor");
    expect(res.status).toBe(200);
  });
});

describe("GET /admin/devices/:id", () => {
  it("lists the creator's configs whatever their status", async () => {
    const { token, deviceId } = await claim("mixed");
    const live = await share(token, "#120003");
    const down = await share(token, "#120004");
    await adminPost(`/configs/${down}/takedown`);

    const body = await (await adminGet(`/devices/${deviceId}`)).json();
    expect(body.nickname).toBe("mixed");
    expect(body.banned).toBe(false);
    const byId = Object.fromEntries(body.configs.map((c) => [c.id, c.status]));
    expect(byId[live]).toBe("active");
    expect(byId[down]).toBe("removed");
  });

  it("404s an unknown device", async () => {
    const res = await adminGet("/devices/nosuchdevice");
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/devices/:id/unban", () => {
  it("clears the ban without restoring the configs it took down", async () => {
    const { token, deviceId } = await claim("forgiven");
    const configId = await share(token, "#120005");
    await adminPost(`/devices/${deviceId}/ban`);

    const res = await adminPost(`/devices/${deviceId}/unban`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ device_id: deviceId, banned: false });

    const device = await env.DB.prepare("SELECT banned FROM devices WHERE id = ?").bind(deviceId).first();
    expect(device.banned).toBe(0);

    // 有意为之:解封只解封。配置在创作者详情页里逐条恢复,比一个猜不透的
    // 批量动作可控。
    const config = await env.DB.prepare("SELECT status FROM configs WHERE id = ?").bind(configId).first();
    expect(config.status).toBe("removed");
  });

  it("404s an unknown device", async () => {
    const res = await adminPost("/devices/nosuchdevice/unban");
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/devices/:id/nickname/clear", () => {
  it("frees the handle for someone else to claim", async () => {
    const { deviceId } = await claim("impostor");

    const res = await adminPost(`/devices/${deviceId}/nickname/clear`);
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT nickname, nickname_lc FROM devices WHERE id = ?")
      .bind(deviceId)
      .first();
    expect(row.nickname).toBe(null);
    expect(row.nickname_lc).toBe(null);

    // idx_devices_nick 是 WHERE nickname_lc IS NOT NULL 的 partial unique
    // index,所以清空之后这个名字立刻可以被别人认领。
    const second = await claim("impostor");
    expect(second.deviceId).not.toBe(deviceId);
  });

  it("leaves an audit row", async () => {
    const { deviceId } = await claim("renameme");
    await adminPost(`/devices/${deviceId}/nickname/clear`);

    const row = await env.DB
      .prepare("SELECT * FROM admin_actions WHERE target_id = ? AND action = 'clear_nickname'")
      .bind(deviceId)
      .first();
    expect(row.actor).toBe("root");
    expect(row.note).toContain("renameme");
  });
});
