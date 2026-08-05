// 无状态上传票据：路由器持 device_token 建草稿时签发，浏览器凭它 PUT 字节。
//
// 存在的理由是 OpenWrt 的 uclient-fetch 走 TLS 推不动大 body —— 实测同一台
// 路由器，512KB 三次里挂一次、1MB 必断，而同机 curl 传 1.6MB 只要 3.4 秒：
// 是它的 TLS 写路径在缓冲填满后不再续写。把字节交给浏览器发就没有这个问题，
// 但浏览器不能拿 device_token：那是创作者身份本身，谁拿到谁能以你的名义发布
// 和删除你所有作品。票据是它的替代品，权限窄到只剩"把这一份字节传到这一个
// 位置"。
//
// 不落库。票据把 (draft_id, kind, size, sha256) 全钉死，重放同一张票只能传出
// 同样的字节，所以"单次使用"没有价值 —— 也就不需要一张表和它的 GC。
import { HttpError, timingSafeEqual } from "./auth.js";

export const TICKET_TTL_SECONDS = 1800;

function b64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64url(new Uint8Array(sig));
}

// 每一种失败都回同一句话:签名不对、过期、结构不对、根本不是票据 —— 分开说
// 只会告诉攻击者他猜到了哪一步。
function badTicket() {
  return new HttpError(403, "bad_ticket", "Upload ticket is missing, invalid, or expired.");
}

export async function signTicket(secret, claims) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  return body + "." + (await hmac(secret, body));
}

export async function verifyTicket(secret, token) {
  if (typeof token !== "string") throw badTicket();
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw badTicket();

  // 先验签再解析:一个签名对不上的 payload 不值得被 JSON.parse 看一眼。
  const expected = await hmac(secret, parts[0]);
  if (!timingSafeEqual(parts[1], expected)) throw badTicket();

  let claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(unb64url(parts[0])));
  } catch {
    throw badTicket();
  }

  if (
    typeof claims !== "object" || claims === null ||
    typeof claims.draft_id !== "string" ||
    typeof claims.kind !== "string" ||
    !Number.isInteger(claims.size) ||
    typeof claims.sha256 !== "string" ||
    !Number.isInteger(claims.exp)
  ) {
    throw badTicket();
  }

  if (claims.exp <= Math.floor(Date.now() / 1000)) throw badTicket();

  return claims;
}
