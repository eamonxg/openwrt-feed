// Handlers for /api/v1/themes/aurora/configs* (API contract #1-#7).
// This file currently implements #3 (share) per the "分享流程" section;
// later tasks add browse/manage/download/report alongside it.

import { HttpError, deviceFromToken, bumpQuota } from "./auth.js";
import { shortId, canonicalJson, contentHash, sha256Hex } from "./ids.js";
import { validateMeta, validatePayload, cleanText } from "./validate.js";
import { MAGIC_CHECKS, r2Key, sniffLoginBgFormat } from "./assets.js";
import { jsonResponse, errorResponse, readJsonBounded, MAX_BODY_BYTES } from "./http.js";

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// Reads the body via the streaming-bounded reader (closes the chunked-body
// bypass of worker.js's Content-Length fast path — see http.js) and confirms
// the parsed JSON is a plain object before any field is read off it.
async function parseJsonBody(request, maxBytes = MAX_BODY_BYTES) {
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

// Shared existence check for #6/#7: config must exist, match theme, and be
// 'active' (not 'removed') — anything else surfaces as a uniform 404
// not_found, same as #2's detail lookup.
async function requireActiveConfigId(db, theme, id) {
  const row = await db
    .prepare("SELECT id FROM configs WHERE theme = ? AND id = ? AND status = 'active'")
    .bind(theme, id)
    .first();
  if (!row) {
    throw new HttpError(404, "not_found", "Config not found.");
  }
  return row.id;
}

// ---------------------------------------------------------------------------
// #1 GET /themes/:theme/configs — browse (list)
// ---------------------------------------------------------------------------

const PAGE_SIZE = 24;

function parseSort(url) {
  return url.searchParams.get("sort") === "new" ? "new" : "hot";
}

// Invalid/absent page -> 1. Number("") is 0, Number(null-ish) is NaN; both
// fail the isInteger+>=1 check and fall back to the default.
function parsePage(url) {
  const raw = url.searchParams.get("page");
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

// The 8-color list summary: light/dark each {bg, surface, text, brand},
// pulled straight out of the stored (already-validated) payload's `colors`
// section — never re-validated here.
function extractPalette(payload) {
  const colors = payload.colors;
  const pick = (prefix) => ({
    bg: colors[`${prefix}_bg`],
    surface: colors[`${prefix}_surface`],
    text: colors[`${prefix}_text`],
    brand: colors[`${prefix}_brand`],
  });
  return { light: pick("light"), dark: pick("dark") };
}

async function listConfigs(request, env, theme) {
  const url = new URL(request.url);
  const sort = parseSort(url);
  const page = parsePage(url);
  const offset = (page - 1) * PAGE_SIZE;
  // `sort` is one of exactly two hardcoded literals (never user-interpolated
  // beyond that ternary), so building the ORDER BY clause this way carries no
  // injection risk.
  const orderBy = sort === "new" ? "created_at DESC, id ASC" : "downloads DESC, id ASC";

  // Fetch one extra row (25) to determine has_more without a second COUNT(*)
  // query, then trim back to the page size below.
  const { results } = await env.DB.prepare(
    `SELECT id, name, author, downloads, assets_status, created_at, payload
       FROM configs
      WHERE theme = ? AND status = 'active'
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`
  )
    .bind(theme, PAGE_SIZE + 1, offset)
    .all();

  const has_more = results.length > PAGE_SIZE;
  const items = results.slice(0, PAGE_SIZE).map((row) => ({
    id: row.id,
    name: row.name,
    author: row.author,
    downloads: row.downloads,
    assets_status: row.assets_status,
    created_at: row.created_at,
    palette: extractPalette(JSON.parse(row.payload)),
  }));

  return jsonResponse({ items, page, has_more });
}

// ---------------------------------------------------------------------------
// #2 GET /themes/:theme/configs/:id — detail
// ---------------------------------------------------------------------------

async function getConfigDetail(env, theme, id) {
  const row = await env.DB.prepare(
    "SELECT * FROM configs WHERE theme = ? AND id = ? AND status = 'active'"
  )
    .bind(theme, id)
    .first();

  if (!row) {
    throw new HttpError(404, "not_found", "Config not found.");
  }

  const { results: assetRows } = await env.DB.prepare(
    "SELECT kind, sha256, size FROM assets WHERE config_id = ? AND status = 'approved' ORDER BY kind"
  )
    .bind(id)
    .all();

  const assets = assetRows.map((a) => ({
    kind: a.kind,
    sha256: a.sha256,
    size: a.size,
    url: `/assets/${id}/${a.kind}`,
  }));

  return jsonResponse({
    id: row.id,
    name: row.name,
    author: row.author,
    description: row.description,
    version: row.version,
    downloads: row.downloads,
    assets_status: row.assets_status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    payload: JSON.parse(row.payload),
    assets,
  });
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

export async function handleListConfigs(request, env, params) {
  try {
    return await listConfigs(request, env, params.theme);
  } catch (err) {
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.code, err.message);
    }
    console.error(err);
    return errorResponse(500, "internal_error", "Something went wrong.");
  }
}

export async function handleConfigDetail(request, env, params) {
  try {
    return await getConfigDetail(env, params.theme, params.id);
  } catch (err) {
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.code, err.message);
    }
    console.error(err);
    return errorResponse(500, "internal_error", "Something went wrong.");
  }
}

// ---------------------------------------------------------------------------
// #6 POST /themes/:theme/configs/:id/download
// #7 POST /themes/:theme/configs/:id/report
//
// Both bodies are tiny ({device_hash} / {reason}), so a small streaming cap
// is plenty and keeps a malicious huge body from being buffered at all.
// ---------------------------------------------------------------------------

const SMALL_BODY_BYTES = 4096;
const DEVICE_HASH_PATTERN = /^[a-f0-9]{64}$/;
const REPORT_REASON_MAX = 200;
const REPORT_DAILY_LIMIT = 20;

async function downloadConfig(request, env, theme, id) {
  const body = await parseJsonBody(request, SMALL_BODY_BYTES);
  if (typeof body.device_hash !== "string" || !DEVICE_HASH_PATTERN.test(body.device_hash)) {
    throw new HttpError(400, "bad_device_hash", "device_hash must be a 64-character lowercase hex string.");
  }

  await requireActiveConfigId(env.DB, theme, id);

  // INSERT OR IGNORE + a change-count read replaces a SELECT-then-INSERT
  // dedup check with a single round trip. NOTE: this is intentionally NOT
  // atomic with the downloads+1 UPDATE below — D1/SQLite has no
  // `RETURNING`-with-branch primitive that folds both into one statement,
  // and batch() can't branch on an earlier statement's result mid-batch.
  // A crash between the two statements loses at most one download count;
  // acceptable at this scale, called out explicitly per the task brief.
  const insertResult = await env.DB
    .prepare("INSERT OR IGNORE INTO dl_dedup (config_id, device_hash) VALUES (?, ?)")
    .bind(id, body.device_hash)
    .run();

  const counted = insertResult.meta.changes === 1;
  if (counted) {
    await env.DB.prepare("UPDATE configs SET downloads = downloads + 1 WHERE id = ?").bind(id).run();
  }

  return jsonResponse({ counted });
}

async function reportConfig(request, env, theme, id) {
  const body = await parseJsonBody(request, SMALL_BODY_BYTES);
  if (typeof body.reason !== "string") {
    throw new HttpError(400, "bad_reason", "reason is required.");
  }
  const reason = cleanText(body.reason, () => new HttpError(400, "bad_reason", "reason is invalid."));
  if (reason.length < 1 || reason.length > REPORT_REASON_MAX) {
    throw new HttpError(400, "bad_reason", "reason must be 1-200 characters.");
  }

  await requireActiveConfigId(env.DB, theme, id);

  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const day = todayUtc();

  // Single upsert-and-read: increments (or creates) today's per-IP report
  // counter and hands back the resulting count in one round trip.
  const counter = await env.DB
    .prepare(
      `INSERT INTO ip_counters (ip, bucket, day, count) VALUES (?, 'report', ?, 1)
         ON CONFLICT(ip, bucket, day) DO UPDATE SET count = count + 1
         RETURNING count`
    )
    .bind(ip, day)
    .first();

  if (counter.count > REPORT_DAILY_LIMIT) {
    throw new HttpError(429, "rate_limited", "Too many reports from this IP today.");
  }

  await env.DB
    .prepare("INSERT INTO reports (config_id, reason, ip) VALUES (?, ?, ?)")
    .bind(id, reason, ip)
    .run();

  return jsonResponse({ ok: true });
}

export async function handleDownload(request, env, params) {
  try {
    return await downloadConfig(request, env, params.theme, params.id);
  } catch (err) {
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.code, err.message);
    }
    console.error(err);
    return errorResponse(500, "internal_error", "Something went wrong.");
  }
}

export async function handleReport(request, env, params) {
  try {
    return await reportConfig(request, env, params.theme, params.id);
  } catch (err) {
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.code, err.message);
    }
    console.error(err);
    return errorResponse(500, "internal_error", "Something went wrong.");
  }
}
