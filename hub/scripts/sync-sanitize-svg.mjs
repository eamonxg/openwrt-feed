// 让 site/admin/sanitize-svg.js 与 src/sanitize-svg.js 保持逐字节相同。
//
// 管理页现在是 ES module,`export function sanitizeSvg` 在浏览器里本来就
// 合法,所以这里只是一次文件复制 —— 曾经的 marker 查找 + 剥 export +
// 往 HTML 里注入源码块,随着单文件约束一起没了。
//
// 改完 src/sanitize-svg.js 后运行:
//   node scripts/sync-sanitize-svg.mjs
//
// 只检查不写入(CI 用):
//   node scripts/sync-sanitize-svg.mjs --check

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const hubRoot = path.resolve(here, "..");
const sourcePath = path.join(hubRoot, "src", "sanitize-svg.js");
const copyPath = path.join(hubRoot, "site", "admin", "sanitize-svg.js");

const source = readFileSync(sourcePath, "utf8");

if (process.argv.includes("--check")) {
  const existing = readFileSync(copyPath, "utf8");
  if (existing !== source) {
    console.error("site/admin/sanitize-svg.js is OUT OF SYNC with src/sanitize-svg.js.");
    console.error("Run `node scripts/sync-sanitize-svg.mjs` to fix.");
    process.exit(1);
  }
  console.log("site/admin/sanitize-svg.js matches src/sanitize-svg.js.");
  process.exit(0);
}

writeFileSync(copyPath, source);
console.log("Synced src/sanitize-svg.js into site/admin/sanitize-svg.js.");
