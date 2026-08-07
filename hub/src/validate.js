import { HttpError } from "./auth.js";
import { TOOLBAR_ICON_KINDS, isToolbarIconKind } from "./assets.js";

// ---------------------------------------------------------------------------
// Contract constants (schema v1, theme "aurora")
// ---------------------------------------------------------------------------

export const COLOR_TOKENS = [
  "bg", "surface", "text", "brand", "on_brand", "link", "info", "warning",
  "success", "danger", "text_muted", "text_subtle", "surface_sunken",
  "surface_overlay", "hairline", "hover_faint", "brand_hover",
  "brand_subtle", "brand_subtle_hover", "focus_ring", "progress_start",
  "progress_end", "info_surface", "warning_surface", "success_surface",
  "danger_surface", "danger_surface_hover", "control_bg", "scrim",
  "mega_menu_bg", "mega_menu_scrim",
];

export const ASSET_KINDS = [
  "logo_svg", "favicon_png", "favicon_ico", "pwa_icon_192",
  "pwa_icon_512", "login_bg", "main_bg", "font_sans", "font_mono",
  ...TOOLBAR_ICON_KINDS,
];

const FONT_ASSET_LIMIT = 8388608; // 8 MiB
const OTHER_ASSET_LIMIT = 2097152; // 2 MiB
// A toolbar icon renders at 20px. It gets its own, much smaller limit because
// twelve of them at the image limit would be 24 MiB on their own — approve
// carries every non-passthrough kind's bytes in one JSON body capped at
// ADMIN_APPROVE_BODY_BYTES (25 MB), so that is the "shareable but never
// approvable" failure the font work already had to dig out once.
// Worst case now: 7*2 MiB + 12*256 KiB = 17 MiB, ~23 MB base64.
const TOOLBAR_ICON_ASSET_LIMIT = 262144; // 256 KiB

function assetSizeLimit(kind) {
  if (kind === "font_sans" || kind === "font_mono") return FONT_ASSET_LIMIT;
  if (isToolbarIconKind(kind)) return TOOLBAR_ICON_ASSET_LIMIT;
  return OTHER_ASSET_LIMIT;
}

export const ASSET_SIZE_LIMITS = Object.fromEntries(
  ASSET_KINDS.map((kind) => [kind, assetSizeLimit(kind)])
);

const COLOR_KEYS = COLOR_TOKENS.flatMap((token) => [`light_${token}`, `dark_${token}`]);

const LAYOUT_KEYS = [
  "nav_type",
  "struct_spacing",
  "struct_radius_base",
  "struct_content_width_centered",
  "toolbar_enabled",
];

const NAV_TYPES = ["mega-menu", "dropdown", "sidebar"];
const BOOL01 = ["0", "1"];

// The main-page background's three tunables travel as OPTIONAL layout keys:
// schema stays v1, an older device that never sends them stays valid, and a
// receiver that never reads them falls back to the theme's CSS defaults.
const OPTIONAL_LAYOUT_KEYS = ["struct_main_bg_alpha", "struct_main_bg_blur", "struct_main_bg_scrim"];
const MAIN_BG_BOUNDS = {
  struct_main_bg_alpha: { pattern: /^(\d{1,3})%$/, min: 50, max: 100 },
  struct_main_bg_blur: { pattern: /^(\d{1,3})px$/, min: 0, max: 40 },
  struct_main_bg_scrim: { pattern: /^(\d{1,3})%$/, min: 0, max: 70 },
};

const TYPOGRAPHY_KEYS = ["font_sans", "font_mono", "struct_font_sans", "struct_font_mono"];
const FONT_SANS_TOKENS = ["default", "system", "geist-sans", "nunito", "space-grotesk"];
const FONT_MONO_TOKENS = ["default", "jetbrains-mono", "maple-mono", "fira-code", "cascadia-code"];

const TOOLBAR_MAX_ITEMS = 12;
const TOOLBAR_ITEM_KEYS = new Set(["title", "url", "icon", "enabled"]);
const TOOLBAR_REQUIRED_KEYS = ["title", "url", "enabled"];

// Every kind at once: 6 images + 2 fonts + 12 toolbar icons. Derived rather
// than written out, so adding a kind cannot leave a config able to declare it
// and unable to send it.
const ASSETS_MAX_ITEMS = ASSET_KINDS.length;
const ASSET_ITEM_KEYS = new Set(["kind", "sha256", "size"]);
const ASSET_REQUIRED_KEYS = ["kind", "sha256", "size"];

const TOP_LEVEL_KEYS = new Set([
  "schema", "theme", "colors", "layout", "typography", "toolbar", "assets",
]);

const MAX_PAYLOAD_JSON_LENGTH = 262144; // 256 * 1024

// Global constraint: strip U+0000-U+001F and U+007F before use.
const CONTROL_CHARS_PATTERN = new RegExp("[\u0000-\u001F\u007F]", "g");

const HEX_COLOR_PATTERN = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const REM_PATTERN = /^(\d+(\.\d+)?)rem$/;
const FONT_STACK_PATTERN = /^[A-Za-z0-9 ,"'\-]+$/;
// http(s):// or a relative path — but not a protocol-relative "//host" URL,
// which a browser would resolve against whatever scheme the page is served
// over (effectively attacker-controlled).
const URL_PATTERN = /^(https?:\/\/|\/(?!\/))/;
const ICON_PATTERN = /^[A-Za-z0-9._\-]+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function badSchema(message = "Payload violates the v1 schema.") {
  return new HttpError(400, "bad_schema", message);
}
function unknownField(message = "Unknown field in payload.") {
  return new HttpError(400, "unknown_field", message);
}
function unknownTheme(message = "Unknown theme.") {
  return new HttpError(400, "unknown_theme", message);
}
function badColors(message = "Invalid colors.") {
  return new HttpError(400, "bad_colors", message);
}
function badLayout(message = "Invalid layout.") {
  return new HttpError(400, "bad_layout", message);
}
function badTypography(message = "Invalid typography.") {
  return new HttpError(400, "bad_typography", message);
}
function badToolbar(message = "Invalid toolbar.") {
  return new HttpError(400, "bad_toolbar", message);
}
function badAssets(message = "Invalid assets.") {
  return new HttpError(400, "bad_assets", message);
}
function badMeta(message = "Invalid metadata.") {
  return new HttpError(400, "bad_meta", message);
}

// ---------------------------------------------------------------------------
// Text cleaning (Global Constraints: strip control chars, NFC normalize)
// ---------------------------------------------------------------------------

export function cleanText(value, makeError) {
  if (typeof value !== "string") throw makeError();
  return value.replace(CONTROL_CHARS_PATTERN, "").normalize("NFC");
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(obj, expectedKeys) {
  const keys = Object.keys(obj);
  if (keys.length !== expectedKeys.length) return false;
  return expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(obj, key));
}

function parseRem(value) {
  if (typeof value !== "string") return null;
  const match = REM_PATTERN.exec(value);
  if (!match) return null;
  return Number(match[1]);
}

// ---------------------------------------------------------------------------
// Section validators
// ---------------------------------------------------------------------------

function validateColors(colors) {
  if (!isPlainObject(colors)) throw badColors();
  if (Object.keys(colors).length !== COLOR_KEYS.length) throw badColors();

  const cleaned = {};
  for (const key of COLOR_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(colors, key)) throw badColors();
    const value = colors[key];
    if (typeof value !== "string" || !HEX_COLOR_PATTERN.test(value)) throw badColors();
    cleaned[key] = value.toLowerCase();
  }
  return cleaned;
}

function validateLayout(layout) {
  if (!isPlainObject(layout)) throw badLayout();
  for (const key of Object.keys(layout)) {
    if (!LAYOUT_KEYS.includes(key) && !OPTIONAL_LAYOUT_KEYS.includes(key)) throw badLayout();
  }
  for (const key of LAYOUT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(layout, key)) throw badLayout();
  }

  const { nav_type, struct_spacing, struct_radius_base, struct_content_width_centered, toolbar_enabled } = layout;

  if (!NAV_TYPES.includes(nav_type)) throw badLayout();

  const spacing = parseRem(struct_spacing);
  if (spacing === null || spacing < 0.05 || spacing > 1) throw badLayout();

  const radius = parseRem(struct_radius_base);
  if (radius === null || radius < 0 || radius > 2) throw badLayout();

  const width = parseRem(struct_content_width_centered);
  if (width === null || width < 40 || width > 160) throw badLayout();

  if (!BOOL01.includes(toolbar_enabled)) throw badLayout();

  const cleaned = { nav_type, struct_spacing, struct_radius_base, struct_content_width_centered, toolbar_enabled };

  for (const key of OPTIONAL_LAYOUT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(layout, key)) continue;
    const value = layout[key];
    if (typeof value !== "string") throw badLayout();
    const { pattern, min, max } = MAIN_BG_BOUNDS[key];
    const match = pattern.exec(value);
    if (!match) throw badLayout();
    const n = Number(match[1]);
    if (n < min || n > max) throw badLayout();
    cleaned[key] = value;
  }

  return cleaned;
}

function validateTypography(typography) {
  if (!isPlainObject(typography)) throw badTypography();
  if (!hasExactKeys(typography, TYPOGRAPHY_KEYS)) throw badTypography();

  const { font_sans, font_mono, struct_font_sans, struct_font_mono } = typography;

  if (!FONT_SANS_TOKENS.includes(font_sans)) throw badTypography();
  if (!FONT_MONO_TOKENS.includes(font_mono)) throw badTypography();

  const cleanedSans = cleanText(struct_font_sans, badTypography);
  if (cleanedSans.length > 200 || !FONT_STACK_PATTERN.test(cleanedSans)) throw badTypography();

  const cleanedMono = cleanText(struct_font_mono, badTypography);
  if (cleanedMono.length > 200 || !FONT_STACK_PATTERN.test(cleanedMono)) throw badTypography();

  return {
    font_sans,
    font_mono,
    struct_font_sans: cleanedSans,
    struct_font_mono: cleanedMono,
  };
}

function validateToolbarItem(item) {
  if (!isPlainObject(item)) throw badToolbar();
  for (const key of Object.keys(item)) {
    if (!TOOLBAR_ITEM_KEYS.has(key)) throw badToolbar();
  }
  for (const key of TOOLBAR_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(item, key)) throw badToolbar();
  }

  const title = cleanText(item.title, badToolbar);
  if (title.length < 1 || title.length > 30) throw badToolbar();

  const url = cleanText(item.url, badToolbar);
  if (url.length > 200 || !URL_PATTERN.test(url)) throw badToolbar();

  if (!BOOL01.includes(item.enabled)) throw badToolbar();

  const cleaned = { title, url, enabled: item.enabled };

  if (Object.prototype.hasOwnProperty.call(item, "icon")) {
    const icon = cleanText(item.icon, badToolbar);
    if (icon.length > 64 || !ICON_PATTERN.test(icon)) throw badToolbar();
    cleaned.icon = icon;
  }

  return cleaned;
}

function validateToolbar(toolbar) {
  if (!Array.isArray(toolbar)) throw badToolbar();
  if (toolbar.length > TOOLBAR_MAX_ITEMS) throw badToolbar();
  return toolbar.map(validateToolbarItem);
}

function validateAssetItem(item, seenKinds) {
  if (!isPlainObject(item)) throw badAssets();
  for (const key of Object.keys(item)) {
    if (!ASSET_ITEM_KEYS.has(key)) throw badAssets();
  }
  for (const key of ASSET_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(item, key)) throw badAssets();
  }

  const { kind, sha256, size } = item;

  if (!ASSET_KINDS.includes(kind)) throw badAssets();
  if (seenKinds.has(kind)) throw badAssets();
  seenKinds.add(kind);

  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) throw badAssets();

  if (!Number.isInteger(size) || size <= 0 || size > ASSET_SIZE_LIMITS[kind]) {
    throw badAssets();
  }

  return { kind, sha256, size };
}

function validateAssets(assets) {
  if (!Array.isArray(assets)) throw badAssets();
  if (assets.length > ASSETS_MAX_ITEMS) throw badAssets();
  const seen = new Set();
  return assets.map((item) => validateAssetItem(item, seen));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function validatePayload(payload) {
  // A non-object payload is rejected on its own terms — before we even try
  // to size it — so the error message matches the actual reason instead of
  // misreporting an oversized-payload error for e.g. `undefined`.
  if (!isPlainObject(payload)) {
    throw badSchema("Payload must be an object.");
  }

  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw badSchema("Payload is not JSON-serializable.");
  }

  // Size pre-check, before any deep walk.
  if (typeof serialized !== "string" || serialized.length > MAX_PAYLOAD_JSON_LENGTH) {
    throw badSchema("Payload exceeds the maximum size.");
  }

  for (const key of Object.keys(payload)) {
    if (!TOP_LEVEL_KEYS.has(key)) throw unknownField(`Unknown field: ${key}`);
  }

  if (payload.schema !== 1) throw badSchema("schema must be 1.");
  if (payload.theme !== "aurora") throw unknownTheme("theme must be aurora.");

  const colors = validateColors(payload.colors);
  const layout = validateLayout(payload.layout);
  const typography = validateTypography(payload.typography);
  // `toolbar`/`assets` default to [] only when the key is truly absent.
  // An explicit `null` (or any other non-array value) must still fail the
  // section's own array check — it must not be silently coalesced away.
  const toolbar = validateToolbar(sectionOrEmpty(payload, "toolbar"));
  const assets = validateAssets(sectionOrEmpty(payload, "assets"));

  return { schema: 1, theme: "aurora", colors, layout, typography, toolbar, assets };
}

function sectionOrEmpty(payload, key) {
  return Object.prototype.hasOwnProperty.call(payload, key) ? payload[key] : [];
}

// Signing is an account property, resolved by JOIN at read time -- it is not
// a publish parameter, so no author is accepted here. An older client that
// still sends one is not an error: unknown keys are simply not read.
export function validateMeta({ name, description } = {}) {
  if (typeof name !== "string") throw badMeta("name is required.");
  const cleanedName = cleanText(name, badMeta);
  if (cleanedName.length < 1 || cleanedName.length > 60) throw badMeta("name must be 1-60 characters.");

  const rawDescription = description ?? "";
  if (typeof rawDescription !== "string") throw badMeta("description must be a string.");
  const cleanedDescription = cleanText(rawDescription, badMeta);
  if (cleanedDescription.length > 500) throw badMeta("description must be at most 500 characters.");

  return { name: cleanedName, description: cleanedDescription };
}

export const NICKNAME_MAX = 40;

// The trim is load-bearing: cleanText only strips control characters and
// NFC-normalizes, so without it "Eamon " and "Eamon" fold to different
// nickname_lc values and both could be claimed past idx_devices_nick.
export function validateNickname(value) {
  const badNickname = () =>
    new HttpError(400, "invalid_nickname", `nickname must be 1-${NICKNAME_MAX} characters.`);

  if (typeof value !== "string") throw badNickname();
  const nickname = cleanText(value, badNickname).trim();
  if (nickname.length < 1 || nickname.length > NICKNAME_MAX) throw badNickname();

  return { nickname, nickname_lc: nickname.toLowerCase() };
}
