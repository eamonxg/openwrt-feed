import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeAsset, makePayload, makeToken } from "../helpers.js";

const SHARE_URL = "https://example.com/api/v1/themes/aurora/configs";
const LIST_URL = "https://example.com/api/v1/themes/aurora/configs";

async function share(overrides = {}) {
  const res = await SELF.fetch(SHARE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      device_token: makeToken(),
      name: overrides.name ?? "Config",
      author: overrides.author,
      payload: makePayload({ colors: overrides.colors }),
      ...(overrides.assets ? { assets: overrides.assets } : {}),
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).id;
}

async function setDownloadsAndCreatedAt(id, downloads, createdAt) {
  await env.DB.prepare("UPDATE configs SET downloads = ?, created_at = ? WHERE id = ?")
    .bind(downloads, createdAt, id)
    .run();
}

describe("GET /api/v1/themes/:theme/configs (list)", () => {
  it("unknown theme segment returns 404 unknown_theme", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/themes/nope/configs");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "unknown_theme", message: expect.any(String) } });
  });

  it("orders hot by downloads DESC and new by created_at DESC; hides removed; empty page has_more:false", async () => {
    const idA = await share({ name: "A", colors: { light_bg: "#000001" } });
    const idB = await share({ name: "B", colors: { light_bg: "#000002" } });
    const idC = await share({ name: "C", colors: { light_bg: "#000003" } });

    await setDownloadsAndCreatedAt(idA, 5, "2026-01-01T00:00:00Z");
    await setDownloadsAndCreatedAt(idB, 1, "2026-01-02T00:00:00Z");
    await setDownloadsAndCreatedAt(idC, 0, "2026-01-03T00:00:00Z");

    const hotRes = await SELF.fetch(`${LIST_URL}?sort=hot&page=1`);
    expect(hotRes.status).toBe(200);
    const hotBody = await hotRes.json();
    expect(hotBody.items.map((i) => i.id)).toEqual([idA, idB, idC]);
    expect(hotBody.page).toBe(1);
    expect(hotBody.has_more).toBe(false);

    const newRes = await SELF.fetch(`${LIST_URL}?sort=new&page=1`);
    const newBody = await newRes.json();
    expect(newBody.items.map((i) => i.id)).toEqual([idC, idB, idA]);

    // absent/invalid sort defaults to hot; absent/invalid page defaults to 1
    const defaultRes = await SELF.fetch(`${LIST_URL}?sort=bogus&page=notanumber`);
    const defaultBody = await defaultRes.json();
    expect(defaultBody.items.map((i) => i.id)).toEqual([idA, idB, idC]);
    expect(defaultBody.page).toBe(1);

    // page 2 of a 3-item list is empty
    const page2 = await SELF.fetch(`${LIST_URL}?sort=hot&page=2`);
    expect(await page2.json()).toEqual({ items: [], page: 2, has_more: false });

    // remove idC: hidden from list, 404 on detail
    await env.DB.prepare("UPDATE configs SET status = 'removed' WHERE id = ?").bind(idC).run();
    const afterRemove = await SELF.fetch(`${LIST_URL}?sort=hot`);
    const afterRemoveBody = await afterRemove.json();
    expect(afterRemoveBody.items.map((i) => i.id)).toEqual([idA, idB]);

    const removedDetail = await SELF.fetch(`https://example.com/api/v1/themes/aurora/configs/${idC}`);
    expect(removedDetail.status).toBe(404);
    expect(await removedDetail.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("returns a palette summary of 8 colors extracted from the stored payload", async () => {
    const id = await share({
      name: "Palette",
      colors: {
        light_bg: "#111111",
        light_surface: "#222222",
        light_text: "#333333",
        light_brand: "#444444",
        dark_bg: "#555555",
        dark_surface: "#666666",
        dark_text: "#777777",
        dark_brand: "#888888",
      },
    });

    const res = await SELF.fetch(`${LIST_URL}?sort=hot`);
    const body = await res.json();
    const item = body.items.find((i) => i.id === id);
    expect(item.palette).toEqual({
      light: { bg: "#111111", surface: "#222222", text: "#333333", brand: "#444444" },
      dark: { bg: "#555555", surface: "#666666", text: "#777777", brand: "#888888" },
    });
  });

  it("has_more:true when a 25th active config exists, and page 2 returns just the remainder", async () => {
    const ids = [];
    for (let i = 0; i < 25; i++) {
      const hex = i.toString(16).padStart(2, "0");
      // eslint-disable-next-line no-await-in-loop
      ids.push(await share({ name: `Bulk ${i}`, colors: { light_bg: `#0000${hex}` } }));
    }

    const page1 = await SELF.fetch(`${LIST_URL}?sort=new&page=1`);
    const page1Body = await page1.json();
    expect(page1Body.items).toHaveLength(24);
    expect(page1Body.has_more).toBe(true);

    const page2 = await SELF.fetch(`${LIST_URL}?sort=new&page=2`);
    const page2Body = await page2.json();
    expect(page2Body.items).toHaveLength(1);
    expect(page2Body.has_more).toBe(false);

    // created_at has only second-level resolution, so these 25 rows plausibly
    // tie on created_at and fall back to the id ASC tiebreaker — rather than
    // assert a specific id landed on page 2, assert the two pages together
    // are exactly the 25 distinct ids with no overlap or omission.
    const combined = [...page1Body.items.map((i) => i.id), ...page2Body.items.map((i) => i.id)];
    expect(new Set(combined)).toEqual(new Set(ids));
    expect(combined).toHaveLength(25);
  });
});

describe("GET /api/v1/themes/:theme/configs/:id (detail)", () => {
  it("unknown theme segment returns 404 unknown_theme", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/themes/nope/configs/abc12345");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "unknown_theme", message: expect.any(String) } });
  });

  it("missing id returns 404 not_found", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/themes/aurora/configs/nonexist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  it("returns full row with parsed payload object and empty assets while no assets exist", async () => {
    const id = await share({ name: "Detail", author: "Eamon" });

    const res = await SELF.fetch(`https://example.com/api/v1/themes/aurora/configs/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body).toMatchObject({
      id,
      name: "Detail",
      author: "Eamon",
      description: "",
      version: 1,
      downloads: 0,
      assets_status: "none",
      assets: [],
    });
    expect(typeof body.payload).toBe("object");
    expect(body.payload.schema).toBe(1);
    expect(body.created_at).toEqual(expect.any(String));
    expect(body.updated_at).toEqual(expect.any(String));
  });

  it("assets stay hidden from detail while pending, and appear with a url once approved", async () => {
    const asset = await makeAsset("favicon_png");
    const res1 = await SELF.fetch(SHARE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_token: makeToken(),
        name: "WithAsset",
        payload: makePayload({ colors: { light_bg: "#0e0e0e" }, assets: [asset.manifest] }),
        assets: [asset.body],
      }),
    });
    expect(res1.status).toBe(201);
    const id2 = (await res1.json()).id;

    const pendingDetail = await SELF.fetch(`https://example.com/api/v1/themes/aurora/configs/${id2}`);
    const pendingBody = await pendingDetail.json();
    expect(pendingBody.assets_status).toBe("pending");
    expect(pendingBody.assets).toEqual([]);

    await env.DB.prepare("UPDATE assets SET status = 'approved' WHERE config_id = ? AND kind = ?")
      .bind(id2, "favicon_png")
      .run();

    const approvedDetail = await SELF.fetch(`https://example.com/api/v1/themes/aurora/configs/${id2}`);
    const approvedBody = await approvedDetail.json();
    expect(approvedBody.assets).toEqual([
      {
        kind: "favicon_png",
        sha256: asset.manifest.sha256,
        size: asset.manifest.size,
        url: `/assets/${id2}/favicon_png`,
      },
    ]);
  });
});
