import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Task 11: the public gallery pages (site/index.html, site/config.html).
// These are plain SELF.fetch checks against the served bytes — the same
// pattern ping.test.js already uses for /admin — plus a static scan for
// external references, since both pages are contractually single-file and
// zero-external-refs. Browser-side interactivity (fetch calls, rendering,
// toggles) cannot be exercised from here; only what the Worker actually
// serves is checked.

describe("GET / — gallery home", () => {
  it("returns 200 HTML containing the #cards skeleton", async () => {
    const res = await SELF.fetch("https://example.com/");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('id="cards"');
  });
});

describe("GET /c/:id — config detail page", () => {
  it("returns 200 with config.html's content for an id that doesn't exist", async () => {
    // No config with this id was ever created — the API would 404 on it,
    // but that 404 is only discovered by the page's own client-side fetch;
    // the Worker must still serve the page shell itself with a 200.
    const res = await SELF.fetch("https://example.com/c/doesnotexist", { redirect: "manual" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('id="detail"');
    expect(body).toContain("extractConfigId");
  });

  it("serves the same page regardless of the id value", async () => {
    const res = await SELF.fetch("https://example.com/c/abc12345", { redirect: "manual" });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="detail"');
  });
});

describe("GET /admin — regression", () => {
  it("still serves the admin console directly (unaffected by the /c/:id route)", async () => {
    const res = await SELF.fetch("https://example.com/admin", { redirect: "manual" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("sanitizeSvg");
  });
});

describe("Global Constraints — zero external references", () => {
  // Matches a literal http:// or https:// anywhere except inside an
  // xmlns="http://www.w3.org/..." declaration (the one exemption the task
  // brief calls out). Neither page uses inline SVG with an xmlns attribute,
  // so in practice no match should ever survive the exemption filter below —
  // this is a belt-and-suspenders scan, not a loophole.
  function findExternalRefs(html) {
    const matches = [];
    const re = /https?:\/\/[^\s"'<>]*/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const start = Math.max(0, m.index - 10);
      const context = html.slice(start, m.index);
      if (/xmlns\s*=\s*["']$/.test(context)) continue;
      matches.push(m[0]);
    }
    return matches;
  }

  it("site/index.html has no external http(s) references", async () => {
    const res = await SELF.fetch("https://example.com/");
    const body = await res.text();
    expect(findExternalRefs(body)).toEqual([]);
  });

  it("site/config.html has no external http(s) references", async () => {
    const res = await SELF.fetch("https://example.com/c/abc12345");
    const body = await res.text();
    expect(findExternalRefs(body)).toEqual([]);
  });
});
