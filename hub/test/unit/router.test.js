import { describe, expect, it } from "vitest";
import { createRouter } from "../../src/router.js";

function req(method, path) {
  return new Request(`https://example.com${path}`, { method });
}

describe("router", () => {
  it("matches a static path", () => {
    const router = createRouter();
    router.add("GET", "/api/v1/ping", () => new Response("pong"));

    const res = router.dispatch(req("GET", "/api/v1/ping"), {});

    expect(res).not.toBeNull();
  });

  it("captures a single :param segment", () => {
    const router = createRouter();
    let captured = null;
    router.add("GET", "/themes/:theme/configs/:id", (request, env, params) => {
      captured = params;
      return new Response("ok");
    });

    router.dispatch(req("GET", "/themes/aurora/configs/abc123"), {});

    expect(captured).toEqual({ theme: "aurora", id: "abc123" });
  });

  it("returns null when the method does not match", () => {
    const router = createRouter();
    router.add("GET", "/api/v1/ping", () => new Response("pong"));

    const res = router.dispatch(req("POST", "/api/v1/ping"), {});

    expect(res).toBeNull();
  });

  it("returns null when no pattern matches the path", () => {
    const router = createRouter();
    router.add("GET", "/api/v1/ping", () => new Response("pong"));

    const res = router.dispatch(req("GET", "/api/v1/nope"), {});

    expect(res).toBeNull();
  });

  it("matches multi-segment static and dynamic combinations", () => {
    const router = createRouter();
    let captured = null;
    router.add("POST", "/themes/:theme/configs/:id/download", (request, env, params) => {
      captured = params;
      return new Response("ok");
    });

    const res = router.dispatch(req("POST", "/themes/aurora/configs/xyz/download"), {});

    expect(res).not.toBeNull();
    expect(captured).toEqual({ theme: "aurora", id: "xyz" });
  });

  it("does not match when segment counts differ", () => {
    const router = createRouter();
    router.add("GET", "/themes/:theme/configs/:id", () => new Response("ok"));

    const res = router.dispatch(req("GET", "/themes/aurora/configs"), {});

    expect(res).toBeNull();
  });
});
