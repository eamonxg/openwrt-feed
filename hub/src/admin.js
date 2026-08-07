// Handlers for /api/v1/admin/* (API contract #9-#15) — every endpoint here
// sits behind requireAdmin (Bearer vs env.ADMIN_TOKEN, see auth.js). This is
// the only place raw, unsanitized asset bytes are ever exposed (#10) or
// where the approve/reject/takedown/ban moderation actions happen.

import { HttpError, requireAdmin } from "./auth.js";
import { logAction } from "./admin-audit.js";
import { sha256Hex } from "./ids.js";
import { jsonResponse, errorResponse, readJsonBounded, readOptionalReason } from "./http.js";
import {
  MAGIC_CHECKS,
  r2Key,
  contentTypeFor,
  isFormatTrackedKind,
  sniffFormat,
  APPROVE_FROM_R2_KINDS,
} from "./assets.js";
import { ASSET_SIZE_LIMITS } from "./validate.js";
import { softTakedown } from "./lifecycle.js";

// Approve bodies carry base64 sanitized assets: all kinds together can
// exceed the general 12 MB request cap once base64 overhead is counted (an
// 8 MB font alone is ~10.7 MB base64-encoded), so admin approve gets its own,
// larger streaming cap. This is also the real ceiling on FONT_ASSET_LIMIT:
// two max-size fonts plus images must still fit here, so raising the font
// limit without raising this would mint configs that can be shared but never
// approved. Lifting it for real means not round-tripping bytes through a JSON
// body at all (read pending/ from R2, copy to approved/ in place).
export const ADMIN_APPROVE_BODY_BYTES = 25 * 1024 * 1024;

async function parseJsonBody(request, maxBytes) {
  const body = await readJsonBounded(request, maxBytes);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "bad_json", "Request body must be a JSON object.");
  }
  return body;
}

function base64ToBytes(b64) {
  let binary;
  try {
    binary = atob(b64);
  } catch {
    throw new HttpError(400, "bad_asset", "Asset data is not valid base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// #9 GET /api/v1/admin/pending
// ---------------------------------------------------------------------------

async function listPending(request, env) {
  requireAdmin(request, env);

  // A single join covers every qualifying config in one round trip. Every
  // config whose assets_status is 'pending' has at least one assets row (the
  // share/update flow only ever sets assets_status to 'pending' when at
  // least one asset was queued), so the join never silently drops a config.
  //
  // This lists EVERY asset kind on the config (not just the pending ones) —
  // a config can be in a mixed approved+pending state (an owner PUT can keep
  // an already-approved kind untouched while adding/changing another), and
  // the admin console needs the full picture to render "already approved"
  // tiles alongside the ones still awaiting sanitization. Each item's
  // per-asset `status` tells the console (and approveConfig below) which
  // kinds are actually pending.
  const { results } = await env.DB.prepare(
    `SELECT c.id AS config_id, c.name, c.created_at, d.nickname AS author,
            a.kind AS asset_kind, a.sha256 AS asset_sha256, a.size AS asset_size,
            a.status AS asset_status
       FROM configs c
       JOIN assets a ON a.config_id = c.id
       JOIN devices d ON d.id = c.device_id
      WHERE c.assets_status = 'pending' AND c.status = 'active'
      ORDER BY c.created_at ASC, c.id ASC, a.kind ASC`
  ).all();

  const byConfig = new Map();
  for (const row of results) {
    let entry = byConfig.get(row.config_id);
    if (!entry) {
      entry = {
        config_id: row.config_id,
        name: row.name,
        author: row.author ?? "",
        created_at: row.created_at,
        assets: [],
      };
      byConfig.set(row.config_id, entry);
    }
    entry.assets.push({
      kind: row.asset_kind,
      sha256: row.asset_sha256,
      size: row.asset_size,
      status: row.asset_status,
    });
  }

  return jsonResponse({ items: [...byConfig.values()] });
}

// ---------------------------------------------------------------------------
// #10 GET /api/v1/admin/assets/:id/:kind — raw pending bytes for review
// ---------------------------------------------------------------------------

async function getPendingAsset(request, env, id, kind) {
  requireAdmin(request, env);

  const row = await env.DB.prepare("SELECT status FROM assets WHERE config_id = ? AND kind = ?")
    .bind(id, kind)
    .first();
  if (!row) {
    throw new HttpError(404, "not_found", "Asset not found.");
  }

  // In a mixed approved+pending config (an owner PUT can leave one kind
  // 'approved' while another is freshly 'pending'), an already-approved kind
  // has no pending/ object left — it was deleted the moment it was first
  // approved. Fall back to the approved/ bytes so the console can still
  // preview it; only a kind with no assets row at all is a genuine 404.
  const state = row.status === "approved" ? "approved" : "pending";
  const object = await env.R2.get(r2Key(state, id, kind));
  if (!object) {
    throw new HttpError(404, "not_found", "Asset not found.");
  }

  // The pending object carries the same customMetadata.format the share/
  // update flow wrote for every format-tracked kind, so Content-Type reflects
  // the actual sniffed format rather than assuming the kind's default. The
  // console branches on this header to pick a sanitizer, so a toolbar icon
  // mislabelled here would be an SVG fed to the canvas re-encoder.
  const headers = {
    "content-type": contentTypeFor(kind, object.customMetadata?.format),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };

  return new Response(object.body, { headers });
}

// ---------------------------------------------------------------------------
// #11 POST /api/v1/admin/configs/:id/approve
// ---------------------------------------------------------------------------

async function approveConfig(request, env, id) {
  const actor = requireAdmin(request, env);

  const config = await env.DB.prepare(
    "SELECT id FROM configs WHERE id = ? AND status = 'active' AND assets_status = 'pending'"
  )
    .bind(id)
    .first();
  if (!config) {
    throw new HttpError(409, "not_pending", "Config is not awaiting asset approval.");
  }

  // Approve operates on PENDING kinds only — a config can be in a mixed
  // approved+pending state (owner PUT kept one kind's sha256 unchanged,
  // which stays 'approved', while adding/changing another, which is fresh
  // 'pending'). Demanding the body cover ALL of the config's asset kinds
  // (including already-approved ones with no pending/ bytes left to fetch)
  // made approval permanently impossible in that state. The exact-set
  // invariant now applies to the pending subset only; already-approved rows
  // are left completely untouched by this handler.
  const { results: pendingAssetRows } = await env.DB.prepare(
    "SELECT kind FROM assets WHERE config_id = ? AND status = 'pending'"
  )
    .bind(id)
    .all();
  const expectedKinds = new Set(pendingAssetRows.map((r) => r.kind));

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > ADMIN_APPROVE_BODY_BYTES) {
    throw new HttpError(413, "too_large", "Request body exceeds the maximum size.");
  }

  const body = await parseJsonBody(request, ADMIN_APPROVE_BODY_BYTES);

  if (!Array.isArray(body.assets)) {
    throw new HttpError(400, "missing_asset", "assets must cover exactly the config's asset kinds.");
  }

  // An entry either carries sanitized bytes (data_b64) or declares that this
  // kind is passed through untouched, in which case approve reads the bytes
  // from pending/ itself. The two forms are not interchangeable: a kind in
  // APPROVE_FROM_R2_KINDS must use the passthrough form and every other kind
  // must carry bytes. That strictness is the point -- if the console ever
  // starts rewriting a kind listed here (or stops rewriting one that is not),
  // approve fails loudly instead of quietly storing bytes nobody sanitized.
  const byKind = new Map();
  for (const entry of body.assets) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.kind !== "string"
    ) {
      throw new HttpError(400, "missing_asset", "Malformed asset entry.");
    }
    if (byKind.has(entry.kind)) {
      throw new HttpError(400, "missing_asset", "Duplicate asset kind in request body.");
    }

    const fromR2 = APPROVE_FROM_R2_KINDS.has(entry.kind);
    if (fromR2) {
      if (entry.passthrough !== true || entry.data_b64 !== undefined) {
        throw new HttpError(
          400,
          "missing_asset",
          `Asset ${entry.kind} is approved from stored bytes; send { passthrough: true } and no data_b64.`
        );
      }
    } else if (typeof entry.data_b64 !== "string" || entry.passthrough !== undefined) {
      throw new HttpError(
        400,
        "missing_asset",
        `Asset ${entry.kind} must carry sanitized data_b64.`
      );
    }

    byKind.set(entry.kind, fromR2 ? null : entry.data_b64);
  }

  // The body must cover EXACTLY the config's PENDING asset kinds — no fewer
  // (a missing pending kind would leave it un-sanitized forever, never
  // approved at all) and no more (an already-approved kind has nowhere to
  // go here — it's re-approved implicitly by being left alone; including it
  // in the body is rejected the same way an unrelated extra kind would be,
  // keeping the exact-set invariant simple for both the server and the
  // console).
  const sameSize = byKind.size === expectedKinds.size;
  const coversAll = sameSize && [...expectedKinds].every((kind) => byKind.has(kind));
  if (!coversAll) {
    throw new HttpError(400, "missing_asset", "Body must cover exactly the config's pending asset kinds.");
  }

  const resolved = [];
  for (const kind of expectedKinds) {
    let bytes;
    if (APPROVE_FROM_R2_KINDS.has(kind)) {
      // These bytes were checked once on the way in (drafts.js), but they
      // have been sitting in storage since; re-running the same gates costs
      // nothing here and means both approve paths carry identical guarantees
      // rather than one of them trusting the bucket.
      const object = await env.R2.get(r2Key("pending", id, kind));
      if (!object) {
        throw new HttpError(
          409,
          "assets_incomplete",
          `Asset ${kind} has no pending bytes to approve.`
        );
      }
      bytes = new Uint8Array(await object.arrayBuffer());
    } else {
      bytes = base64ToBytes(byKind.get(kind));
    }

    const check = MAGIC_CHECKS[kind];
    if (!check || !check(bytes)) {
      throw new HttpError(400, "bad_asset", `Asset ${kind} failed the magic-byte check.`);
    }

    const limit = ASSET_SIZE_LIMITS[kind];
    if (bytes.byteLength > limit) {
      throw new HttpError(400, "bad_asset", `Asset ${kind} exceeds the size limit.`);
    }

    const sha256 = await sha256Hex(bytes);
    // Sniffed from the bytes the console actually returned, never assumed
    // from what it was asked to do: it re-encodes the bg kinds (login_bg /
    // main_bg) to png, and leaves a toolbar icon in whichever of SVG/PNG it
    // arrived as. MAGIC_CHECKS ran above, so this cannot come back null.
    const format = sniffFormat(kind, bytes);
    resolved.push({ kind, bytes, size: bytes.byteLength, sha256, format });
  }

  // R2 writes happen before the D1 batch commits: if the batch fails, an
  // orphaned approved/ object is an acceptable cost, but a D1 row must never
  // flip to 'approved' pointing at bytes that were never written.
  for (const asset of resolved) {
    const options = {};
    if (isFormatTrackedKind(asset.kind)) {
      options.customMetadata = { format: asset.format };
    }
    await env.R2.put(r2Key("approved", id, asset.kind), asset.bytes, options);
  }

  const statements = resolved.map((asset) =>
    env.DB.prepare(
      `UPDATE assets SET sha256 = ?, size = ?, status = 'approved', r2_key = ?
        WHERE config_id = ? AND kind = ?`
    ).bind(asset.sha256, asset.size, r2Key("approved", id, asset.kind), id, asset.kind)
  );
  await env.DB.batch(statements);

  // Recompute assets_status from what's actually left, the same way
  // rejectConfig does, rather than assuming 'approved': the request body was
  // required to cover the exact pending set above, so no row should still be
  // 'pending' at this point — but recomputing (instead of hardcoding) means
  // a config never gets stuck mismarked if that invariant is ever violated.
  const stillPending = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM assets WHERE config_id = ? AND status = 'pending'"
  )
    .bind(id)
    .first();
  const newAssetsStatus = stillPending.n > 0 ? "pending" : "approved";
  await env.DB.prepare("UPDATE configs SET assets_status = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(newAssetsStatus, id)
    .run();

  // Pending R2 objects are only deleted after the D1 batch commits — deleting
  // first and then losing the batch would strand an assets row still marked
  // 'pending' with nothing left at its old pending/ key.
  for (const asset of resolved) {
    await env.R2.delete(r2Key("pending", id, asset.kind));
  }

  await logAction(env, actor, "approve", "config", id);

  return jsonResponse({ id, approved: true });
}

// ---------------------------------------------------------------------------
// #12 POST /api/v1/admin/configs/:id/reject
// ---------------------------------------------------------------------------

async function rejectConfig(request, env, id) {
  const actor = requireAdmin(request, env);

  const config = await env.DB.prepare(
    "SELECT id FROM configs WHERE id = ? AND status = 'active' AND assets_status = 'pending'"
  )
    .bind(id)
    .first();
  if (!config) {
    throw new HttpError(409, "not_pending", "Config is not awaiting asset approval.");
  }

  // Only the *pending* kinds are rejected. A config's assets_status is
  // 'pending' as a whole even when some of its kinds are already 'approved'
  // (Task 8's update flow keeps an unchanged, previously-approved asset
  // as-is while marking only the changed/new kinds 'pending') — rejecting
  // must never delete an already-approved row or its public approved/
  // object out from under it. Only the pending rows/objects are ever
  // touched here.
  const { results: pendingRows } = await env.DB.prepare(
    "SELECT kind FROM assets WHERE config_id = ? AND status = 'pending'"
  )
    .bind(id)
    .all();

  await env.DB.prepare("DELETE FROM assets WHERE config_id = ? AND status = 'pending'").bind(id).run();

  for (const row of pendingRows) {
    await env.R2.delete(r2Key("pending", id, row.kind));
  }

  // Recompute assets_status from what's left: any remaining row must be
  // 'approved' (the pending ones were just deleted above), so a non-empty
  // remainder means the config still has approved assets -> 'approved'.
  // Nothing left at all -> 'rejected'.
  const remaining = await env.DB.prepare("SELECT COUNT(*) AS n FROM assets WHERE config_id = ?").bind(id).first();
  const newStatus = remaining.n > 0 ? "approved" : "rejected";

  await env.DB.prepare("UPDATE configs SET assets_status = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(newStatus, id)
    .run();

  await logAction(env, actor, "reject", "config", id);

  return jsonResponse({ id, rejected: true });
}

// ---------------------------------------------------------------------------
// #13 POST /api/v1/admin/configs/:id/takedown
// #14 POST /api/v1/admin/devices/:device_id/ban (shares the same soft step)
// ---------------------------------------------------------------------------

async function takedownConfig(request, env, id, note = "") {
  const actor = requireAdmin(request, env);

  const config = await env.DB.prepare("SELECT id FROM configs WHERE id = ? AND status = 'active'").bind(id).first();
  if (!config) {
    throw new HttpError(404, "not_found", "Config not found.");
  }

  // 只是下架,不销毁字节 —— 永久删除是 admin-configs.js 里独立的一个动作,
  // 且只对已下架的配置开放。
  await softTakedown(env, id, "admin");
  await logAction(env, actor, "takedown", "config", id, note);

  return jsonResponse({ id, removed: true });
}

async function banDevice(request, env, deviceId) {
  const actor = requireAdmin(request, env);

  // 与 purge 同一套可选理由(见 readOptionalReason):不发 body 依然合法。
  const reason = await readOptionalReason(request);

  const device = await env.DB.prepare("SELECT id FROM devices WHERE id = ?").bind(deviceId).first();
  if (!device) {
    throw new HttpError(404, "not_found", "Device not found.");
  }

  await env.DB.prepare("UPDATE devices SET banned = 1 WHERE id = ?").bind(deviceId).run();

  const { results: activeConfigs } = await env.DB.prepare(
    "SELECT id FROM configs WHERE device_id = ? AND status = 'active'"
  )
    .bind(deviceId)
    .all();

  for (const row of activeConfigs) {
    // 'admin',和单条下架同一个答案:级联是封禁带下来的,不是作者自己删的。
    // 标成 'owner' 会让这些配置从作者的「我的分享」里悄悄消失 —— 一个被封的
    // 人至少该看见自己的作品被下架了。
    // eslint-disable-next-line no-await-in-loop
    await softTakedown(env, row.id, "admin");
    // 每条被级联下架的配置各留一条自己的记录,并写明是谁的封禁带下来的。
    // 只在 device 上记一条总数的话,日后翻某一条配置的历史会看到它凭空
    // 消失、没有任何解释。
    // eslint-disable-next-line no-await-in-loop
    await logAction(env, actor, "takedown", "config", row.id, `banned device ${deviceId}`);
  }

  // 级联数量是这条封禁做了什么的事实,理由是为什么做 —— 追加而不是替换,
  // 两者都留下来。
  const cascade = `cascaded takedown of ${activeConfigs.length} config(s)`;
  await logAction(env, actor, "ban", "device", deviceId, reason ? `${cascade}; ${reason}` : cascade);

  return jsonResponse({ device_id: deviceId, banned: true, removed_configs: activeConfigs.length });
}

// ---------------------------------------------------------------------------
// #15 GET /api/v1/admin/reports, POST /api/v1/admin/reports/:rid/resolve
// ---------------------------------------------------------------------------

async function listReports(request, env) {
  requireAdmin(request, env);

  // 举报行只有 config_id 的时候,处理它得先自己去查被举报的是哪份配置。
  // LEFT JOIN 而非 INNER:reports.config_id 上没有外键,历史上可能存在指向
  // 已不存在配置的记录,内连接会把它们静默吞掉 —— 而一条无法解释的举报正是
  // 最需要被看见的。
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.config_id, r.reason, r.ip, r.created_at,
            c.name, c.status AS config_status, c.assets_status,
            d.nickname AS author
       FROM reports r
       LEFT JOIN configs c ON c.id = r.config_id
       LEFT JOIN devices d ON d.id = c.device_id
      WHERE r.resolved = 0
      ORDER BY r.created_at DESC, r.id DESC`
  ).all();

  const items = results.map((row) => ({
    id: row.id,
    config_id: row.config_id,
    reason: row.reason,
    ip: row.ip,
    created_at: row.created_at,
    name: row.name ?? "",
    config_status: row.config_status ?? "missing",
    assets_status: row.assets_status ?? "",
    author: row.author ?? "",
  }));

  return jsonResponse({ items });
}

async function resolveReport(request, env, rid) {
  const actor = requireAdmin(request, env);

  const numericId = Number(rid);
  if (!Number.isInteger(numericId)) {
    throw new HttpError(404, "not_found", "Report not found.");
  }

  const row = await env.DB.prepare("SELECT id FROM reports WHERE id = ?").bind(numericId).first();
  if (!row) {
    throw new HttpError(404, "not_found", "Report not found.");
  }

  await env.DB.prepare("UPDATE reports SET resolved = 1 WHERE id = ?").bind(numericId).run();

  await logAction(env, actor, "resolve_report", "report", String(numericId));

  return jsonResponse({ id: numericId, resolved: true });
}

// ---------------------------------------------------------------------------
// Exported route handlers — each converts HttpError to the standard error
// envelope, same convention as configs.js/assets.js.
// ---------------------------------------------------------------------------

function toErrorResponse(err) {
  if (err instanceof HttpError) {
    return errorResponse(err.status, err.code, err.message);
  }
  console.error(err);
  return errorResponse(500, "internal_error", "Something went wrong.");
}

export async function handlePendingList(request, env) {
  try {
    return await listPending(request, env);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handlePendingAsset(request, env, params) {
  try {
    return await getPendingAsset(request, env, params.id, params.kind);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleApprove(request, env, params) {
  try {
    return await approveConfig(request, env, params.id);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleReject(request, env, params) {
  try {
    return await rejectConfig(request, env, params.id);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleTakedown(request, env, params) {
  try {
    return await takedownConfig(request, env, params.id);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleBanDevice(request, env, params) {
  try {
    return await banDevice(request, env, params.device_id);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleReportsList(request, env) {
  try {
    return await listReports(request, env);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleResolveReport(request, env, params) {
  try {
    return await resolveReport(request, env, params.rid);
  } catch (err) {
    return toErrorResponse(err);
  }
}
