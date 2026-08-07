import { describe, expect, it } from "vitest";
import {
  validateMeta,
  validateNickname,
  validatePayload,
  cleanText,
  COLOR_TOKENS,
  ASSET_KINDS,
  ASSET_SIZE_LIMITS,
} from "../../src/validate.js";
import { HttpError } from "../../src/auth.js";
import { buildColors, buildLayout, buildTypography, buildPayload } from "../helpers.js";

function expectHttpError(fn, status, code) {
  try {
    fn();
    expect.unreachable(`expected HttpError(${status}, ${code}) to be thrown`);
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Constants sanity
// ---------------------------------------------------------------------------

describe("exported constants", () => {
  it("COLOR_TOKENS has exactly 31 tokens in contract order", () => {
    expect(COLOR_TOKENS).toHaveLength(31);
    expect(COLOR_TOKENS).toEqual([
      "bg", "surface", "text", "brand", "on_brand", "link", "info", "warning",
      "success", "danger", "text_muted", "text_subtle", "surface_sunken",
      "surface_overlay", "hairline", "hover_faint", "brand_hover",
      "brand_subtle", "brand_subtle_hover", "focus_ring", "progress_start",
      "progress_end", "info_surface", "warning_surface", "success_surface",
      "danger_surface", "danger_surface_hover", "control_bg", "scrim",
      "mega_menu_bg", "mega_menu_scrim",
    ]);
  });

  it("ASSET_KINDS has exactly 20 kinds", () => {
    expect(ASSET_KINDS).toHaveLength(20);
    expect(ASSET_KINDS).toEqual([
      "logo_svg", "favicon_png", "favicon_ico", "pwa_icon_192",
      "pwa_icon_512", "login_bg", "font_sans", "font_mono",
      // 每个不同的自定义快捷方式图标一个槽位，按首次出现编号。12 = 快捷方式
      // 本身的上限，所以没有配置能凑出第 13 个不同的图标。
      "toolbar_icon_0", "toolbar_icon_1", "toolbar_icon_2", "toolbar_icon_3",
      "toolbar_icon_4", "toolbar_icon_5", "toolbar_icon_6", "toolbar_icon_7",
      "toolbar_icon_8", "toolbar_icon_9", "toolbar_icon_10", "toolbar_icon_11",
    ]);
  });

  it("ASSET_SIZE_LIMITS: fonts 8 MiB, toolbar icons 256 KiB, the rest 2 MiB", () => {
    for (const kind of ASSET_KINDS) {
      let expected = 2097152;
      if (kind === "font_sans" || kind === "font_mono") expected = 8388608;
      else if (kind.startsWith("toolbar_icon_")) expected = 262144;
      expect(ASSET_SIZE_LIMITS[kind]).toBe(expected);
    }
  });

  // 一份资产拉满的配置必须仍然批得下来。approve 把每个非 passthrough 的 kind
  // 的字节装进一个 JSON body，上限 ADMIN_APPROVE_BODY_BYTES（25 MB）；字体走
  // passthrough 所以不进 body。这一条守的就是「能分享但永远批不了」不再出现。
  it("a fully-loaded config still fits the approve body", () => {
    const inBody = ASSET_KINDS.filter(
      (kind) => kind !== "font_sans" && kind !== "font_mono"
    );
    const raw = inBody.reduce((sum, kind) => sum + ASSET_SIZE_LIMITS[kind], 0);
    // base64 是 4/3，再给 JSON 结构留点余量
    expect(Math.ceil(raw * 1.34)).toBeLessThan(25 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------------------
// cleanText — Global Constraint helper (strip control chars, NFC normalize),
// shared by validateMeta/validatePayload internally and reused as-is by
// configs.js for the report `reason` field.
// ---------------------------------------------------------------------------

describe("cleanText", () => {
  const makeError = () => new HttpError(400, "test_error", "bad text");

  it("strips control characters (U+0000-U+001F, U+007F)", () => {
    expect(cleanText("abc", makeError)).toBe("abc");
  });

  it("NFC-normalizes decomposed text", () => {
    const decomposed = "é"; // "e" + combining acute accent
    expect(cleanText(decomposed, makeError)).toBe("é");
    expect(cleanText(decomposed, makeError)).toBe(decomposed.normalize("NFC"));
  });

  it("passes through ordinary text unchanged", () => {
    expect(cleanText("Hello, world!", makeError)).toBe("Hello, world!");
  });

  it("throws the caller-supplied error for a non-string value", () => {
    expectHttpError(() => cleanText(123, makeError), 400, "test_error");
  });

  it("throws the caller-supplied error for undefined", () => {
    expectHttpError(() => cleanText(undefined, makeError), 400, "test_error");
  });
});

// ---------------------------------------------------------------------------
// validatePayload - happy path
// ---------------------------------------------------------------------------

describe("validatePayload - valid payload", () => {
  it("passes and returns a cleaned canonical copy", () => {
    const payload = buildPayload();
    const cleaned = validatePayload(payload);
    expect(cleaned.schema).toBe(1);
    expect(cleaned.theme).toBe("aurora");
    expect(Object.keys(cleaned.colors)).toHaveLength(62);
    expect(cleaned.layout).toEqual(buildLayout());
    expect(cleaned.typography).toEqual(buildTypography());
    expect(cleaned.toolbar).toHaveLength(2);
    expect(cleaned.assets).toHaveLength(2);
  });

  it("lowercases uppercase hex color values", () => {
    const payload = buildPayload();
    payload.colors.light_bg = "#ABCDEF";
    const cleaned = validatePayload(payload);
    expect(cleaned.colors.light_bg).toBe("#abcdef");
  });

  it("defaults toolbar and assets to empty arrays when absent", () => {
    const payload = buildPayload();
    delete payload.toolbar;
    delete payload.assets;
    const cleaned = validatePayload(payload);
    expect(cleaned.toolbar).toEqual([]);
    expect(cleaned.assets).toEqual([]);
  });

  it("accepts an explicitly empty toolbar/assets array", () => {
    const payload = buildPayload({ toolbar: [], assets: [] });
    const cleaned = validatePayload(payload);
    expect(cleaned.toolbar).toEqual([]);
    expect(cleaned.assets).toEqual([]);
  });

  it("rejects an explicit null toolbar rather than silently defaulting to []", () => {
    const payload = buildPayload({ toolbar: null });
    expectHttpError(() => validatePayload(payload), 400, "bad_toolbar");
  });

  it("rejects an explicit null assets rather than silently defaulting to []", () => {
    const payload = buildPayload({ assets: null });
    expectHttpError(() => validatePayload(payload), 400, "bad_assets");
  });

  it("omits the icon key on a toolbar item when icon is absent", () => {
    const payload = buildPayload({
      toolbar: [{ title: "Home", url: "/", enabled: "1" }],
    });
    const cleaned = validatePayload(payload);
    expect(cleaned.toolbar[0]).toEqual({ title: "Home", url: "/", enabled: "1" });
    expect(cleaned.toolbar[0]).not.toHaveProperty("icon");
  });
});

// ---------------------------------------------------------------------------
// Top-level structure
// ---------------------------------------------------------------------------

describe("validatePayload - top-level structure", () => {
  it("rejects an unknown top-level field", () => {
    const payload = buildPayload({ extra_field: "nope" });
    expectHttpError(() => validatePayload(payload), 400, "unknown_field");
  });

  it.each([
    ["missing", undefined],
    ["wrong number", 2],
    ["string", "1"],
  ])("rejects schema that is %s", (_label, schema) => {
    const payload = buildPayload({ schema });
    expectHttpError(() => validatePayload(payload), 400, "bad_schema");
  });

  it.each([
    ["missing", undefined],
    ["wrong theme", "material"],
  ])("rejects theme that is %s", (_label, theme) => {
    const payload = buildPayload({ theme });
    expectHttpError(() => validatePayload(payload), 400, "unknown_theme");
  });

  it("rejects an oversized payload before any deep walk (bad_schema, not unknown_field)", () => {
    const payload = buildPayload({ huge_junk: "x".repeat(300000) });
    expectHttpError(() => validatePayload(payload), 400, "bad_schema");
  });

  it("rejects a non-object payload with a message matching the actual reason", () => {
    for (const bad of [undefined, null, "nope", [1, 2, 3], 42, true]) {
      try {
        validatePayload(bad);
        expect.unreachable(`expected ${String(bad)} to be rejected`);
      } catch (err) {
        expect(err).toBeInstanceOf(HttpError);
        expect(err.status).toBe(400);
        expect(err.code).toBe("bad_schema");
        expect(err.message).toBe("Payload must be an object.");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Size boundary (exact byte comparator, not just "clearly oversized")
// ---------------------------------------------------------------------------

describe("validatePayload - size boundary", () => {
  // Every field in the v1 schema has its own small length cap, so no
  // genuinely valid payload can approach 256 KiB. To exercise the exact
  // comparator (> 262144) we pad an otherwise-valid payload with an unknown
  // top-level field to a precise total JSON length. The size gate runs
  // before the unknown-field check, so:
  //   - at exactly the limit, the size gate lets it through and the error
  //     that actually surfaces is unknown_field (proving it wasn't bad_schema);
  //   - one byte over, the size gate itself rejects it as bad_schema.
  function paddedPayload(targetLength) {
    const base = buildPayload();
    base._pad = "";
    const overhead = JSON.stringify(base).length;
    const needed = targetLength - overhead;
    if (needed < 0) {
      throw new Error(`target length ${targetLength} is smaller than base overhead ${overhead}`);
    }
    base._pad = "a".repeat(needed);
    return base;
  }

  it("lets a payload of exactly 262144 bytes through the size gate", () => {
    const payload = paddedPayload(262144);
    expect(JSON.stringify(payload)).toHaveLength(262144);
    try {
      validatePayload(payload);
      expect.unreachable("expected the unknown _pad field to be rejected");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect(err.code).not.toBe("bad_schema");
      expect(err.code).toBe("unknown_field");
    }
  });

  it("rejects a payload of 262145 bytes as bad_schema, one byte past the limit", () => {
    const payload = paddedPayload(262145);
    expect(JSON.stringify(payload)).toHaveLength(262145);
    expectHttpError(() => validatePayload(payload), 400, "bad_schema");
  });
});

// ---------------------------------------------------------------------------
// colors
// ---------------------------------------------------------------------------

describe("validatePayload - colors", () => {
  it("rejects when a key is missing (61 keys)", () => {
    const payload = buildPayload();
    delete payload.colors.light_bg;
    expectHttpError(() => validatePayload(payload), 400, "bad_colors");
  });

  it("rejects when an extra key is present (63 keys)", () => {
    const payload = buildPayload();
    payload.colors.light_bogus = "#000000";
    expectHttpError(() => validatePayload(payload), 400, "bad_colors");
  });

  it("rejects a misspelled token name (still 62 keys)", () => {
    const payload = buildPayload();
    delete payload.colors.light_bg;
    payload.colors.light_bgg = "#000000";
    expectHttpError(() => validatePayload(payload), 400, "bad_colors");
  });

  it("rejects an invalid hex value", () => {
    const payload = buildPayload();
    payload.colors.light_bg = "#GGGGGG";
    expectHttpError(() => validatePayload(payload), 400, "bad_colors");
  });

  it("accepts 3-digit hex color (#fff) and lowercases it", () => {
    const payload = buildPayload();
    payload.colors.light_bg = "#fff";
    const cleaned = validatePayload(payload);
    expect(cleaned.colors.light_bg).toBe("#fff");
  });

  it("accepts 3-digit uppercase hex color (#ABC) and lowercases it", () => {
    const payload = buildPayload();
    payload.colors.light_bg = "#ABC";
    const cleaned = validatePayload(payload);
    expect(cleaned.colors.light_bg).toBe("#abc");
  });

  it("accepts 4-digit hex color (#0009) and lowercases it", () => {
    const payload = buildPayload();
    payload.colors.light_bg = "#0009";
    const cleaned = validatePayload(payload);
    expect(cleaned.colors.light_bg).toBe("#0009");
  });

  it("accepts 8-digit hex color (#121a2221) and lowercases it", () => {
    const payload = buildPayload();
    payload.colors.light_bg = "#121a2221";
    const cleaned = validatePayload(payload);
    expect(cleaned.colors.light_bg).toBe("#121a2221");
  });

  it("rejects 5-digit hex color (#12345)", () => {
    const payload = buildPayload();
    payload.colors.light_bg = "#12345";
    expectHttpError(() => validatePayload(payload), 400, "bad_colors");
  });

  it("rejects 7-digit hex color (#1234567)", () => {
    const payload = buildPayload();
    payload.colors.light_bg = "#1234567";
    expectHttpError(() => validatePayload(payload), 400, "bad_colors");
  });

  it("rejects a non-string colors container", () => {
    const payload = buildPayload({ colors: null });
    expectHttpError(() => validatePayload(payload), 400, "bad_colors");
  });
});

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

describe("validatePayload - layout", () => {
  const remBoundaries = [
    ["struct_spacing", "0.05rem", true],
    ["struct_spacing", "1rem", true],
    ["struct_spacing", "0.04rem", false],
    ["struct_spacing", "1.01rem", false],
    ["struct_radius_base", "0rem", true],
    ["struct_radius_base", "2rem", true],
    ["struct_radius_base", "2.01rem", false],
    ["struct_content_width_centered", "40rem", true],
    ["struct_content_width_centered", "160rem", true],
    ["struct_content_width_centered", "39.99rem", false],
    ["struct_content_width_centered", "160.01rem", false],
  ];

  it.each(remBoundaries)("field %s = %s -> valid:%s", (field, value, shouldPass) => {
    const payload = buildPayload();
    payload.layout[field] = value;
    if (shouldPass) {
      expect(() => validatePayload(payload)).not.toThrow();
    } else {
      expectHttpError(() => validatePayload(payload), 400, "bad_layout");
    }
  });

  it("rejects a non-rem unit like 10px", () => {
    const payload = buildPayload();
    payload.layout.struct_spacing = "10px";
    expectHttpError(() => validatePayload(payload), 400, "bad_layout");
  });

  it("rejects an invalid nav_type", () => {
    const payload = buildPayload();
    payload.layout.nav_type = "hamburger";
    expectHttpError(() => validatePayload(payload), 400, "bad_layout");
  });

  it("rejects an invalid toolbar_enabled value", () => {
    const payload = buildPayload();
    payload.layout.toolbar_enabled = "yes";
    expectHttpError(() => validatePayload(payload), 400, "bad_layout");
  });

  it("rejects a missing layout key", () => {
    const payload = buildPayload();
    delete payload.layout.toolbar_enabled;
    expectHttpError(() => validatePayload(payload), 400, "bad_layout");
  });

  it("rejects an unknown key inside layout", () => {
    const payload = buildPayload();
    payload.layout.extra = "x";
    expectHttpError(() => validatePayload(payload), 400, "bad_layout");
  });
});

// ---------------------------------------------------------------------------
// typography
// ---------------------------------------------------------------------------

describe("validatePayload - typography", () => {
  it.each(["default", "system", "geist-sans", "nunito", "space-grotesk"])(
    "accepts font_sans enum value %s",
    (value) => {
      const payload = buildPayload();
      payload.typography.font_sans = value;
      expect(() => validatePayload(payload)).not.toThrow();
    }
  );

  it.each(["default", "jetbrains-mono", "maple-mono", "fira-code", "cascadia-code"])(
    "accepts font_mono enum value %s",
    (value) => {
      const payload = buildPayload();
      payload.typography.font_mono = value;
      expect(() => validatePayload(payload)).not.toThrow();
    }
  );

  it("rejects an unknown font_sans value", () => {
    const payload = buildPayload();
    payload.typography.font_sans = "comic-sans";
    expectHttpError(() => validatePayload(payload), 400, "bad_typography");
  });

  it("rejects an unknown font_mono value", () => {
    const payload = buildPayload();
    payload.typography.font_mono = "courier";
    expectHttpError(() => validatePayload(payload), 400, "bad_typography");
  });

  it("rejects a struct_font_sans containing '<'", () => {
    const payload = buildPayload();
    payload.typography.struct_font_sans = "<script>";
    expectHttpError(() => validatePayload(payload), 400, "bad_typography");
  });

  it("rejects a struct_font_mono longer than 200 characters", () => {
    const payload = buildPayload();
    payload.typography.struct_font_mono = "a".repeat(201);
    expectHttpError(() => validatePayload(payload), 400, "bad_typography");
  });

  it("accepts a struct_font_sans of exactly 200 characters", () => {
    const payload = buildPayload();
    payload.typography.struct_font_sans = "a".repeat(200);
    expect(() => validatePayload(payload)).not.toThrow();
  });

  it("rejects a missing typography key", () => {
    const payload = buildPayload();
    delete payload.typography.font_mono;
    expectHttpError(() => validatePayload(payload), 400, "bad_typography");
  });
});

// ---------------------------------------------------------------------------
// toolbar
// ---------------------------------------------------------------------------

describe("validatePayload - toolbar", () => {
  it("rejects more than 12 items", () => {
    const payload = buildPayload({
      toolbar: Array.from({ length: 13 }, (_, i) => ({
        title: `Item ${i}`,
        url: "/",
        enabled: "1",
      })),
    });
    expectHttpError(() => validatePayload(payload), 400, "bad_toolbar");
  });

  it("accepts exactly 12 items", () => {
    const payload = buildPayload({
      toolbar: Array.from({ length: 12 }, (_, i) => ({
        title: `Item ${i}`,
        url: "/",
        enabled: "1",
      })),
    });
    expect(() => validatePayload(payload)).not.toThrow();
  });

  it("rejects a title of 31 characters", () => {
    const payload = buildPayload({
      toolbar: [{ title: "a".repeat(31), url: "/", enabled: "1" }],
    });
    expectHttpError(() => validatePayload(payload), 400, "bad_toolbar");
  });

  it("accepts a title of exactly 30 characters", () => {
    const payload = buildPayload({
      toolbar: [{ title: "a".repeat(30), url: "/", enabled: "1" }],
    });
    expect(() => validatePayload(payload)).not.toThrow();
  });

  it("rejects a title that is empty after control characters are stripped", () => {
    const payload = buildPayload({
      toolbar: [{ title: "", url: "/", enabled: "1" }],
    });
    expectHttpError(() => validatePayload(payload), 400, "bad_toolbar");
  });

  it.each([
    ["javascript: URL", "javascript:alert(1)", false],
    ["ftp:// URL", "ftp://example.com", false],
    ["protocol-relative URL", "//evil.com", false],
    ["absolute path", "/admin", true],
    ["https URL", "https://x.y", true],
    ["http URL", "http://x.y", true],
  ])("%s -> valid:%s", (_label, url, shouldPass) => {
    const payload = buildPayload({ toolbar: [{ title: "Item", url, enabled: "1" }] });
    if (shouldPass) {
      expect(() => validatePayload(payload)).not.toThrow();
    } else {
      expectHttpError(() => validatePayload(payload), 400, "bad_toolbar");
    }
  });

  it("rejects a url longer than 200 characters", () => {
    const payload = buildPayload({
      toolbar: [{ title: "Item", url: "/" + "a".repeat(200), enabled: "1" }],
    });
    expectHttpError(() => validatePayload(payload), 400, "bad_toolbar");
  });

  it("rejects an invalid enabled value", () => {
    const payload = buildPayload({
      toolbar: [{ title: "Item", url: "/", enabled: "true" }],
    });
    expectHttpError(() => validatePayload(payload), 400, "bad_toolbar");
  });

  it("rejects an icon with disallowed characters", () => {
    const payload = buildPayload({
      toolbar: [{ title: "Item", url: "/", icon: "not a valid icon!", enabled: "1" }],
    });
    expectHttpError(() => validatePayload(payload), 400, "bad_toolbar");
  });

  it("allows icon to be absent", () => {
    const payload = buildPayload({
      toolbar: [{ title: "Item", url: "/", enabled: "1" }],
    });
    expect(() => validatePayload(payload)).not.toThrow();
  });

  it("rejects an unknown key inside a toolbar item", () => {
    const payload = buildPayload({
      toolbar: [{ title: "Item", url: "/", enabled: "1", bogus: "x" }],
    });
    expectHttpError(() => validatePayload(payload), 400, "bad_toolbar");
  });

  it("rejects a non-array toolbar", () => {
    const payload = buildPayload({ toolbar: { title: "not an array" } });
    expectHttpError(() => validatePayload(payload), 400, "bad_toolbar");
  });
});

// ---------------------------------------------------------------------------
// assets
// ---------------------------------------------------------------------------

describe("validatePayload - assets", () => {
  it("rejects more than 8 items", () => {
    const payload = buildPayload({
      assets: ASSET_KINDS.concat(["logo_svg"]).map((kind, i) => ({
        kind: i < ASSET_KINDS.length ? kind : "favicon_png",
        sha256: i.toString().padStart(64, "0"),
        size: 100,
      })),
    });
    expectHttpError(() => validatePayload(payload), 400, "bad_assets");
  });

  it("rejects a duplicate kind", () => {
    const payload = buildPayload({
      assets: [
        { kind: "logo_svg", sha256: "a".repeat(64), size: 100 },
        { kind: "logo_svg", sha256: "b".repeat(64), size: 100 },
      ],
    });
    expectHttpError(() => validatePayload(payload), 400, "bad_assets");
  });

  it("rejects a non-hex sha256", () => {
    const payload = buildPayload({
      assets: [{ kind: "logo_svg", sha256: "z".repeat(64), size: 100 }],
    });
    expectHttpError(() => validatePayload(payload), 400, "bad_assets");
  });

  it("rejects an uppercase sha256 (must be lowercase hex)", () => {
    const payload = buildPayload({
      assets: [{ kind: "logo_svg", sha256: "A".repeat(64), size: 100 }],
    });
    expectHttpError(() => validatePayload(payload), 400, "bad_assets");
  });

  it("rejects an unknown kind", () => {
    const payload = buildPayload({
      assets: [{ kind: "banner", sha256: "a".repeat(64), size: 100 }],
    });
    expectHttpError(() => validatePayload(payload), 400, "bad_assets");
  });

  it.each([
    ["logo_svg", 2097152, true],
    ["logo_svg", 2097153, false],
    ["font_sans", 8388608, true],
    ["font_sans", 8388609, false],
    ["font_mono", 8388608, true],
    ["font_mono", 8388609, false],
  ])("kind %s size %d -> valid:%s", (kind, size, shouldPass) => {
    const payload = buildPayload({ assets: [{ kind, sha256: "a".repeat(64), size }] });
    if (shouldPass) {
      expect(() => validatePayload(payload)).not.toThrow();
    } else {
      expectHttpError(() => validatePayload(payload), 400, "bad_assets");
    }
  });

  it("rejects a zero or negative size", () => {
    const payload = buildPayload({
      assets: [{ kind: "logo_svg", sha256: "a".repeat(64), size: 0 }],
    });
    expectHttpError(() => validatePayload(payload), 400, "bad_assets");
  });

  it("rejects a non-integer size", () => {
    const payload = buildPayload({
      assets: [{ kind: "logo_svg", sha256: "a".repeat(64), size: 100.5 }],
    });
    expectHttpError(() => validatePayload(payload), 400, "bad_assets");
  });

  it("rejects an unknown key inside an asset item", () => {
    const payload = buildPayload({
      assets: [{ kind: "logo_svg", sha256: "a".repeat(64), size: 100, bogus: "x" }],
    });
    expectHttpError(() => validatePayload(payload), 400, "bad_assets");
  });

  it("rejects a non-array assets value", () => {
    const payload = buildPayload({ assets: { kind: "logo_svg" } });
    expectHttpError(() => validatePayload(payload), 400, "bad_assets");
  });
});

// ---------------------------------------------------------------------------
// validateMeta
// ---------------------------------------------------------------------------

describe("validateMeta", () => {
  it("passes through valid meta unchanged", () => {
    const meta = validateMeta({ name: "My Theme", description: "A nice theme." });
    expect(meta).toEqual({ name: "My Theme", description: "A nice theme." });
  });

  it("defaults description to empty string when absent", () => {
    const meta = validateMeta({ name: "My Theme" });
    expect(meta).toEqual({ name: "My Theme", description: "" });
  });

  it("no longer accepts an author -- signing comes from the profile", () => {
    expect(validateMeta({ name: "Fine", author: "ignored", description: "" })).toEqual({
      name: "Fine",
      description: "",
    });
  });

  it("rejects an empty name", () => {
    expectHttpError(() => validateMeta({ name: "" }), 400, "bad_meta");
  });

  it("rejects a missing name", () => {
    expectHttpError(() => validateMeta({}), 400, "bad_meta");
  });

  it("accepts a name of exactly 60 characters", () => {
    const meta = validateMeta({ name: "a".repeat(60) });
    expect(meta.name).toHaveLength(60);
  });

  it("rejects a name of 61 characters", () => {
    expectHttpError(() => validateMeta({ name: "a".repeat(61) }), 400, "bad_meta");
  });

  it("accepts a description of exactly 500 characters", () => {
    const meta = validateMeta({ name: "T", description: "a".repeat(500) });
    expect(meta.description).toHaveLength(500);
  });

  it("rejects a description longer than 500 characters", () => {
    expectHttpError(
      () => validateMeta({ name: "T", description: "a".repeat(501) }),
      400,
      "bad_meta"
    );
  });

  it("strips control characters (e.g. U+0007) from name", () => {
    const meta = validateMeta({ name: "ABC" });
    expect(meta.name).toBe("ABC");
  });

  it("rejects a name that becomes empty once control characters are stripped", () => {
    expectHttpError(() => validateMeta({ name: "" }), 400, "bad_meta");
  });

  it("NFC-normalizes text", () => {
    // "é" as e + combining acute (NFD) should normalize to the precomposed form (NFC)
    const decomposed = "é";
    const meta = validateMeta({ name: decomposed });
    expect(meta.name).toBe("é");
    expect(meta.name).toBe(decomposed.normalize("NFC"));
  });
});

// ---------------------------------------------------------------------------
// Attack vectors
// ---------------------------------------------------------------------------

describe("attack vectors", () => {
  it("a name containing <script> passes validation and is stored verbatim (escaping is the render layer's job)", () => {
    const meta = validateMeta({ name: "<script>alert(1)</script>" });
    expect(meta.name).toBe("<script>alert(1)</script>");
  });

  it("rejects a javascript: URL in a toolbar item", () => {
    const payload = buildPayload({
      toolbar: [{ title: "Evil", url: "javascript:alert(document.cookie)", enabled: "1" }],
    });
    expectHttpError(() => validatePayload(payload), 400, "bad_toolbar");
  });

  it("rejects an oversized payload (>256KiB) as bad_schema", () => {
    const payload = buildPayload({ padding: "x".repeat(500 * 1024) });
    expectHttpError(() => validatePayload(payload), 400, "bad_schema");
  });
});

// ---------------------------------------------------------------------------

describe("validateNickname", () => {
  it("trims before folding, so a padded name cannot claim a second slot", () => {
    expect(validateNickname("  Eamon  ")).toEqual({ nickname: "Eamon", nickname_lc: "eamon" });
  });

  it("keeps display casing but folds the uniqueness key", () => {
    expect(validateNickname("EaMoN")).toEqual({ nickname: "EaMoN", nickname_lc: "eamon" });
  });

  it("strips control characters", () => {
    expect(validateNickname("Ea\u0007mon").nickname).toBe("Eamon");
  });

  it("rejects an all-whitespace nickname", () => {
    expectHttpError(() => validateNickname("   "), 400, "invalid_nickname");
  });

  it("rejects more than 40 characters", () => {
    expectHttpError(() => validateNickname("a".repeat(41)), 400, "invalid_nickname");
  });

  it("accepts exactly 40 characters", () => {
    expect(validateNickname("a".repeat(40)).nickname).toHaveLength(40);
  });

  it("rejects non-strings", () => {
    expectHttpError(() => validateNickname(42), 400, "invalid_nickname");
  });
});
