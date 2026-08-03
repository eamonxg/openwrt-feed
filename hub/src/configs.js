// Handlers for /api/v1/themes/aurora/configs* (API contract #1-#7).
// This file currently implements #3 (share) per the "分享流程" section;
// later tasks add browse/manage/download/report alongside it.

import { HttpError, deviceFromToken, bumpQuota } from "./auth.js";
import { shortId, canonicalJson, contentHash, sha256Hex } from "./ids.js";
import { validateMeta, validatePayload } from "./validate.js";
import { MAGIC_CHECKS, r2Key, sniffLoginBgFormat } from "./assets.js";

function jsonResponse(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

function errorResponse(status, code, message) {
  return jsonResponse({ error: { code, message } }, { status });
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

async function parseJsonBody(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "bad_request", "Request body must be valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "bad_request", "Request body must be a JSON object.");
  }
  return body;
}

function base64ToBytes(b64) {
  let binary;
  try {
    binary = atob(b64);
  } catch {
    throw new HttpError(400, "asset_mismatch", "Asset data is not valid base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Step ③: cross-check the validated `payload.assets` manifest against the
// raw {kind, data_b64} entries supplied in the request body — same kinds,
// matching decoded sha256/size. Step ④: per-kind magic-byte sniff on the
// decoded bytes. Returns [{kind, bytes, format}] ready for R2/D1 writes,
// where `format` is only set (to "png"|"jpeg") for kind === "login_bg".
async function reconcileAssets(manifest, bodyAssets) {
  if (manifest.length === 0) {
    if (bodyAssets !== undefined && !(Array.isArray(bodyAssets) && bodyAssets.length === 0)) {
      throw new HttpError(400, "asset_mismatch", "No assets declared in payload.");
    }
    return [];
  }

  if (!Array.isArray(bodyAssets)) {
    throw new HttpError(400, "asset_mismatch", "assets must be an array of {kind, data_b64}.");
  }

  const byKind = new Map();
  for (const entry of bodyAssets) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.kind !== "string" ||
      typeof entry.data_b64 !== "string"
    ) {
      throw new HttpError(400, "asset_mismatch", "Malformed asset entry.");
    }
    if (byKind.has(entry.kind)) {
      throw new HttpError(400, "asset_mismatch", "Duplicate asset kind in request body.");
    }
    byKind.set(entry.kind, entry.data_b64);
  }

  const resolved = [];
  for (const item of manifest) {
    const data = byKind.get(item.kind);
    if (data === undefined) {
      throw new HttpError(400, "asset_mismatch", `Missing asset data for ${item.kind}.`);
    }
    byKind.delete(item.kind);

    // Step ③: decode + reconcile against the manifest's sha256/size.
    const bytes = base64ToBytes(data);
    if (bytes.byteLength !== item.size) {
      throw new HttpError(400, "asset_mismatch", `Size mismatch for ${item.kind}.`);
    }
    const hash = await sha256Hex(bytes);
    if (hash !== item.sha256) {
      throw new HttpError(400, "asset_mismatch", `Hash mismatch for ${item.kind}.`);
    }

    // Step ④: magic-byte sniff.
    const check = MAGIC_CHECKS[item.kind];
    if (!check(bytes)) {
      throw new HttpError(400, "bad_asset", `Asset ${item.kind} failed the magic-byte check.`);
    }

    const format = item.kind === "login_bg" ? sniffLoginBgFormat(bytes) : undefined;
    resolved.push({ kind: item.kind, bytes, format });
  }

  if (byKind.size > 0) {
    throw new HttpError(400, "asset_mismatch", "Request body has assets not in the payload manifest.");
  }

  return resolved;
}

async function findDuplicate(db, theme, hash) {
  return db
    .prepare("SELECT id FROM configs WHERE theme = ? AND content_hash = ? AND status = 'active'")
    .bind(theme, hash)
    .first();
}

async function shareConfig(request, env, theme) {
  const body = await parseJsonBody(request);

  // Step ①: token -> device (silent registration), banned check.
  const device = await deviceFromToken(env.DB, body.device_token, { register: true });
  if (device.banned) {
    throw new HttpError(403, "device_banned", "This device has been banned.");
  }

  // Step ②: daily quota.
  const allowed = await bumpQuota(env.DB, device, todayUtc());
  if (!allowed) {
    throw new HttpError(429, "quota_exceeded", "Daily share quota exceeded.");
  }

  // Step ③/④: validate metadata + payload schema, then reconcile/sniff assets.
  const meta = validateMeta({ name: body.name, author: body.author, description: body.description });
  const payload = validatePayload(body.payload);
  const resolvedAssets = await reconcileAssets(payload.assets, body.assets);

  const canonicalPayload = canonicalJson(payload);
  const hash = await contentHash(payload);

  // Step ⑤: content-hash dedup.
  const existing = await findDuplicate(env.DB, theme, hash);
  if (existing) {
    return jsonResponse({ id: existing.id, duplicate: true }, { status: 200 });
  }

  // Step ⑥: insert configs + assets rows, R2 objects at pending/{id}/{kind}.
  const id = shortId();
  const assetsStatus = resolvedAssets.length ? "pending" : "none";

  // R2 puts happen before the D1 batch: if the batch fails, orphaned R2
  // objects are an acceptable cost, but a D1 row must never reference an
  // object that was never written.
  for (const asset of resolvedAssets) {
    const key = r2Key("pending", id, asset.kind);
    const options = {};
    if (asset.kind === "login_bg") {
      options.customMetadata = { format: asset.format };
    }
    await env.R2.put(key, asset.bytes, options);
  }

  const statements = [
    env.DB.prepare(
      `INSERT INTO configs
         (id, theme, device_id, name, author, description, payload, content_hash, schema, assets_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      theme,
      device.id,
      meta.name,
      meta.author,
      meta.description,
      canonicalPayload,
      hash,
      1,
      assetsStatus
    ),
  ];

  for (const asset of resolvedAssets) {
    const manifestItem = payload.assets.find((item) => item.kind === asset.kind);
    statements.push(
      env.DB.prepare(
        `INSERT INTO assets (config_id, kind, r2_key, sha256, size, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`
      ).bind(id, asset.kind, r2Key("pending", id, asset.kind), manifestItem.sha256, manifestItem.size)
    );
  }

  try {
    await env.DB.batch(statements);
  } catch (err) {
    // Race: another request committed the same (theme, content_hash) between
    // our SELECT and this INSERT — idx_configs_dedup rejects the batch.
    // Re-select and return the same duplicate response instead of surfacing
    // a raw constraint error.
    const raced = await findDuplicate(env.DB, theme, hash);
    if (raced) {
      return jsonResponse({ id: raced.id, duplicate: true }, { status: 200 });
    }
    throw err;
  }

  return jsonResponse({ id, manage: true }, { status: 201 });
}

export async function handleShare(request, env, params) {
  try {
    return await shareConfig(request, env, params.theme);
  } catch (err) {
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.code, err.message);
    }
    // Unexpected error: never leak internals (stack traces, driver error
    // text) into the response body.
    console.error(err);
    return errorResponse(500, "internal_error", "Something went wrong.");
  }
}
