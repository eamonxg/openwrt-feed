import { COLOR_TOKENS } from "../src/validate.js";
import { sha256Hex } from "../src/ids.js";

// A minimal valid 1x1 transparent PNG (68 bytes: signature + IHDR + IDAT +
// IEND), used to exercise the magic-byte and hash/size reconciliation paths
// without shipping a real binary fixture.
export const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export function makeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Builds a body-level {kind, data_b64} entry together with the matching
// payload.assets manifest entry {kind, sha256, size} — callers never have to
// hand-compute a hash to keep the two in sync.
export async function makeAsset(kind, base64 = PNG_1X1_BASE64) {
  const bytes = base64ToBytes(base64);
  const sha256 = await sha256Hex(bytes);
  return {
    manifest: { kind, sha256, size: bytes.byteLength },
    body: { kind, data_b64: base64 },
  };
}

function buildColors(overrides = {}) {
  const colors = {};
  for (const token of COLOR_TOKENS) {
    colors[`light_${token}`] = "#1a2b3c";
    colors[`dark_${token}`] = "#4d5e6f";
  }
  return { ...colors, ...overrides };
}

function buildLayout(overrides = {}) {
  return {
    nav_type: "mega-menu",
    struct_spacing: "0.25rem",
    struct_radius_base: "0.5rem",
    struct_content_width_centered: "80rem",
    toolbar_enabled: "1",
    ...overrides,
  };
}

function buildTypography(overrides = {}) {
  return {
    font_sans: "system",
    font_mono: "jetbrains-mono",
    struct_font_sans: "Inter, sans-serif",
    struct_font_mono: "'Fira Code', monospace",
    ...overrides,
  };
}

// A minimal valid schema-v1 aurora payload. Pass partial overrides for
// colors/layout/typography to mint distinct content hashes across calls
// (e.g. for quota exhaustion tests); toolbar/assets replace wholesale.
export function makePayload(overrides = {}) {
  return {
    schema: 1,
    theme: "aurora",
    colors: buildColors(overrides.colors),
    layout: buildLayout(overrides.layout),
    typography: buildTypography(overrides.typography),
    toolbar: overrides.toolbar ?? [],
    assets: overrides.assets ?? [],
  };
}
