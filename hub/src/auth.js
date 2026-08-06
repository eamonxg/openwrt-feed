import { shortId, sha256Hex } from "./ids.js";

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const QUOTA_LIMIT = 10;

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

// actor 名会原样进 admin_actions.actor,所以限制成一个朴素标识符:日志里
// 不该出现引号、逗号、空格这类会让人读不清「到底是谁」的东西。
const ACTOR_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// ADMIN_TOKENS 的格式是 `name:token` 逗号分隔。token 自身允许含冒号
// (只按第一个冒号切),名字不合法或没有分隔符的条目跳过并 warn —— 一条写
// 坏的记录不应该让另外几个管理员一起进不来。
function parseAdminTokens(raw) {
  const parsed = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const sep = trimmed.indexOf(":");
    const actor = sep > 0 ? trimmed.slice(0, sep) : "";
    const token = sep > 0 ? trimmed.slice(sep + 1) : "";
    if (!ACTOR_PATTERN.test(actor) || !token) {
      console.warn("ADMIN_TOKENS: skipping a malformed entry (expected `name:token`).");
      continue;
    }

    parsed.push({ actor, token });
  }
  return parsed;
}

// 返回匹配到的 actor 名,供调用方写进 admin_actions。
//
// ADMIN_TOKEN 这个既有 secret 语义不变,只是从此对应 actor "root"。第二个
// 审核员到位时加一条 ADMIN_TOKENS secret 即可,不必上线用户表。
export function requireAdmin(request, env) {
  const candidates = [];
  if (env.ADMIN_TOKEN) candidates.push({ actor: "root", token: env.ADMIN_TOKEN });
  if (env.ADMIN_TOKENS) candidates.push(...parseAdminTokens(env.ADMIN_TOKENS));

  // 一个都没配就 500 —— 空的期望值绝不能落到 timingSafeEqual 里,那会让
  // 空 Bearer token 比出「相等」。失败要失败在关门的一侧。
  if (candidates.length === 0) {
    throw new HttpError(500, "admin_disabled", "Admin token is not configured.");
  }

  const header = request.headers.get("Authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    throw new HttpError(401, "unauthorized", "Missing or invalid admin token.");
  }

  // 命中之后不提前 break:比较次数与哪一个匹配无关。
  let matched = null;
  for (const candidate of candidates) {
    if (timingSafeEqual(token, candidate.token)) matched = candidate.actor;
  }
  if (matched === null) {
    throw new HttpError(401, "unauthorized", "Missing or invalid admin token.");
  }

  return matched;
}

export async function deviceFromToken(db, token, { register }) {
  if (!TOKEN_PATTERN.test(token)) {
    throw new HttpError(400, "bad_token", "Device token is malformed.");
  }

  const hash = await sha256Hex(token);
  const existing = await db
    .prepare("SELECT * FROM devices WHERE secret_hash = ?")
    .bind(hash)
    .first();

  if (existing) return existing;
  if (!register) return null;

  const id = shortId();
  await db
    .prepare("INSERT INTO devices (id, secret_hash) VALUES (?, ?)")
    .bind(id, hash)
    .run();

  return db.prepare("SELECT * FROM devices WHERE id = ?").bind(id).first();
}

export async function bumpQuota(db, device, todayUtc) {
  let used = device.quota_used;
  if (device.quota_day !== todayUtc) {
    used = 0;
  }

  if (used >= QUOTA_LIMIT) {
    return false;
  }

  used += 1;
  await db
    .prepare("UPDATE devices SET quota_day = ?, quota_used = ? WHERE id = ?")
    .bind(todayUtc, used, device.id)
    .run();

  return true;
}
