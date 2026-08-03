import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("worker integration", () => {
  it("GET /api/v1/ping returns 200 {pong:true}", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/ping");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
  });

  it("GET /api/v1/nope returns a 404 error envelope", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/nope");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({
      error: { code: "not_found", message: expect.any(String) },
    });
  });

  it("GET / falls through to static assets and returns 200 HTML", async () => {
    const res = await SELF.fetch("https://example.com/");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });

  // Task 10: GET /admin must serve site/admin/index.html directly (200),
  // not redirect. Regression guard for a real bug hit during development —
  // the assets binding's default html_handling ("auto-trailing-slash")
  // canonicalizes a top-level "admin.html" filename to the extensionless
  // "/admin", which (before the fix) re-entered this very route and looped
  // forever. `redirect: "manual"` makes SELF.fetch surface any 30x directly
  // instead of quietly following it, so a regression back to a redirect
  // fails this assertion rather than passing by accident.
  it("GET /admin serves the admin console directly, with no redirect", async () => {
    const res = await SELF.fetch("https://example.com/admin", { redirect: "manual" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("sanitizeSvg");
    expect(body).toContain("SANITIZE_SVG_INLINE_START");
  });
});
