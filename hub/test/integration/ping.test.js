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
});
