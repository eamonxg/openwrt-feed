import { env, SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { makeToken, makePayload, makeAsset } from "../helpers.js";

const post = (path, body) =>
  SELF.fetch("https://hub.test" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const draftPath = "/api/v1/themes/aurora/configs/draft";

describe("POST /configs/draft", () => {
  it("returns one ticket per manifest asset", async () => {
    const asset = await makeAsset("login_bg");
    const res = await post(draftPath, {
      device_token: makeToken(),
      name: "Deep Ocean",
      description: "dark",
      payload: makePayload({ assets: [asset.manifest] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.draft_id).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
    expect(body.assets).toHaveLength(1);
    expect(body.assets[0]).toMatchObject({
      kind: "login_bg",
      sha256: asset.manifest.sha256,
      size: asset.manifest.size,
      url: `/api/v1/drafts/${body.draft_id}/assets/login_bg`,
    });
    expect(typeof body.assets[0].ticket).toBe("string");
  });

  it("returns an empty ticket list when the payload has no assets", async () => {
    const res = await post(draftPath, {
      device_token: makeToken(),
      name: "Plain",
      description: "",
      payload: makePayload(),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).assets).toEqual([]);
  });

  it("short-circuits on an existing duplicate without minting a draft", async () => {
    const token = makeToken();
    const payload = makePayload({ colors: { light_bg: "#010203" } });
    const first = await post("/api/v1/themes/aurora/configs", {
      device_token: token, name: "One", description: "", payload, assets: [],
    });
    expect(first.status).toBe(200);

    const res = await post(draftPath, {
      device_token: token, name: "Two", description: "", payload,
    });
    const body = await res.json();
    expect(body.duplicate).toBe(true);
    expect(body.draft_id).toBeUndefined();
  });

  it("rejects a malformed token", async () => {
    const res = await post(draftPath, {
      device_token: "nope", name: "x", description: "", payload: makePayload(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_token");
  });

  it("404s an unknown theme", async () => {
    const res = await post("/api/v1/themes/other/configs/draft", {
      device_token: makeToken(), name: "x", description: "", payload: makePayload(),
    });
    expect(res.status).toBe(404);
  });
});
