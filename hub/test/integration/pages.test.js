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
    expect(body).toContain('<script type="module" src="/admin/app.js">');
  });
});

// ---------------------------------------------------------------------------
// The admin console's subresources, resolved the way a browser resolves them.
//
// /admin is served by rewriting the SUBREQUEST path to /admin/ (worker.js) so
// the client never sees a redirect — which means the browser's document URL
// stays "/admin", with no trailing slash, and every relative reference in the
// page resolves against THAT. A "./app.js" therefore becomes "/app.js" at
// /admin and "/admin/app.js" at /admin/: the console loads from one entry URL
// and comes up blank from the other, and nothing in the suite noticed, because
// no test had ever fetched anything the page references.
//
// This checks the class rather than today's two filenames: whatever href/src
// the served HTML carries gets resolved against the request URL with the same
// URL algorithm a browser uses, then fetched. A 404 fails it, and so does a
// text/html body — the assets binding answering a missing .js with an HTML
// error page would otherwise look like a hit.
// ---------------------------------------------------------------------------

function referencedUrls(html) {
  const refs = [];
  const attrRe = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = attrRe.exec(html)) !== null) {
    const value = (m[1] ?? m[2]).trim();
    if (!value) continue;
    // In-page anchors and inline URIs are not network fetches.
    if (value.startsWith("#")) continue;
    if (/^(?:data|javascript|mailto|tel|blob):/i.test(value)) continue;
    refs.push(value);
  }
  return refs;
}

describe("admin console subresources load from every entry URL", () => {
  for (const entry of ["https://example.com/admin", "https://example.com/admin/"]) {
    it(`${new URL(entry).pathname} — every href/src it references resolves to a real, non-HTML asset`, async () => {
      const res = await SELF.fetch(entry, { redirect: "manual" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);

      const html = await res.text();
      const refs = referencedUrls(html);
      // A page that references nothing would pass the loop vacuously.
      expect(refs).not.toEqual([]);

      const broken = [];
      for (const ref of refs) {
        // new URL(ref, documentUrl) is exactly the resolution a browser
        // performs — including the "/admin" vs "/admin/" base difference
        // that is the whole point of this test.
        const resolved = new URL(ref, entry).href;
        const sub = await SELF.fetch(resolved, { redirect: "manual" });
        const contentType = sub.headers.get("content-type") ?? "";
        if (sub.status !== 200 || /text\/html/.test(contentType)) {
          broken.push(`${ref} -> ${resolved} [${sub.status} ${contentType || "no content-type"}]`);
        }
      }
      expect(broken).toEqual([]);
    });
  }
});

describe("Global Constraints — zero external references", () => {
  // Matches a literal http:// or https:// anywhere except inside an
  // xmlns="http://www.w3.org/..." declaration (the one exemption the task
  // brief calls out). Neither page uses inline SVG with an xmlns attribute,
  // so in practice no match should ever survive the exemption filter below —
  // this is a belt-and-suspenders scan, not a loophole.
  //
  // Fix-round 1 (security review): the original scan only matched literal
  // "http://"/"https://" and missed protocol-relative "//host" references
  // (e.g. src="//cdn.example/x.js" or url(//cdn.example/x.png)) — a browser
  // resolves those against whatever scheme the page itself is served over,
  // so they're just as external as a fully-qualified URL. Both are now
  // scanned for.
  function findExternalRefs(html) {
    const matches = [];

    const absoluteRe = /https?:\/\/[^\s"'<>]*/g;
    let m;
    while ((m = absoluteRe.exec(html)) !== null) {
      const start = Math.max(0, m.index - 10);
      const context = html.slice(start, m.index);
      if (/xmlns\s*=\s*["']$/.test(context)) continue;
      matches.push(m[0]);
    }

    // src="//..." / href="//..." — protocol-relative attribute values.
    const protoRelativeAttrRe = /\b(?:src|href)\s*=\s*["']\/\/[^"']*/gi;
    while ((m = protoRelativeAttrRe.exec(html)) !== null) {
      matches.push(m[0]);
    }

    // url(//...) — protocol-relative CSS references (quoted or bare).
    const protoRelativeUrlRe = /url\(\s*["']?\/\/[^)'"]*/gi;
    while ((m = protoRelativeUrlRe.exec(html)) !== null) {
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
