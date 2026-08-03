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

export function requireAdmin(request, env) {
  const header = request.headers.get("Authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
    throw new HttpError(401, "unauthorized", "Missing or invalid admin token.");
  }
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
