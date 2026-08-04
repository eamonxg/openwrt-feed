import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makePayload, makeToken } from "../helpers.js";

const ME_URL = "https://example.com/api/v1/me";
const CONFIGS_URL = "https://example.com/api/v1/themes/aurora/configs";

function postMe(body) {
  return SELF.fetch(ME_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Each share needs a distinct content hash or idx_configs_dedup collapses
// the second one into a duplicate of the first.
async function share(token, name, tint) {
  const res = await SELF.fetch(CONFIGS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_token: token,
      name,
      payload: makePayload({ colors: { light_bg: tint } }),
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).id;
}

describe("POST /api/v1/me", () => {
  it("answers 200 with an empty profile for a key that never published", async () => {
    const res = await postMe({ device_token: makeToken() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: null, nickname: null, configs: [] });
  });

  it("rejects a malformed token with 400", async () => {
    const res = await postMe({ device_token: "nope" });
    expect(res.status).toBe(400);
  });

  it("lists everything this device published, newest first", async () => {
    const token = makeToken();
    await share(token, "First", "#111111");
    const second = await share(token, "Second", "#222222");

    const res = await postMe({ device_token: token });
    const body = await res.json();

    expect(body.id).toBeTruthy();
    expect(body.nickname).toBe(null);
    expect(body.configs.map((c) => c.name)).toEqual(["Second", "First"]);
    expect(body.configs[0].id).toBe(second);
    expect(body.configs[0].palette.light.bg).toBe("#222222");
  });

  it("does not leak another device's configs", async () => {
    const mine = makeToken();
    const theirs = makeToken();
    await share(mine, "Mine", "#333333");
    await share(theirs, "Theirs", "#444444");

    const body = await (await postMe({ device_token: mine })).json();
    expect(body.configs.map((c) => c.name)).toEqual(["Mine"]);
  });

  it("sets a nickname on a key that has never been seen", async () => {
    const body = await (await postMe({ device_token: makeToken(), nickname: "Eamon" })).json();
    expect(body.nickname).toBe("Eamon");
    expect(body.id).toBeTruthy();
  });

  it("keeps the nickname on later reads", async () => {
    const token = makeToken();
    await postMe({ device_token: token, nickname: "Persisted" });
    const body = await (await postMe({ device_token: token })).json();
    expect(body.nickname).toBe("Persisted");
  });

  it("refuses a nickname another device already holds, case-insensitively", async () => {
    await postMe({ device_token: makeToken(), nickname: "Taken" });

    const res = await postMe({ device_token: makeToken(), nickname: "  tAkEn  " });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBe("nickname_taken");
    expect(body.nickname).toBe(null);
  });

  it("lets a device re-assert the nickname it already holds", async () => {
    const token = makeToken();
    await postMe({ device_token: token, nickname: "Stable" });
    const body = await (await postMe({ device_token: token, nickname: "Stable" })).json();
    expect(body.error).toBeUndefined();
    expect(body.nickname).toBe("Stable");
  });

  it("renames, and every existing config signs with the new name", async () => {
    const token = makeToken();
    await postMe({ device_token: token, nickname: "Before" });
    const id = await share(token, "Signed", "#666666");

    const renamed = await (await postMe({ device_token: token, nickname: "After" })).json();
    expect(renamed.nickname).toBe("After");

    // Display name is joined at read time, so history follows the rename.
    const detail = await (await SELF.fetch(`${CONFIGS_URL}/${id}`)).json();
    expect(detail.author).toBe("After");
  });

  it("frees the old name after a rename", async () => {
    const first = makeToken();
    await postMe({ device_token: first, nickname: "Released" });
    await postMe({ device_token: first, nickname: "Moved" });

    const body = await (await postMe({ device_token: makeToken(), nickname: "Released" })).json();
    expect(body.error).toBeUndefined();
    expect(body.nickname).toBe("Released");
  });

  it("reports an invalid nickname in the body, not as a 4xx", async () => {
    const res = await postMe({ device_token: makeToken(), nickname: "   " });
    expect(res.status).toBe(200);
    expect((await res.json()).error).toBe("invalid_nickname");
  });

  it("still lists a config the author removed, marked removed", async () => {
    const token = makeToken();
    const id = await share(token, "Gone", "#555555");

    const del = await SELF.fetch(`${CONFIGS_URL}/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_token: token }),
    });
    expect(del.status).toBe(200);

    const body = await (await postMe({ device_token: token })).json();
    expect(body.configs).toHaveLength(1);
    expect(body.configs[0].status).toBe("removed");
  });
});
