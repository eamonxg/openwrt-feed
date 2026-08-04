// Cold-start seed: publish the 5 Aurora built-in palettes as community configs.
// Idempotent: hub dedups by theme+content_hash, so re-running returns existing ids.
// Usage: node seed-presets.mjs [--dry]
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

// Templates dir: arg 1, or $AURORA_APP, or the sibling luci-app-aurora-config checkout.
const APP = process.argv.find((a, i) => i >= 2 && !a.startsWith("--"))
  || process.env.AURORA_APP
  || new URL("../../../luci-app-aurora-config/root/usr/share/aurora", import.meta.url).pathname;
const HUB = "https://themes.eamonxg.fun";
const DRY = process.argv.includes("--dry");
const TOKEN_FILE = new URL((process.env.SEED_TOKEN_FILE ? new URL("file://" + process.env.SEED_TOKEN_FILE) : "./seed-device-token.txt"), import.meta.url);

const PRESETS = [
  { id: "default",    name: "Default",    zh: "默认" },
  { id: "monochrome", name: "Monochrome", zh: "单色" },
  { id: "sage-green", name: "Sage Green", zh: "鼠尾草绿" },
  { id: "amber-sand", name: "Amber Sand", zh: "琥珀沙" },
  { id: "sky-blue",   name: "Sky Blue",   zh: "天蓝" },
];

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const TOKENS = readFileSync(`${APP}/color-tokens.conf`, "utf8")
  .split("\n").map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
if (TOKENS.length !== 31) throw new Error(`expected 31 tokens, got ${TOKENS.length}`);

// Parse `option key 'value'` / `option key value` lines from a template's theme section.
function parseTheme(file) {
  const out = {};
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const m = raw.trim().match(/^option\s+(\S+)\s+'([^']*)'|^option\s+(\S+)\s+(\S+)/);
    if (!m) continue;
    if (m[1] !== undefined) out[m[1]] = m[2];
    else out[m[3]] = m[4];
  }
  return out;
}

// Common non-color parts come from default.template (all 5 presets are colour-only snapshots).
const def = parseTheme(`${APP}/default.template`);
const layout = {
  nav_type: def.nav_type,
  struct_spacing: def.struct_spacing,
  struct_radius_base: def.struct_radius_base,
  struct_content_width_centered: def.struct_content_width_centered,
  toolbar_enabled: def.toolbar_enabled,
};
const typography = {
  font_sans: "default",
  font_mono: "default",
  struct_font_sans: def.struct_font_sans,
  struct_font_mono: def.struct_font_mono,
};
// Default toolbar items (parse the config toolbar_item blocks from default.template).
const toolbar = [];
{
  let cur = null;
  for (const raw of readFileSync(`${APP}/default.template`, "utf8").split("\n")) {
    const t = raw.trim();
    if (t === "config toolbar_item") { cur = {}; toolbar.push(cur); continue; }
    if (t.startsWith("config ")) { cur = null; continue; }
    if (!cur) continue;
    const m = t.match(/^option\s+(\S+)\s+'([^']*)'|^option\s+(\S+)\s+(\S+)/);
    if (!m) continue;
    const k = m[1] ?? m[3], v = m[2] ?? m[4];
    if (["title", "url", "icon", "enabled"].includes(k)) cur[k] = v;
  }
}

function buildPayload(id) {
  const t = parseTheme(`${APP}/${id}.template`);
  const colors = {};
  for (const tok of TOKENS) {
    for (const mode of ["light", "dark"]) {
      const key = `${mode}_${tok}`;
      const v = t[key];
      if (!v || !HEX.test(v)) throw new Error(`${id}: bad/missing color ${key}=${v}`);
      colors[key] = v.toLowerCase();
    }
  }
  if (Object.keys(colors).length !== 62) throw new Error(`${id}: expected 62 colors`);
  return { schema: 1, theme: "aurora", colors, layout, typography, toolbar, assets: [] };
}

let token;
if (existsSync(TOKEN_FILE)) token = readFileSync(TOKEN_FILE, "utf8").trim();
else { token = randomBytes(32).toString("hex"); writeFileSync(TOKEN_FILE, token + "\n"); }

// Signing is an account property, not a publish parameter: claim the name on
// the seed device's profile once and every preset below is signed with it.
// This is not cosmetic -- the store marks a config as an official built-in by
// checking author === "Aurora" (gallery.js), and nicknames are first-come, so
// this has to succeed before anyone else can take the name.
if (!DRY) {
  const meRes = await fetch(`${HUB}/api/v1/me`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_token: token, nickname: "Aurora" }),
  });
  const me = await meRes.json().catch(() => ({}));
  if (me.error) throw new Error(`could not claim the "Aurora" nickname: ${me.error}`);
  console.log(`seed profile: ${me.nickname} · #${me.id}`);
}

const results = [];
for (const p of PRESETS) {
  const payload = buildPayload(p.id);
  const body = {
    device_token: token,
    name: `${p.name} · ${p.zh}`,
    description: `Aurora built-in ${p.name} palette · Aurora 内置${p.zh}调色板`,
    payload,
    assets: [],
  };
  if (DRY) {
    console.log(`[dry] ${body.name}: 62 colors ok, ${toolbar.length} toolbar items, payload bytes=${JSON.stringify(payload).length}`);
    results.push({ id: p.id, dry: true });
    continue;
  }
  const r = await fetch(`${HUB}/api/v1/themes/aurora/configs`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  console.log(`${body.name}: HTTP ${r.status} ${JSON.stringify(j)}`);
  results.push({ preset: p.id, status: r.status, ...j });
}
if (!DRY) {
  console.log("\nseed device token saved at:", TOKEN_FILE.pathname);
  const list = await (await fetch(`${HUB}/api/v1/themes/aurora/configs?sort=new`)).json();
  console.log("gallery now has", list.items?.length ?? "?", "configs:", (list.items || []).map((i) => i.name).join(" | "));
}
