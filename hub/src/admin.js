// Handlers for /api/v1/admin/* (API contract #9-#15) — every endpoint here
// sits behind requireAdmin (Bearer vs env.ADMIN_TOKEN, see auth.js). This is
// the only place raw, unsanitized asset bytes are ever exposed (#10) or
// where the approve/reject/takedown/ban moderation actions happen.

import { HttpError, requireAdmin } from "./auth.js";
import { sha256Hex } from "./ids.js";
import { jsonResponse, errorResponse, readJsonBounded } from "./http.js";
import { MAGIC_CHECKS, r2Key, contentTypeFor, sniffLoginBgFormat } from "./assets.js";
import { ASSET_SIZE_LIMITS } from "./validate.js";

// Approve bodies carry base64 sanitized assets: all kinds together can
// exceed the general 12 MB request cap once base64 overhead is counted (an
// 8 MB font alone is ~10.7 MB base64-encoded), so admin approve gets its own,
// larger streaming cap.
const ADMIN_APPROVE_BODY_BYTES = 25 * 1024 * 1024;

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
  const { results } = await env.DB.prepare(
    `SELECT c.id AS config_id, c.name, c.author, c.created_at,
            a.kind AS asset_kind, a.sha256 AS asset_sha256, a.size AS asset_size
       FROM configs c
       JOIN assets a ON a.config_id = c.id
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
        author: row.author,
        created_at: row.created_at,
        assets: [],
      };
      byConfig.set(row.config_id, entry);
    }
    entry.assets.push({ kind: row.asset_kind, sha256: row.asset_sha256, size: row.asset_size });
  }

  return jsonResponse({ items: [...byConfig.values()] });
}

// ---------------------------------------------------------------------------
// #10 GET /api/v1/admin/assets/:id/:kind — raw pending bytes for review
// ---------------------------------------------------------------------------

async function getPendingAsset(request, env, id, kind) {
  requireAdmin(request, env);

  const row = await env.DB.prepare("SELECT 1 FROM assets WHERE config_id = ? AND kind = ?")
    .bind(id, kind)
    .first();
  if (!row) {
    throw new HttpError(404, "not_found", "Asset not found.");
  }

  const object = await env.R2.get(r2Key("pending", id, kind));
  if (!object) {
    throw new HttpError(404, "not_found", "Asset not found.");
  }

  // The pending object carries the same customMetadata.format the share/
  // update flow wrote for login_bg, so Content-Type reflects the actual
  // sniffed format rather than assuming png.
  const sniffedJpeg = object.customMetadata?.format === "jpeg";
  const headers = {
    "content-type": contentTypeFor(kind, sniffedJpeg),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };

  return new Response(object.body, { headers });
}

// ---------------------------------------------------------------------------
// #11 POST /api/v1/admin/configs/:id/approve
// ---------------------------------------------------------------------------

async function approveConfig(request, env, id) {
  requireAdmin(request, env);

  const config = await env.DB.prepare(
    "SELECT id FROM configs WHERE id = ? AND status = 'active' AND assets_status = 'pending'"
  )
    .bind(id)
    .first();
  if (!config) {
    throw new HttpError(409, "not_pending", "Config is not awaiting asset approval.");
  }

  const { results: assetRows } = await env.DB.prepare("SELECT kind FROM assets WHERE config_id = ?")
    .bind(id)
    .all();
  const expectedKinds = new Set(assetRows.map((r) => r.kind));

  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > ADMIN_APPROVE_BODY_BYTES) {
    throw new HttpError(413, "too_large", "Request body exceeds the maximum size.");
  }

  const body = await parseJsonBody(request, ADMIN_APPROVE_BODY_BYTES);

  if (!Array.isArray(body.assets)) {
    throw new HttpError(400, "missing_asset", "assets must cover exactly the config's asset kinds.");
  }

  const byKind = new Map();
  for (const entry of body.assets) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.kind !== "string" ||
      typeof entry.data_b64 !== "string"
    ) {
      throw new HttpError(400, "missing_asset", "Malformed asset entry.");
    }
    if (byKind.has(entry.kind)) {
      throw new HttpError(400, "missing_asset", "Duplicate asset kind in request body.");
    }
    byKind.set(entry.kind, entry.data_b64);
  }

  // The body must cover EXACTLY the config's asset kinds — no fewer (a
  // missing kind would leave it un-sanitized forever, silently served as
  // whatever the previous approved bytes were, or never approved at all)
  // and no more (an extra kind has nowhere to go).
  const sameSize = byKind.size === expectedKinds.size;
  const coversAll = sameSize && [...expectedKinds].every((kind) => byKind.has(kind));
  if (!coversAll) {
    throw new HttpError(400, "missing_asset", "Body must cover exactly the config's asset kinds.");
  }

  const resolved = [];
  for (const kind of expectedKinds) {
    const bytes = base64ToBytes(byKind.get(kind));

    const check = MAGIC_CHECKS[kind];
    if (!check || !check(bytes)) {
      throw new HttpError(400, "bad_asset", `Asset ${kind} failed the magic-byte check.`);
    }

    const limit = ASSET_SIZE_LIMITS[kind];
    if (bytes.byteLength > limit) {
      throw new HttpError(400, "bad_asset", `Asset ${kind} exceeds the size limit.`);
    }

    const sha256 = await sha256Hex(bytes);
    // The admin page re-encodes login_bg to png, but this re-sniffs the
    // actual sanitized bytes rather than assuming that — the sniff already
    // ran above via MAGIC_CHECKS.login_bg, so this can't come back null.
    const format = kind === "login_bg" ? sniffLoginBgFormat(bytes) : undefined;
    resolved.push({ kind, bytes, size: bytes.byteLength, sha256, format });
  }

  // R2 writes happen before the D1 batch commits: if the batch fails, an
  // orphaned approved/ object is an acceptable cost, but a D1 row must never
  // flip to 'approved' pointing at bytes that were never written.
  for (const asset of resolved) {
    const options = {};
    if (asset.kind === "login_bg") {
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
  statements.push(
    env.DB.prepare("UPDATE configs SET assets_status = 'approved', updated_at = datetime('now') WHERE id = ?").bind(
      id
    )
  );
  await env.DB.batch(statements);

  // Pending R2 objects are only deleted after the D1 batch commits — deleting
  // first and then losing the batch would strand an assets row still marked
  // 'pending' with nothing left at its old pending/ key.
  for (const asset of resolved) {
    await env.R2.delete(r2Key("pending", id, asset.kind));
  }

  return jsonResponse({ id, approved: true });
}

// ---------------------------------------------------------------------------
// #12 POST /api/v1/admin/configs/:id/reject
// ---------------------------------------------------------------------------

async function rejectConfig(request, env, id) {
  requireAdmin(request, env);

  const config = await env.DB.prepare(
    "SELECT id FROM configs WHERE id = ? AND status = 'active' AND assets_status = 'pending'"
  )
    .bind(id)
    .first();
  if (!config) {
    throw new HttpError(409, "not_pending", "Config is not awaiting asset approval.");
  }

  const { results: assetRows } = await env.DB.prepare("SELECT kind FROM assets WHERE config_id = ?")
    .bind(id)
    .all();

  await env.DB.batch([
    env.DB.prepare("DELETE FROM assets WHERE config_id = ?").bind(id),
    env.DB.prepare("UPDATE configs SET assets_status = 'rejected', updated_at = datetime('now') WHERE id = ?").bind(
      id
    ),
  ]);

  for (const row of assetRows) {
    await env.R2.delete(r2Key("pending", id, row.kind));
  }

  return jsonResponse({ id, rejected: true });
}

// ---------------------------------------------------------------------------
// #13 POST /api/v1/admin/configs/:id/takedown
// #14 POST /api/v1/admin/devices/:device_id/ban (shares the same cascade)
// ---------------------------------------------------------------------------

// Fully removes one config: status='removed', every assets row dropped, and
// every R2 object for it deleted in both states (an asset can be sitting in
// either pending/ or approved/ — or, mid-update, technically neither if it
// was already cleaned up — so both keys are always attempted; R2 delete of a
// missing key is a no-op).
async function cascadeRemoveConfig(env, id) {
  const { results: assetRows } = await env.DB.prepare("SELECT kind FROM assets WHERE config_id = ?")
    .bind(id)
    .all();

  await env.DB.batch([
    env.DB.prepare("UPDATE configs SET status = 'removed', updated_at = datetime('now') WHERE id = ?").bind(id),
    env.DB.prepare("DELETE FROM assets WHERE config_id = ?").bind(id),
  ]);

  for (const row of assetRows) {
    await env.R2.delete(r2Key("pending", id, row.kind));
    await env.R2.delete(r2Key("approved", id, row.kind));
  }
}

async function takedownConfig(request, env, id) {
  requireAdmin(request, env);

  const config = await env.DB.prepare("SELECT id FROM configs WHERE id = ? AND status = 'active'").bind(id).first();
  if (!config) {
    throw new HttpError(404, "not_found", "Config not found.");
  }

  await cascadeRemoveConfig(env, id);

  return jsonResponse({ id, removed: true });
}

async function banDevice(request, env, deviceId) {
  requireAdmin(request, env);

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
    // eslint-disable-next-line no-await-in-loop
    await cascadeRemoveConfig(env, row.id);
  }

  return jsonResponse({ device_id: deviceId, banned: true, removed_configs: activeConfigs.length });
}

// ---------------------------------------------------------------------------
// #15 GET /api/v1/admin/reports, POST /api/v1/admin/reports/:rid/resolve
// ---------------------------------------------------------------------------

async function listReports(request, env) {
  requireAdmin(request, env);

  const { results } = await env.DB.prepare(
    "SELECT id, config_id, reason, ip, created_at FROM reports WHERE resolved = 0 ORDER BY created_at DESC, id DESC"
  ).all();

  return jsonResponse({ items: results });
}

async function resolveReport(request, env, rid) {
  requireAdmin(request, env);

  const numericId = Number(rid);
  if (!Number.isInteger(numericId)) {
    throw new HttpError(404, "not_found", "Report not found.");
  }

  const row = await env.DB.prepare("SELECT id FROM reports WHERE id = ?").bind(numericId).first();
  if (!row) {
    throw new HttpError(404, "not_found", "Report not found.");
  }

  await env.DB.prepare("UPDATE reports SET resolved = 1 WHERE id = ?").bind(numericId).run();

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
