import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makePayload, makeToken } from "../helpers.js";

// device_hash and device_token share the same /^[a-f0-9]{64}$/ shape, so
// makeToken() (64 random lowercase hex chars) doubles as a valid device_hash
// fixture here.
const makeHash = makeToken;

async function shareConfig(overrides = {}) {
  const res = await SELF.fetch("https://example.com/api/v1/themes/aurora/configs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_token: makeToken(),
      name: "Downloadable",
      payload: makePayload(),
      ...overrides,
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  return body.id;
}

function downloadUrl(id) {
  return `https://example.com/api/v1/themes/aurora/configs/${id}/download`;
}

function reportUrl(id) {
  return `https://example.com/api/v1/themes/aurora/configs/${id}/report`;
}

function postJson(url, payload, headers = {}) {
  return SELF.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

async function downloadsOf(id) {
  const row = await env.DB.prepare("SELECT downloads FROM configs WHERE id = ?").bind(id).first();
  return row.downloads;
}

describe("POST /api/v1/themes/:theme/configs/:id/download", () => {
  it("first download with a given hash counts; the same hash again does not", async () => {
    const id = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000011" } }) });
    const hash = makeHash();

    const first = await postJson(downloadUrl(id), { device_hash: hash });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ counted: true });
    expect(await downloadsOf(id)).toBe(1);

    const second = await postJson(downloadUrl(id), { device_hash: hash });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ counted: false });
    expect(await downloadsOf(id)).toBe(1);
  });

  it("a different hash counts again: downloads reaches 2", async () => {
    const id = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000012" } }) });

    const first = await postJson(downloadUrl(id), { device_hash: makeHash() });
    expect((await first.json()).counted).toBe(true);

    const second = await postJson(downloadUrl(id), { device_hash: makeHash() });
    expect((await second.json()).counted).toBe(true);

    expect(await downloadsOf(id)).toBe(2);
  });

  it("a malformed device_hash returns 400 bad_device_hash", async () => {
    const id = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000013" } }) });

    const res = await postJson(downloadUrl(id), { device_hash: "not-a-hash" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "bad_device_hash", message: expect.any(String) } });
    expect(await downloadsOf(id)).toBe(0);
  });

  it("a missing device_hash returns 400 bad_device_hash", async () => {
    const id = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000014" } }) });

    const res = await postJson(downloadUrl(id), {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "bad_device_hash", message: expect.any(String) } });
  });

  it("a removed config returns 404 not_found", async () => {
    const id = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000015" } }) });
    await env.DB.prepare("UPDATE configs SET status = 'removed' WHERE id = ?").bind(id).run();

    const res = await postJson(downloadUrl(id), { device_hash: makeHash() });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("an unknown config id returns 404 not_found", async () => {
    const res = await postJson(downloadUrl("nosuchid1"), { device_hash: makeHash() });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });
});

describe("POST /api/v1/themes/:theme/configs/:id/report", () => {
  it("a valid report is stored with the IP from CF-Connecting-IP and returns {ok:true}", async () => {
    const id = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000021" } }) });

    const res = await postJson(
      reportUrl(id),
      { reason: "This config contains offensive content." },
      { "CF-Connecting-IP": "203.0.113.5" }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const row = await env.DB.prepare("SELECT * FROM reports WHERE config_id = ?").bind(id).first();
    expect(row).toMatchObject({
      config_id: id,
      reason: "This config contains offensive content.",
      ip: "203.0.113.5",
      resolved: 0,
    });
  });

  it("falls back to ip 'unknown' when CF-Connecting-IP is absent", async () => {
    const id = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000022" } }) });

    const res = await postJson(reportUrl(id), { reason: "No IP header here." });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT ip FROM reports WHERE config_id = ?").bind(id).first();
    expect(row.ip).toBe("unknown");
  });

  it("an empty reason returns 400 bad_reason", async () => {
    const id = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000023" } }) });

    const res = await postJson(reportUrl(id), { reason: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "bad_reason", message: expect.any(String) } });
  });

  it("a reason of 201 characters returns 400 bad_reason", async () => {
    const id = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000024" } }) });

    const res = await postJson(reportUrl(id), { reason: "a".repeat(201) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "bad_reason", message: expect.any(String) } });
  });

  it("a reason of exactly 200 characters is accepted", async () => {
    const id = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000025" } }) });

    const res = await postJson(reportUrl(id), { reason: "a".repeat(200) });
    expect(res.status).toBe(200);
  });

  it("a reason that is only control characters returns 400 bad_reason", async () => {
    const id = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000026" } }) });

    const res = await postJson(reportUrl(id), { reason: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "bad_reason", message: expect.any(String) } });
  });

  it("the 21st report from the same IP in a day returns 429 rate_limited", async () => {
    const id = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000027" } }) });
    const ip = "198.51.100.9";

    for (let i = 0; i < 20; i++) {
      const res = await postJson(reportUrl(id), { reason: `reason number ${i}` }, { "CF-Connecting-IP": ip });
      expect(res.status).toBe(200);
    }

    const res21 = await postJson(reportUrl(id), { reason: "one report too many" }, { "CF-Connecting-IP": ip });
    expect(res21.status).toBe(429);
    expect(await res21.json()).toEqual({ error: { code: "rate_limited", message: expect.any(String) } });

    const count = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM reports WHERE config_id = ? AND ip = ?")
      .bind(id, ip)
      .first();
    expect(count.n).toBe(20);
  });

  it("a different IP is unaffected by another IP's daily count", async () => {
    const id = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000028" } }) });

    for (let i = 0; i < 20; i++) {
      await postJson(reportUrl(id), { reason: `busy ip ${i}` }, { "CF-Connecting-IP": "198.51.100.10" });
    }

    const res = await postJson(reportUrl(id), { reason: "quiet ip" }, { "CF-Connecting-IP": "198.51.100.11" });
    expect(res.status).toBe(200);
  });

  it("a removed config returns 404 not_found", async () => {
    const id = await shareConfig({ payload: makePayload({ colors: { light_bg: "#000029" } }) });
    await env.DB.prepare("UPDATE configs SET status = 'removed' WHERE id = ?").bind(id).run();

    const res = await postJson(reportUrl(id), { reason: "should 404" }, { "CF-Connecting-IP": "203.0.113.6" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("an unknown config id returns 404 not_found", async () => {
    const res = await postJson(reportUrl("nosuchid2"), { reason: "should 404" }, { "CF-Connecting-IP": "203.0.113.7" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });
});
