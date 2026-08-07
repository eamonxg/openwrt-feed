import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeAsset, makePayload, makeToken } from "../helpers.js";

const SHARE_URL = "https://example.com/api/v1/themes/aurora/configs";
const ADMIN_HEADERS = { Authorization: "Bearer test-admin-token" };

async function share({ name = "Config", colorSeed, token = makeToken(), withAsset = false } = {}) {
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
  return { id: (await res.json()).id, token };
}

async function adminList(query = "") {
  const res = await SELF.fetch(`https://example.com/api/v1/admin/configs${query}`, {
    headers: ADMIN_HEADERS,
  });
  expect(res.status).toBe(200);
  return res.json();
}

describe("GET /admin/configs", () => {
  it("requires an admin token", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/admin/configs");
    expect(res.status).toBe(401);
  });

  it("lists every status at once by default", async () => {
    const live = await share({ name: "Live", colorSeed: "#100001" });
    const down = await share({ name: "Down", colorSeed: "#100002" });
    await SELF.fetch(`https://example.com/api/v1/admin/configs/${down.id}/takedown`, {
      method: "POST",
      headers: ADMIN_HEADERS,
    });

    const body = await adminList();
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(live.id);
    // 这正是今天做不到的事:已下架的配置在管理端应当仍然看得见。
    expect(ids).toContain(down.id);
    expect(body.total).toBe(body.items.length);
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(50);
  });

  it("filters by status", async () => {
    const live = await share({ name: "StillHere", colorSeed: "#100003" });
    const down = await share({ name: "GoneNow", colorSeed: "#100004" });
    await SELF.fetch(`https://example.com/api/v1/admin/configs/${down.id}/takedown`, {
      method: "POST",
      headers: ADMIN_HEADERS,
    });

    const active = await adminList("?status=active");
    expect(active.items.map((i) => i.id)).toContain(live.id);
    expect(active.items.map((i) => i.id)).not.toContain(down.id);

    const removed = await adminList("?status=removed");
    expect(removed.items.map((i) => i.id)).toEqual([down.id]);
  });

  it("treats pending as the review queue", async () => {
    const queued = await share({ name: "Queued", colorSeed: "#100005", withAsset: true });
    await share({ name: "NoAssets", colorSeed: "#100006" });

    const body = await adminList("?status=pending");
    expect(body.items.map((i) => i.id)).toEqual([queued.id]);
    expect(body.items[0].assets_status).toBe("pending");
  });

  it("surfaces configs carrying an open report", async () => {
    const reported = await share({ name: "Reported", colorSeed: "#100007" });
    await share({ name: "Clean", colorSeed: "#100008" });

    const res = await SELF.fetch(
      `https://example.com/api/v1/themes/aurora/configs/${reported.id}/report`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "spam" }),
      }
    );
    expect(res.status).toBe(200);

    const body = await adminList("?status=reported");
    expect(body.items.map((i) => i.id)).toEqual([reported.id]);
    expect(body.items[0].open_reports).toBe(1);
  });

  it("searches name, id and author nickname", async () => {
    const token = makeToken();
    await SELF.fetch("https://example.com/api/v1/me", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_token: token, nickname: "zaphod" }),
    });
    const mine = await share({ name: "Betelgeuse", colorSeed: "#100009", token });

    expect((await adminList("?q=Betelge")).items.map((i) => i.id)).toEqual([mine.id]);
    expect((await adminList("?q=zaphod")).items.map((i) => i.id)).toEqual([mine.id]);
    expect((await adminList(`?q=${mine.id}`)).items.map((i) => i.id)).toEqual([mine.id]);
    expect((await adminList("?q=nothingmatchesthis")).items).toEqual([]);
  });

  it("sorts by downloads when asked", async () => {
    const quiet = await share({ name: "Quiet", colorSeed: "#10000a" });
    const loud = await share({ name: "Loud", colorSeed: "#10000b" });
    await env.DB.prepare("UPDATE configs SET downloads = 99 WHERE id = ?").bind(loud.id).run();

    const body = await adminList("?sort=downloads");
    expect(body.items[0].id).toBe(loud.id);
    expect(body.items.map((i) => i.id)).toContain(quiet.id);
  });

  it("reports approved asset kinds and the purged flag", async () => {
    const { id } = await share({ name: "WithAsset", colorSeed: "#10000c", withAsset: true });
    await env.DB.prepare("UPDATE assets SET status = 'approved' WHERE config_id = ?").bind(id).run();

    const found = (await adminList("?q=WithAsset")).items[0];
    expect(found.asset_kinds).toEqual(["login_bg"]);
    expect(found.purged).toBe(false);
    expect(found.colors.light_bg).toBe("#10000c");
  });

  it("falls back to page 1 on a nonsense page number", async () => {
    await share({ name: "Paged", colorSeed: "#10000d" });
    const body = await adminList("?page=banana");
    expect(body.page).toBe(1);
  });

  // Regression test: STATUS_CLAUSES/SORTS are plain object literals, so a
  // naive `TABLE[key] ?? TABLE.default` lookup does not treat an inherited
  // prototype member as "missing" -- `TABLE.constructor` resolves to the
  // Object constructor function, which is not nullish, so `??` never falls
  // back and that function gets template-interpolated into the SQL string
  // instead of a clause. status=constructor/sort=constructor must resolve
  // to the same defaults as an absent query param (all / updated) and come
  // back 200 with the normal list, not a 500 from a broken query.
  it("falls back to the default status when the value names a prototype property", async () => {
    const live = await share({ name: "ProtoStatus", colorSeed: "#10000e" });

    const res = await SELF.fetch("https://example.com/api/v1/admin/configs?status=constructor", {
      headers: ADMIN_HEADERS,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.items.map((i) => i.id)).toContain(live.id);
  });

  it("falls back to the default sort when the value names a prototype property", async () => {
    const live = await share({ name: "ProtoSort", colorSeed: "#10000f" });

    const res = await SELF.fetch("https://example.com/api/v1/admin/configs?sort=constructor", {
      headers: ADMIN_HEADERS,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.items.map((i) => i.id)).toContain(live.id);
  });
});

describe("GET /admin/configs/:id", () => {
  it("returns a taken-down config with its payload, reports and history", async () => {
    const { id } = await share({ name: "Deep", colorSeed: "#110001", withAsset: true });
    await SELF.fetch(`https://example.com/api/v1/themes/aurora/configs/${id}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "looks wrong" }),
    });
    await SELF.fetch(`https://example.com/api/v1/admin/configs/${id}/takedown`, {
      method: "POST",
      headers: ADMIN_HEADERS,
    });

    const res = await SELF.fetch(`https://example.com/api/v1/admin/configs/${id}`, {
      headers: ADMIN_HEADERS,
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.id).toBe(id);
    expect(body.status).toBe("removed");
    expect(body.purged).toBe(false);
    expect(body.payload.schema).toBe(1);
    expect(body.assets.map((a) => a.kind)).toEqual(["login_bg"]);
    expect(body.assets[0].status).toBe("pending");
    expect(body.reports).toHaveLength(1);
    expect(body.reports[0].reason).toBe("looks wrong");
    expect(body.history.map((h) => h.action)).toEqual(["takedown"]);
  });

  it("404s an id that does not exist", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/admin/configs/nosuchid", {
      headers: ADMIN_HEADERS,
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/configs/:id/edit", () => {
  async function edit(id, body) {
    return SELF.fetch(`https://example.com/api/v1/admin/configs/${id}/edit`, {
      method: "POST",
      headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("renames without touching the payload or the content hash", async () => {
    const { id } = await share({ name: "Bad Name", colorSeed: "#110002" });
    const before = await env.DB.prepare("SELECT content_hash, payload FROM configs WHERE id = ?")
      .bind(id)
      .first();

    const res = await edit(id, { name: "Good Name" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, name: "Good Name" });

    const after = await env.DB.prepare("SELECT name, content_hash, payload FROM configs WHERE id = ?")
      .bind(id)
      .first();
    expect(after.name).toBe("Good Name");
    // 名字不参与 contentHash(它只对 payload 求值),所以改名既不会撞
    // idx_configs_dedup,也不该动 payload 一个字节。
    expect(after.content_hash).toBe(before.content_hash);
    expect(after.payload).toBe(before.payload);
  });

  it("edits the description on its own", async () => {
    const { id } = await share({ name: "Keep", colorSeed: "#110003" });
    const res = await edit(id, { description: "now explained" });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT name, description FROM configs WHERE id = ?").bind(id).first();
    expect(row.name).toBe("Keep");
    expect(row.description).toBe("now explained");
  });

  it("rejects a body that changes nothing", async () => {
    const { id } = await share({ name: "Untouched", colorSeed: "#110004" });
    const res = await edit(id, {});
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
  });

  it("rejects an over-long name through the shared validator", async () => {
    const { id } = await share({ name: "Fine", colorSeed: "#110005" });
    const res = await edit(id, { name: "x".repeat(61) });
    expect(res.status).toBe(400);
  });

  it("works on a taken-down config too", async () => {
    const { id } = await share({ name: "Down But Editable", colorSeed: "#110006" });
    await SELF.fetch(`https://example.com/api/v1/admin/configs/${id}/takedown`, {
      method: "POST",
      headers: ADMIN_HEADERS,
    });
    const res = await edit(id, { name: "Renamed While Down" });
    expect(res.status).toBe(200);
  });

  it("leaves an audit row naming both sides of the rename", async () => {
    const { id } = await share({ name: "Before", colorSeed: "#110007" });
    await edit(id, { name: "After" });

    const row = await env.DB
      .prepare("SELECT * FROM admin_actions WHERE target_id = ? AND action = 'edit'")
      .bind(id)
      .first();
    expect(row.note).toContain("Before");
    expect(row.note).toContain("After");
  });
});
