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
      payload: makePayload({
        colors: overrides.colors,
        layout: overrides.layout,
        typography: overrides.typography,
        toolbar: overrides.toolbar,
      }),
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

  it("returns a preview projection that reuses the payload's own key names", async () => {
    const id = await share({
      name: "Preview",
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
      layout: { nav_type: "sidebar", struct_radius_base: "0.75rem" },
      typography: { font_sans: "geist-sans", struct_font_sans: "Geist, sans-serif" },
      toolbar: [
        { title: "AdGuard", url: "https://example.com/adguard", icon: "shield.png", enabled: "1" },
        { title: "Home", url: "/", enabled: "0" },
      ],
    });

    const res = await SELF.fetch(`${LIST_URL}?sort=hot`);
    const body = await res.json();
    const item = body.items.find((i) => i.id === id);

    expect(item.schema).toBe(1);

    // colors: exactly the 8 the card can draw, flat, named as in payload.colors.
    expect(item.preview.colors).toEqual({
      light_bg: "#111111",
      light_surface: "#222222",
      light_text: "#333333",
      light_brand: "#444444",
      dark_bg: "#555555",
      dark_surface: "#666666",
      dark_text: "#777777",
      dark_brand: "#888888",
    });

    // layout / typography: whole sections, verbatim.
    expect(item.preview.layout).toEqual({
      nav_type: "sidebar",
      struct_spacing: "0.25rem",
      struct_radius_base: "0.75rem",
      struct_content_width_centered: "80rem",
      toolbar_enabled: "1",
    });
    expect(item.preview.typography).toEqual({
      font_sans: "geist-sans",
      font_mono: "jetbrains-mono",
      struct_font_sans: "Geist, sans-serif",
      struct_font_mono: "'Fira Code', monospace",
    });

    // toolbar: title/icon/enabled only — url is the bulk of the section and
    // belongs to the detail path's external-link confirmation story.
    expect(item.preview.toolbar).toEqual([
      { title: "AdGuard", icon: "shield.png", enabled: "1" },
      { title: "Home", enabled: "0" },
    ]);

    // A config with no approved assets carries an empty list, never undefined.
    expect(item.preview.assets).toEqual([]);

    // palette is deprecated but still present: 1.1.3 devices read it.
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

  it("hot sort breaks a downloads tie by id ASC, independent of insertion order", async () => {
    const id1 = await share({ name: "HotTie1", colors: { light_bg: "#0a0a0a" } });
    const id2 = await share({ name: "HotTie2", colors: { light_bg: "#0b0b0b" } });

    await env.DB.prepare("UPDATE configs SET downloads = 3 WHERE id IN (?, ?)")
      .bind(id1, id2)
      .run();

    // Don't assume id1 < id2 from insertion/generation order — sort the two
    // actual (random, shortId-generated) ids ourselves and compare against
    // that, per the coordinator's fix-round note.
    const expectedOrder = [id1, id2].sort();

    const res = await SELF.fetch(`${LIST_URL}?sort=hot`);
    const body = await res.json();
    expect(body.items.map((i) => i.id)).toEqual(expectedOrder);
  });

  it("new sort breaks a created_at tie by id ASC, independent of insertion order", async () => {
    const id1 = await share({ name: "NewTie1", colors: { light_bg: "#0c0c0c" } });
    const id2 = await share({ name: "NewTie2", colors: { light_bg: "#0d0d0d" } });

    await env.DB.prepare("UPDATE configs SET created_at = ? WHERE id IN (?, ?)")
      .bind("2026-02-02T00:00:00Z", id1, id2)
      .run();

    const expectedOrder = [id1, id2].sort();

    const res = await SELF.fetch(`${LIST_URL}?sort=new`);
    const body = await res.json();
    expect(body.items.map((i) => i.id)).toEqual(expectedOrder);
  });

  it("page=0 and page=-1 fall back to page=1; a page far past the data is an empty 200", async () => {
    await share({ name: "PageA", colors: { light_bg: "#0e1e1e" } });
    await share({ name: "PageB", colors: { light_bg: "#0e2e2e" } });

    const zero = await SELF.fetch(`${LIST_URL}?page=0`);
    expect(zero.status).toBe(200);
    const zeroBody = await zero.json();
    expect(zeroBody.page).toBe(1);
    expect(zeroBody.items).toHaveLength(2);

    const negative = await SELF.fetch(`${LIST_URL}?page=-1`);
    expect(negative.status).toBe(200);
    const negativeBody = await negative.json();
    expect(negativeBody.page).toBe(1);
    expect(negativeBody.items).toHaveLength(2);

    const farAhead = await SELF.fetch(`${LIST_URL}?page=1000000000`);
    expect(farAhead.status).toBe(200);
    expect(await farAhead.json()).toEqual({ items: [], page: 1000000000, has_more: false });
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
