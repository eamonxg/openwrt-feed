import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// LuCI pages are served from the router's origin (e.g. http://192.168.1.1)
// and now call the hub API straight from the browser, so every API and
// asset response must be CORS-readable. The static site stays same-origin.
const ORIGIN = "http://192.168.1.1";

describe("CORS", () => {
  it("OPTIONS preflight on the list endpoint returns 204 with CORS headers", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/themes/aurora/configs", {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toBe("GET, POST, PUT, DELETE, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("Content-Type");
    expect(res.headers.get("access-control-max-age")).toBe("86400");
  });

  it("GET /api/v1/ping carries allow-origin", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/ping", {
      headers: { Origin: ORIGIN },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("API 404 error envelope carries allow-origin", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/nope", {
      headers: { Origin: ORIGIN },
    });

    expect(res.status).toBe(404);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("malformed-path 400 envelope carries allow-origin", async () => {
    const res = await SELF.fetch("https://example.com/api/v1/themes/aurora/configs/%ff", {
      headers: { Origin: ORIGIN },
    });

    expect(res.status).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("asset route responses carry allow-origin", async () => {
    // A missing asset still returns a JSON error envelope; the browser must
    // be able to read it, so the header is required on error paths too.
    const res = await SELF.fetch("https://example.com/assets/zzzzzzzz/logo_svg", {
      headers: { Origin: ORIGIN },
    });

    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("the static site is NOT given CORS headers", async () => {
    const res = await SELF.fetch("https://example.com/", { headers: { Origin: ORIGIN } });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
