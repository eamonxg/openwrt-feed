// 三段式发布：建草稿（路由器）-> 直传字节（浏览器）-> 提交（路由器）。
//
// 存在的理由是 OpenWrt 的 uclient-fetch 走 TLS 推不动大 body：实测同一台
// 路由器，512KB 三次里挂一次、1MB 必断（"Connection reset prematurely"），
// 而同机 curl 传同一个 1.6MB body 只要 3.4 秒 —— 是它的 TLS 写路径在缓冲
// 填满后不再续写。单请求发布把整张登录背景 base64 塞进一个 JSON，一张
// 1.2MB 的图就让 body 到 1.6MB，于是任何设了登录背景的人都发布不出去。
//
// 把路由器从上传路径里拿掉，这个约束就消失了：浏览器一次 PUT 就完事，不需要
// 分片。device_token 因此不下发 —— 浏览器拿到的是 tickets.js 签的一张票据，
// 权限窄到只剩"把这一份字节传到这一个位置"。
import { HttpError, deviceFromToken, bumpQuota } from "./auth.js";
import { shortId, canonicalJson, contentHash, sha256Hex } from "./ids.js";
import { validateMeta, validatePayload, ASSET_SIZE_LIMITS } from "./validate.js";
import { MAGIC_CHECKS, r2Key, sniffLoginBgFormat } from "./assets.js";
import { jsonResponse, errorResponse, readJsonBounded } from "./http.js";
import { signTicket, verifyTicket, TICKET_TTL_SECONDS } from "./tickets.js";
import { insertConfigWithAssets, updateConfigWithAssets } from "./configs.js";

// 草稿请求只带 payload + 元信息，而 payload 本身已被 validate.js 限到 256KB。
// 所以这里的上限比 share 的 12MB 小两个数量级 —— 正是路由器发得动的量级。
const DRAFT_BODY_MAX_BYTES = 512 * 1024;

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

async function parseJsonBody(request, maxBytes) {
  const body = await readJsonBounded(request, maxBytes);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "bad_json", "Request body must be a JSON object.");
  }
  return body;
}

// 照 auth.js:requireAdmin 对 ADMIN_TOKEN 的posture：没配密钥就整条直传链路
// fail closed，而不是签出一堆谁都能伪造的票据。既有的单请求发布不受影响。
function requireSecret(env) {
  if (!env.TICKET_SECRET) {
    throw new HttpError(500, "upload_disabled", "Upload tickets are not configured.");
  }
  return env.TICKET_SECRET;
}

function wrap(fn) {
  return async (request, env, params) => {
    try {
      return await fn(request, env, params);
    } catch (err) {
      if (err instanceof HttpError) {
        return errorResponse(err.status, err.code, err.message);
      }
      console.error(err);
      return errorResponse(500, "internal_error", "Something went wrong.");
    }
  };
}

// ---------------------------------------------------------------------------
// ① POST /api/v1/themes/:theme/configs/draft
// ---------------------------------------------------------------------------

async function createDraft(request, env, theme) {
  const secret = requireSecret(env);
  const body = await parseJsonBody(request, DRAFT_BODY_MAX_BYTES);

  const device = await deviceFromToken(env.DB, body.device_token, { register: true });
  if (device.banned) {
    throw new HttpError(403, "device_banned", "This device has been banned.");
  }

  const meta = validateMeta({ name: body.name, description: body.description });
  const payload = validatePayload(body.payload);

  // 更新目标现在就验权：让浏览器传完 1.2MB 才发现无权覆盖是最差的顺序。
  let targetId = null;
  if (body.target_id !== undefined && body.target_id !== null) {
    if (typeof body.target_id !== "string" || !/^[A-Za-z0-9]{1,32}$/.test(body.target_id)) {
      throw new HttpError(400, "invalid_id", "target_id is malformed.");
    }
    const row = await env.DB
      .prepare("SELECT device_id FROM configs WHERE theme = ? AND id = ? AND status = 'active'")
      .bind(theme, body.target_id)
      .first();
    if (!row) throw new HttpError(404, "not_found", "Config not found.");
    if (row.device_id !== device.id) {
      throw new HttpError(403, "not_owner", "Device is not the owner of this config.");
    }
    targetId = body.target_id;
  }

  // 配额照 share 的老规矩在"尝试"时就扣（share 也是先扣再校验 payload）；
  // 更新不扣，与 updateConfig 一致。
  if (targetId === null) {
    const allowed = await bumpQuota(env.DB, device, todayUtc());
    if (!allowed) {
      throw new HttpError(429, "quota_exceeded", "Daily share quota exceeded.");
    }
  }

  // 内容去重前置：命中就不必让浏览器白传一趟 1.2MB。
  const hash = await contentHash(payload);
  if (targetId === null) {
    const existing = await env.DB
      .prepare("SELECT id FROM configs WHERE theme = ? AND content_hash = ? AND status = 'active'")
      .bind(theme, hash)
      .first();
    if (existing) {
      return jsonResponse({ id: existing.id, duplicate: true });
    }
  }

  const draftId = shortId();
  await env.DB
    .prepare(
      `INSERT INTO drafts (id, theme, device_id, target_id, name, description, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(draftId, theme, device.id, targetId, meta.name, meta.description, canonicalJson(payload))
    .run();

  const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
  const assets = [];
  for (const item of payload.assets) {
    assets.push({
      kind: item.kind,
      sha256: item.sha256,
      size: item.size,
      url: `/api/v1/drafts/${draftId}/assets/${item.kind}`,
      ticket: await signTicket(secret, {
        draft_id: draftId,
        kind: item.kind,
        size: item.size,
        sha256: item.sha256,
        exp,
      }),
    });
  }

  return jsonResponse({ draft_id: draftId, expires_in: TICKET_TTL_SECONDS, assets });
}

export const handleCreateDraft = wrap((request, env, params) =>
  createDraft(request, env, params.theme)
);
