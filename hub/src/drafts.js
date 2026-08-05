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

// ---------------------------------------------------------------------------
// ② PUT /api/v1/drafts/:draft_id/assets/:kind — 浏览器直传的收字节端点
// ---------------------------------------------------------------------------

// 整条链路上唯一不认 device_token 的地方。票据把 (draft_id, kind, size,
// sha256) 全钉死，所以即使它泄漏，攻击者能做的也只是把同一份字节再传一遍。
async function putDraftAsset(request, env, draftId, kind) {
  const secret = requireSecret(env);

  const header = request.headers.get("Authorization") ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    throw new HttpError(403, "bad_ticket", "Upload ticket is missing, invalid, or expired.");
  }
  const claims = await verifyTicket(secret, token);

  // 票据是对着某一份草稿的某一个槽签的。路径与它对不上就当没有票据 ——
  // 否则一张 favicon 的票据能往 logo 槽里塞任意字节。
  if (claims.draft_id !== draftId || claims.kind !== kind) {
    throw new HttpError(403, "bad_ticket", "Upload ticket is missing, invalid, or expired.");
  }

  const limit = ASSET_SIZE_LIMITS[kind];
  if (!limit) {
    throw new HttpError(400, "bad_asset", "Unknown asset kind.");
  }

  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) !== claims.size) {
    throw new HttpError(400, "asset_mismatch", `Size mismatch for ${kind}.`);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength !== claims.size) {
    throw new HttpError(400, "asset_mismatch", `Size mismatch for ${kind}.`);
  }
  if (bytes.byteLength > limit) {
    throw new HttpError(413, "too_large", `Asset ${kind} exceeds the maximum size.`);
  }

  const hash = await sha256Hex(bytes);
  if (hash !== claims.sha256) {
    throw new HttpError(400, "asset_mismatch", `Hash mismatch for ${kind}.`);
  }

  const check = MAGIC_CHECKS[kind];
  if (!check(bytes)) {
    throw new HttpError(400, "bad_asset", `Asset ${kind} failed the magic-byte check.`);
  }

  // sha256 记进 customMetadata：提交时据此确认这份字节确实是 manifest 声明的
  // 那一份，不必把 1.2MB 读回内存重算一遍。
  const customMetadata = { sha256: hash };
  if (kind === "login_bg") customMetadata.format = sniffLoginBgFormat(bytes);

  await env.R2.put(r2Key("draft", draftId, kind), bytes, { customMetadata });

  return jsonResponse({ kind, received: bytes.byteLength });
}

export const handleDraftAssetPut = wrap((request, env, params) =>
  putDraftAsset(request, env, params.draft_id, params.kind)
);

// ---------------------------------------------------------------------------
// ③ POST /api/v1/drafts/:draft_id/commit
// ---------------------------------------------------------------------------

// 草稿里的字节搬到最终位置。R2 的 get -> put 走的是 body 流，1.2MB 的图不会
// 被整个读进内存；sha256 在 PUT 时已经验过并记在 customMetadata 里，commit
// 只核对那份记录，不重算。
function draftSource(draftId, kind, format) {
  return {
    kind,
    format,
    async writeTo(env, key) {
      const object = await env.R2.get(r2Key("draft", draftId, kind));
      if (!object) {
        throw new HttpError(409, "assets_incomplete", `Asset ${kind} was never uploaded.`);
      }
      const options = {};
      if (kind === "login_bg") options.customMetadata = { format };
      await env.R2.put(key, object.body, options);
    },
  };
}

async function commitDraft(request, env, draftId) {
  const body = await parseJsonBody(request, DRAFT_BODY_MAX_BYTES);

  const draft = await env.DB
    .prepare("SELECT * FROM drafts WHERE id = ?")
    .bind(draftId)
    .first();
  if (!draft) {
    throw new HttpError(404, "not_found", "Draft not found.");
  }

  const device = await deviceFromToken(env.DB, body.device_token, { register: false });
  if (!device) {
    throw new HttpError(403, "not_owner", "Device is not the owner of this draft.");
  }
  if (device.banned) {
    throw new HttpError(403, "device_banned", "This device has been banned.");
  }
  if (draft.device_id !== device.id) {
    throw new HttpError(403, "not_owner", "Device is not the owner of this draft.");
  }

  const payload = JSON.parse(draft.payload);
  const meta = { name: draft.name, description: draft.description };

  // 每个 manifest 资产都必须已经躺在 draft/ 下，且 hash/size 与 manifest 一致。
  // 缺一个就整单拒绝 —— 半套资产的配置发出去，别人套用时会拿到一张缺图。
  const sources = [];
  for (const item of payload.assets) {
    const object = await env.R2.head(r2Key("draft", draftId, item.kind));
    if (!object) {
      throw new HttpError(409, "assets_incomplete", `Asset ${item.kind} was never uploaded.`);
    }
    if (object.customMetadata?.sha256 !== item.sha256 || object.size !== item.size) {
      throw new HttpError(
        400,
        "asset_mismatch",
        `Stored bytes do not match the manifest for ${item.kind}.`
      );
    }
    sources.push(draftSource(draftId, item.kind, object.customMetadata?.format));
  }

  let response;
  if (draft.target_id) {
    // 建草稿时验过一次权，但那已经是最多半小时前的事：这条分享可能已经被删、
    // 或者身份已经换过。落库前再验一次。
    const row = await env.DB
      .prepare("SELECT * FROM configs WHERE theme = ? AND id = ? AND status = 'active'")
      .bind(draft.theme, draft.target_id)
      .first();
    if (!row) {
      throw new HttpError(404, "not_found", "Config not found.");
    }
    if (row.device_id !== device.id) {
      throw new HttpError(403, "not_owner", "Device is not the owner of this config.");
    }
    response = await updateConfigWithAssets(env, { theme: draft.theme, row, meta, payload, sources });
  } else {
    response = await insertConfigWithAssets(env, {
      theme: draft.theme,
      device,
      meta,
      payload,
      sources,
    });
  }

  // 草稿收尾：先删行（再次提交拿 404），再删字节。反过来的话，一次失败的删除
  // 会留下一条指向空字节的草稿，第二次提交报的是 assets_incomplete，比 404
  // 难懂得多。
  await env.DB.prepare("DELETE FROM drafts WHERE id = ?").bind(draftId).run();
  for (const item of payload.assets) {
    await env.R2.delete(r2Key("draft", draftId, item.kind));
  }

  return response;
}

export const handleDraftCommit = wrap((request, env, params) =>
  commitDraft(request, env, params.draft_id)
);
