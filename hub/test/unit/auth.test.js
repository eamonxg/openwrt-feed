import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  HttpError,
  timingSafeEqual,
  requireAdmin,
  deviceFromToken,
  bumpQuota,
} from "../../src/auth.js";
import { sha256Hex } from "../../src/ids.js";

const VALID_TOKEN = "a".repeat(64);

function req(headers = {}) {
  return new Request("https://example.com/api/v1/admin/pending", { headers });
}

describe("HttpError", () => {
  it("carries status, code and message", () => {
    const err = new HttpError(401, "unauthorized", "nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(401);
    expect(err.code).toBe("unauthorized");
    expect(err.message).toBe("nope");
  });
});

describe("timingSafeEqual", () => {
  it("returns true for equal strings", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
  });

  it("returns false for strings of different lengths", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("requireAdmin", () => {
  const env = { ADMIN_TOKEN: "supersecret" };

  it("passes for a matching bearer token", () => {
    expect(() =>
      requireAdmin(req({ Authorization: "Bearer supersecret" }), env)
    ).not.toThrow();
  });

  it("throws HttpError(401, unauthorized) for a missing header", () => {
    try {
      requireAdmin(req(), env);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect(err.status).toBe(401);
      expect(err.code).toBe("unauthorized");
    }
  });

  it("throws HttpError(401, unauthorized) for a wrong token", () => {
    expect(() => requireAdmin(req({ Authorization: "Bearer wrong" }), env)).toThrow(
      HttpError
    );
  });

  it("throws HttpError(500, admin_disabled) when env.ADMIN_TOKEN is missing, before comparing", () => {
    try {
      requireAdmin(req({ Authorization: "Bearer supersecret" }), {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect(err.status).toBe(500);
      expect(err.code).toBe("admin_disabled");
    }
  });

  it("throws HttpError(500, admin_disabled) when env.ADMIN_TOKEN is an empty string", () => {
    try {
      requireAdmin(req({ Authorization: "Bearer " }), { ADMIN_TOKEN: "" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect(err.status).toBe(500);
      expect(err.code).toBe("admin_disabled");
    }
  });
});

describe("requireAdmin actor resolution", () => {
  function req(token) {
    return new Request("https://example.com/api/v1/admin/pending", {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }

  it("maps the legacy single token to the root actor", () => {
    expect(requireAdmin(req("t"), { ADMIN_TOKEN: "t" })).toBe("root");
  });

  it("maps a named token to its name", () => {
    const env = { ADMIN_TOKEN: "t", ADMIN_TOKENS: "alice:a-token,bob:b-token" };
    expect(requireAdmin(req("a-token"), env)).toBe("alice");
    expect(requireAdmin(req("b-token"), env)).toBe("bob");
    expect(requireAdmin(req("t"), env)).toBe("root");
  });

  it("skips an entry whose actor name is not a plain identifier", () => {
    // 名字会原样进 admin_actions.actor,所以带空格/标点的条目直接丢弃,
    // 而不是让脏字符串进日志。
    const env = { ADMIN_TOKENS: "not a name:x-token,ok:y-token" };
    expect(() => requireAdmin(req("x-token"), env)).toThrow();
    expect(requireAdmin(req("y-token"), env)).toBe("ok");
  });

  it("skips an entry with no separator at all", () => {
    const env = { ADMIN_TOKEN: "t", ADMIN_TOKENS: "garbage" };
    expect(() => requireAdmin(req("garbage"), env)).toThrow();
    expect(requireAdmin(req("t"), env)).toBe("root");
  });

  it("fails closed when neither secret is set", () => {
    expect(() => requireAdmin(req("anything"), {})).toThrow(
      expect.objectContaining({ status: 500, code: "admin_disabled" })
    );
  });

  it("rejects a token that matches nothing", () => {
    expect(() => requireAdmin(req("nope"), { ADMIN_TOKEN: "t" })).toThrow(
      expect.objectContaining({ status: 401, code: "unauthorized" })
    );
  });
});

describe("deviceFromToken", () => {
  it("throws HttpError(400, bad_token) for a malformed token", async () => {
    try {
      await deviceFromToken(env.DB, "not-a-token", { register: true });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect(err.status).toBe(400);
      expect(err.code).toBe("bad_token");
    }
  });

  it("returns null for an unknown token when register is false", async () => {
    const token = "b".repeat(64);
    const device = await deviceFromToken(env.DB, token, { register: false });
    expect(device).toBeNull();
  });

  it("registers a fresh device with an 8 char id when register is true", async () => {
    const token = "c".repeat(64);
    const device = await deviceFromToken(env.DB, token, { register: true });
    expect(device).not.toBeNull();
    expect(device.id).toHaveLength(8);
    expect(device.banned).toBe(0);
    expect(device.quota_used).toBe(0);
  });

  it("returns the same device row on subsequent lookups of the same token", async () => {
    const token = "d".repeat(64);
    const first = await deviceFromToken(env.DB, token, { register: true });
    const second = await deviceFromToken(env.DB, token, { register: false });
    expect(second).not.toBeNull();
    expect(second.id).toBe(first.id);
  });

  it("propagates the banned flag for an existing device", async () => {
    const token = "e".repeat(64);
    const hash = await sha256Hex(token);
    await env.DB.prepare(
      "INSERT INTO devices (id, secret_hash, banned) VALUES (?, ?, 1)"
    )
      .bind("banneddv", hash)
      .run();

    const device = await deviceFromToken(env.DB, token, { register: false });
    expect(device.banned).toBe(1);
  });
});

describe("bumpQuota", () => {
  it("allows up to 10 uses per day and rejects the 11th", async () => {
    const token = "f".repeat(64);
    let device = await deviceFromToken(env.DB, token, { register: true });
    const today = "2026-08-03";

    for (let i = 0; i < 10; i++) {
      const ok = await bumpQuota(env.DB, device, today);
      expect(ok).toBe(true);
      device = await deviceFromToken(env.DB, token, { register: false });
    }

    const rejected = await bumpQuota(env.DB, device, today);
    expect(rejected).toBe(false);
    expect(device.quota_used).toBe(10);
  });

  it("resets the counter across a UTC day boundary", async () => {
    const token = "0".repeat(64);
    let device = await deviceFromToken(env.DB, token, { register: true });

    for (let i = 0; i < 10; i++) {
      await bumpQuota(env.DB, device, "2026-08-02");
      device = await deviceFromToken(env.DB, token, { register: false });
    }
    expect(await bumpQuota(env.DB, device, "2026-08-02")).toBe(false);

    const ok = await bumpQuota(env.DB, device, "2026-08-03");
    expect(ok).toBe(true);

    const refreshed = await deviceFromToken(env.DB, token, { register: false });
    expect(refreshed.quota_day).toBe("2026-08-03");
    expect(refreshed.quota_used).toBe(1);
  });
});
