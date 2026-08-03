import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

describe("schema", () => {
  describe("devices table", () => {
    it("inserts and selects a device", async () => {
      await env.DB.prepare(
        "INSERT INTO devices (id, secret_hash) VALUES (?, ?)"
      ).bind("device1", "hash1").run();

      const result = await env.DB.prepare(
        "SELECT * FROM devices WHERE id = ?"
      ).bind("device1").first();

      expect(result).toEqual({
        id: "device1",
        secret_hash: "hash1",
        created_at: expect.any(String),
        banned: 0,
        quota_day: null,
        quota_used: 0,
      });
    });
  });

  describe("configs table", () => {
    it("inserts and selects a config", async () => {
      // First insert a device that the config will reference
      await env.DB.prepare(
        "INSERT INTO devices (id, secret_hash) VALUES (?, ?)"
      ).bind("device2", "hash2").run();

      await env.DB.prepare(
        "INSERT INTO configs (id, theme, device_id, name, payload, content_hash, schema) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind("config1", "aurora", "device2", "Test Theme", '{"colors":{}}', "abc123hash", 1).run();

      const result = await env.DB.prepare(
        "SELECT * FROM configs WHERE id = ?"
      ).bind("config1").first();

      expect(result).toMatchObject({
        id: "config1",
        theme: "aurora",
        device_id: "device2",
        name: "Test Theme",
        payload: '{"colors":{}}',
        content_hash: "abc123hash",
        schema: 1,
        status: "active",
        version: 1,
        downloads: 0,
      });
    });

    it("rejects invalid status in configs", async () => {
      await env.DB.prepare(
        "INSERT INTO devices (id, secret_hash) VALUES (?, ?)"
      ).bind("device3", "hash3").run();

      const stmt = env.DB.prepare(
        "INSERT INTO configs (id, theme, device_id, name, payload, content_hash, schema, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind("config2", "aurora", "device3", "Test", '{}', "xyz", 1, "bogus");

      await expect(stmt.run()).rejects.toThrow();
    });

    it("prevents duplicate content_hash for active configs", async () => {
      await env.DB.prepare(
        "INSERT INTO devices (id, secret_hash) VALUES (?, ?)"
      ).bind("device4", "hash4").run();

      await env.DB.prepare(
        "INSERT INTO configs (id, theme, device_id, name, payload, content_hash, schema) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind("config3", "aurora", "device4", "Config A", '{}', "dup_hash", 1).run();

      const stmt = env.DB.prepare(
        "INSERT INTO configs (id, theme, device_id, name, payload, content_hash, schema) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind("config4", "aurora", "device4", "Config B", '{}', "dup_hash", 1);

      await expect(stmt.run()).rejects.toThrow();
    });
  });

  describe("assets table", () => {
    it("inserts and selects an asset", async () => {
      await env.DB.prepare(
        "INSERT INTO devices (id, secret_hash) VALUES (?, ?)"
      ).bind("device5", "hash5").run();

      await env.DB.prepare(
        "INSERT INTO configs (id, theme, device_id, name, payload, content_hash, schema) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind("config5", "aurora", "device5", "Config", '{}', "hash5", 1).run();

      await env.DB.prepare(
        "INSERT INTO assets (config_id, kind, r2_key, sha256, size) VALUES (?, ?, ?, ?, ?)"
      ).bind("config5", "logo_svg", "r2/logo.svg", "abcdef123456", 1024).run();

      const result = await env.DB.prepare(
        "SELECT * FROM assets WHERE config_id = ? AND kind = ?"
      ).bind("config5", "logo_svg").first();

      expect(result).toMatchObject({
        config_id: "config5",
        kind: "logo_svg",
        r2_key: "r2/logo.svg",
        sha256: "abcdef123456",
        size: 1024,
        status: "pending",
      });
    });
  });

  describe("dl_dedup table", () => {
    it("inserts and selects a download dedup entry", async () => {
      await env.DB.prepare(
        "INSERT INTO devices (id, secret_hash) VALUES (?, ?)"
      ).bind("device6", "hash6").run();

      await env.DB.prepare(
        "INSERT INTO configs (id, theme, device_id, name, payload, content_hash, schema) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind("config6", "aurora", "device6", "Config", '{}', "hash6", 1).run();

      await env.DB.prepare(
        "INSERT INTO dl_dedup (config_id, device_hash) VALUES (?, ?)"
      ).bind("config6", "devicehash123").run();

      const result = await env.DB.prepare(
        "SELECT * FROM dl_dedup WHERE config_id = ? AND device_hash = ?"
      ).bind("config6", "devicehash123").first();

      expect(result).toEqual({
        config_id: "config6",
        device_hash: "devicehash123",
      });
    });

    it("prevents duplicate (config_id, device_hash) pair", async () => {
      await env.DB.prepare(
        "INSERT INTO devices (id, secret_hash) VALUES (?, ?)"
      ).bind("device7", "hash7").run();

      await env.DB.prepare(
        "INSERT INTO configs (id, theme, device_id, name, payload, content_hash, schema) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind("config7", "aurora", "device7", "Config", '{}', "hash7", 1).run();

      await env.DB.prepare(
        "INSERT INTO dl_dedup (config_id, device_hash) VALUES (?, ?)"
      ).bind("config7", "devicehash456").run();

      const stmt = env.DB.prepare(
        "INSERT INTO dl_dedup (config_id, device_hash) VALUES (?, ?)"
      ).bind("config7", "devicehash456");

      await expect(stmt.run()).rejects.toThrow();
    });
  });

  describe("reports table", () => {
    it("inserts and selects a report", async () => {
      await env.DB.prepare(
        "INSERT INTO devices (id, secret_hash) VALUES (?, ?)"
      ).bind("device8", "hash8").run();

      await env.DB.prepare(
        "INSERT INTO configs (id, theme, device_id, name, payload, content_hash, schema) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind("config8", "aurora", "device8", "Config", '{}', "hash8", 1).run();

      await env.DB.prepare(
        "INSERT INTO reports (config_id, reason, ip) VALUES (?, ?, ?)"
      ).bind("config8", "Offensive content", "192.168.1.1").run();

      const result = await env.DB.prepare(
        "SELECT * FROM reports WHERE config_id = ?"
      ).bind("config8").first();

      expect(result).toMatchObject({
        config_id: "config8",
        reason: "Offensive content",
        ip: "192.168.1.1",
        created_at: expect.any(String),
        resolved: 0,
      });
    });
  });

  describe("ip_counters table", () => {
    it("inserts and selects an ip counter", async () => {
      await env.DB.prepare(
        "INSERT INTO ip_counters (ip, bucket, day, count) VALUES (?, ?, ?, ?)"
      ).bind("203.0.113.1", "reports", "2026-08-03", 5).run();

      const result = await env.DB.prepare(
        "SELECT * FROM ip_counters WHERE ip = ? AND bucket = ? AND day = ?"
      ).bind("203.0.113.1", "reports", "2026-08-03").first();

      expect(result).toEqual({
        ip: "203.0.113.1",
        bucket: "reports",
        day: "2026-08-03",
        count: 5,
      });
    });
  });
});
