// Keeps site/admin/index.html's inlined copy of sanitizeSvg byte-identical to
// src/sanitize-svg.js. admin.html has no build step (Global Constraint:
// self-contained, zero external references), so it can't `import` the
// module — instead this script mechanically copies the module's source
// (minus the `export ` keyword, which has no meaning outside an ES module)
// into the block delimited by the SANITIZE_SVG_INLINE_START/END markers in
// admin.html's inline <script>.
//
// Run after any change to src/sanitize-svg.js:
//   node scripts/sync-sanitize-svg.mjs
//
// Verify without writing (used by the fix-round / CI-style check):
//   node scripts/sync-sanitize-svg.mjs --check

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const hubRoot = path.resolve(here, "..");
const sourcePath = path.join(hubRoot, "src", "sanitize-svg.js");
const htmlPath = path.join(hubRoot, "site", "admin", "index.html");

const START_MARKER = "/* SANITIZE_SVG_INLINE_START */";
const END_MARKER = "/* SANITIZE_SVG_INLINE_END */";

const moduleSource = readFileSync(sourcePath, "utf8");
// The only ES-module-only syntax in this file is the single `export `
// keyword in front of `function sanitizeSvg`. Stripping it is the sole
// transformation applied — everything else stays byte-identical.
const inlineSource = moduleSource.replace("export function sanitizeSvg", "function sanitizeSvg");
if (inlineSource === moduleSource) {
  throw new Error("sync-sanitize-svg: expected exactly one `export function sanitizeSvg` to replace.");
}

const html = readFileSync(htmlPath, "utf8");
const startIdx = html.indexOf(START_MARKER);
const endIdx = html.indexOf(END_MARKER);
if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  throw new Error("sync-sanitize-svg: could not find both markers in site/admin/index.html.");
}

const before = html.slice(0, startIdx + START_MARKER.length);
const after = html.slice(endIdx);
const newHtml = before + "\n" + inlineSource + "\n" + after;

const checkOnly = process.argv.includes("--check");
if (checkOnly) {
  if (newHtml !== html) {
    console.error("site/admin/index.html's inlined sanitizeSvg is OUT OF SYNC with src/sanitize-svg.js.");
    console.error("Run `node scripts/sync-sanitize-svg.mjs` to fix.");
    process.exit(1);
  }
  console.log("site/admin/index.html's inlined sanitizeSvg matches src/sanitize-svg.js.");
  process.exit(0);
}

writeFileSync(htmlPath, newHtml);
console.log("Synced src/sanitize-svg.js into site/admin/index.html.");
