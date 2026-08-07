// Handlers for /api/v1/themes/aurora/configs* (API contract #1-#7).
// This file currently implements #3 (share) per the "分享流程" section;
// later tasks add browse/manage/download/report alongside it.

import { HttpError, deviceFromToken, bumpQuota } from "./auth.js";
import { shortId, canonicalJson, contentHash, sha256Hex } from "./ids.js";
import { validateMeta, validatePayload, cleanText } from "./validate.js";
import { MAGIC_CHECKS, r2Key, isFormatTrackedKind, sniffFormat } from "./assets.js";
import { jsonResponse, errorResponse, readJsonBounded, MAX_BODY_BYTES } from "./http.js";
import { softTakedown, purgeConfig } from "./lifecycle.js";

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

    const format = sniffFormat(item.kind, bytes);
    resolved.push({ kind: item.kind, bytes, format });
  }

  if (byKind.size > 0) {
    throw new HttpError(400, "asset_mismatch", "Request body has assets not in the payload manifest.");
  }

  return resolved;
}

// 资产字节的来源被抽象成一个 writeTo：base64 单请求路径把内存里的字节写进
// 去，草稿提交路径（drafts.js）则从 R2 的 draft/ 键流式拷过去。除此之外
// D1 那一整套（内容去重、version+1、资产 diff）两条路完全共用 —— 抄一份的
// 话迟早分叉，而分叉的那一半永远是没人测的那半。
export function bytesSource(kind, bytes, format) {
  return {
    kind,
    format,
    writeTo(env, key) {
      const options = {};
      if (isFormatTrackedKind(kind)) options.customMetadata = { format };
      return env.R2.put(key, bytes, options);
    },
  };
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

// DEPRECATED — kept for luci-app-aurora-config <= 1.1.3, which is live on
// real devices and reads `item.palette`. Removing it would break those
// installs outright. New clients read `item.preview.colors` instead (see
// extractPreview below); this must not be deleted until that fleet is gone.
//
// The 8-color list summary: light/dark each {bg, surface, text, brand},
// pulled straight out of the stored (already-validated) payload's `colors`
// section — never re-validated here.
export function extractPalette(payload) {
  const colors = payload.colors;
  const pick = (prefix) => ({
    bg: colors[`${prefix}_bg`],
    surface: colors[`${prefix}_surface`],
    text: colors[`${prefix}_text`],
    brand: colors[`${prefix}_brand`],
  });
  return { light: pick("light"), dark: pick("dark") };
}

// The list row's `preview` is a STRUCTURAL SUBSET of the stored payload:
// every retained field keeps payload's own name and type, there are just
// fewer of them. That is the whole design rule — one client render path can
// then consume `item.preview` (cards) and `item.payload` (detail drawer),
// and adding a config field later means adding a line here rather than
// inventing a new word in the API.
//
// Three deliberate reductions against the payload:
//   - `colors`: 8 keys of 62. The full set is ~37KB per 24-row page and a
//     card cannot draw a single one of the other 54.
//   - `toolbar`: no `url`. It is capped at 200 chars and dominates the
//     section's size; an off-box link also needs its own confirmation
//     before applying, which is the detail path's job, not a card's.
//   - `assets`: no `sha256`/`size` (those verify bytes at apply time), plus
//     a `url`.
//
// Nothing here re-validates: the payload passed validate.js in full before
// it was ever stored, so checking again would be duplicate work that hides
// the real failure.
const PREVIEW_COLOR_KEYS = [
  "light_bg", "light_surface", "light_text", "light_brand",
  "dark_bg", "dark_surface", "dark_text", "dark_brand",
];

// `assets` is NOT derived from `payload.assets`: that manifest lists what the
// author uploaded, including bytes still awaiting review or already
// rejected. Showing those as "included" would leak unreviewed content into
// the browse surface. The caller passes the approved-only rows instead.
function extractPreview(payload, assets) {
  const colors = {};
  for (const key of PREVIEW_COLOR_KEYS) colors[key] = payload.colors[key];

  const toolbar = payload.toolbar.map((item) => {
    const entry = { title: item.title, enabled: item.enabled };
    // `icon` is optional in the payload; stay optional here too rather than
    // materialising `icon: undefined`, so the shapes really do match.
    if (item.icon !== undefined) entry.icon = item.icon;
    return entry;
  });

  return {
    colors,
    layout: { ...payload.layout },
    typography: { ...payload.typography },
    toolbar,
    assets,
  };
}

// GROUP_CONCAT gives back a comma-joined string (NULL when the LEFT JOIN
// matched nothing) in an order SQLite does not define, so the kinds are
// re-sorted here to match the detail endpoint's `ORDER BY kind`.
//
// The url stays RELATIVE, exactly like the detail endpoint's — the client
// owns the hub base and prepends it. Returning an absolute url here would
// bake this deployment's hostname into cached client data.
function previewAssets(id, approvedKinds) {
  return (approvedKinds ?? "")
    .split(",")
    .filter(Boolean)
    .sort()
    .map((kind) => ({ kind, url: `/assets/${id}/${kind}` }));
}

async function listConfigs(request, env, theme) {
  const url = new URL(request.url);
  const sort = parseSort(url);
  const page = parsePage(url);
  const offset = (page - 1) * PAGE_SIZE;
  // `sort` is one of exactly two hardcoded literals (never user-interpolated
  // beyond that ternary), so building the ORDER BY clause this way carries no
  // injection risk.
  const orderBy = sort === "new" ? "c.created_at DESC, c.id ASC" : "c.downloads DESC, c.id ASC";

  // One LEFT JOIN + GROUP_CONCAT, never a per-row asset query: 24 rows would
  // otherwise mean 25 round trips. LEFT (not inner) so a config with no
  // assets — the common case — still appears; GROUP BY so a config with two
  // approved kinds appears once, not twice.
  //
  // The `status = 'approved'` predicate sits in the JOIN condition, not the
  // WHERE clause: in the WHERE clause it would turn the LEFT JOIN back into
  // an inner one and silently hide every asset-free config.
  //
  // Same approved-only predicate as the detail endpoint below. They must not
  // diverge — a list that counted pending or rejected assets would advertise
  // unreviewed content as "included".
  //
  // 审核中的配置不进列表。资产要过审才公开,而一条配置的图片正是它区别于
  // 别人的地方 —— 让它带着取不到的图先上架,别人套用后只会拿到一半的样子,
  // 也没有任何一个界面能解释那一半去哪了。
  //
  // 谓词写 != 'pending' 而不是白名单 IN (...):将来若新增状态值,默认可见
  // 比默认隐藏安全 —— 一条配置因为无人认识它的新状态而从商店里消失,比它
  // 多显示一天难查得多。
  //
  // 详情接口不设这道闸:配置数据本身无害,资产本来就取不到,而作者要能预览
  // 和更新自己那条待审的作品。
  //
  // Fetch one extra row (25) to determine has_more without a second COUNT(*)
  // query, then trim back to the page size below.
  //
  // The display name comes from the owning device's profile, not from the
  // config row: that is what makes a rename apply to everything the creator
  // has already published, and what stops anyone signing as someone else.
  const { results } = await env.DB.prepare(
    // devices joins INNER (every config has an owner) while assets stays
    // LEFT; grouping by c.id is still safe for d.id/d.nickname, since one
    // config has exactly one owning device.
    `SELECT c.id, c.name, c.downloads, c.assets_status, c.created_at,
            c.schema, c.payload,
            d.id AS author_id, d.nickname AS author,
            GROUP_CONCAT(a.kind) AS approved_kinds
       FROM configs c
       JOIN devices d ON d.id = c.device_id
       LEFT JOIN assets a ON a.config_id = c.id AND a.status = 'approved'
      WHERE c.theme = ? AND c.status = 'active' AND c.assets_status != 'pending'
      GROUP BY c.id
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?`
  )
    .bind(theme, PAGE_SIZE + 1, offset)
    .all();

  const has_more = results.length > PAGE_SIZE;
  const items = results.slice(0, PAGE_SIZE).map((row) => {
    // One parse per row feeds both projections — extending the response
    // costs no extra read and no extra parse.
    const payload = JSON.parse(row.payload);
    return {
      id: row.id,
      name: row.name,
      // Joined from the owner's profile; "" while that creator is unnamed.
      author: row.author ?? "",
      author_id: row.author_id,
      downloads: row.downloads,
      assets_status: row.assets_status,
      created_at: row.created_at,
      // Lets a client skip a row whose schema it cannot read, instead of
      // rendering it wrong.
      schema: row.schema,
      palette: extractPalette(payload),
      preview: extractPreview(payload, previewAssets(row.id, row.approved_kinds)),
    };
  });

  return jsonResponse({ items, page, has_more });
}

// ---------------------------------------------------------------------------
// #2 GET /themes/:theme/configs/:id — detail
// ---------------------------------------------------------------------------

async function getConfigDetail(env, theme, id) {
  const row = await env.DB.prepare(
    `SELECT c.*, d.id AS author_id, d.nickname AS author
       FROM configs c
       JOIN devices d ON d.id = c.device_id
      WHERE c.theme = ? AND c.id = ? AND c.status = 'active'`
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
    author: row.author ?? "",
    author_id: row.author_id,
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
  const meta = validateMeta({ name: body.name, description: body.description });
  const payload = validatePayload(body.payload);
  const resolvedAssets = await reconcileAssets(payload.assets, body.assets);

  return insertConfigWithAssets(env, {
    theme,
    device,
    meta,
    payload,
    sources: resolvedAssets.map((a) => bytesSource(a.kind, a.bytes, a.format)),
  });
}

// Step ⑤/⑥, lifted out of shareConfig so the draft-commit path (drafts.js)
// can reach the same D1 writes with bytes that live in R2 rather than in
// memory. `sources` only has to be [{kind, format, writeTo(env, key)}] —
// where the bytes come from is none of this function's business.
export async function insertConfigWithAssets(env, { theme, device, meta, payload, sources }) {
  const canonicalPayload = canonicalJson(payload);
  const hash = await contentHash(payload);

  // Step ⑤: content-hash dedup.
  const existing = await findDuplicate(env.DB, theme, hash);
  if (existing) {
    return jsonResponse({ id: existing.id, duplicate: true }, { status: 200 });
  }

  // Step ⑥: insert configs + assets rows, R2 objects at pending/{id}/{kind}.
  const id = shortId();
  const assetsStatus = sources.length ? "pending" : "none";

  // R2 puts happen before the D1 batch: if the batch fails, orphaned R2
  // objects are an acceptable cost, but a D1 row must never reference an
  // object that was never written.
  for (const source of sources) {
    await source.writeTo(env, r2Key("pending", id, source.kind));
  }

  const statements = [
    env.DB.prepare(
      `INSERT INTO configs
         (id, theme, device_id, name, description, payload, content_hash, schema, assets_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      theme,
      device.id,
      meta.name,
      meta.description,
      canonicalPayload,
      hash,
      1,
      assetsStatus
    ),
  ];

  for (const source of sources) {
    const manifestItem = payload.assets.find((item) => item.kind === source.kind);
    statements.push(
      env.DB.prepare(
        `INSERT INTO assets (config_id, kind, r2_key, sha256, size, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`
      ).bind(id, source.kind, r2Key("pending", id, source.kind), manifestItem.sha256, manifestItem.size)
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

  // 200, not 201, for the same reason conflicts on /api/v1/me ride in the
  // body: the only client is the router's rpcd, which reaches the hub through
  // uclient-fetch. That tool reports any status other than 200 as a failed
  // request and hands the caller nothing -- so a 201 made a perfectly
  // successful publish surface in LuCI as "couldn't reach the theme store",
  // while the config really had been created. Verified on the device: the
  // duplicate path (200) succeeds, the fresh path (201) did not.
  return jsonResponse({ id, manage: true });
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
// #4 PUT /themes/:theme/configs/:id — author update
// #5 DELETE /themes/:theme/configs/:id — author removal
//
// Both share the same owner-authorization gate: load the config row first,
// then look up the device from its token (silent registration OFF), then
// check banned/ownership. Order matters — see requireOwnedConfig's own
// comment for the exact reasoning.
// ---------------------------------------------------------------------------

async function findDuplicateExcluding(db, theme, hash, excludeId) {
  return db
    .prepare("SELECT id FROM configs WHERE theme = ? AND content_hash = ? AND status = 'active' AND id != ?")
    .bind(theme, hash, excludeId)
    .first();
}

// Config existence is checked FIRST: the config's presence is not a secret
// worth protecting behind a uniform error code — it's already exposed by the
// public, unauthenticated GET detail endpoint (#2), so a 404-vs-403 split
// here reveals nothing an attacker couldn't already learn for free. Giving
// 404 priority instead lets a legitimate owner's client tell "this config is
// gone" apart from "your token is wrong," which matters more in practice.
// So: missing/removed/theme-mismatched row -> 404 not_found. Only once the
// config is confirmed to exist do we resolve the token -> device (silent
// registration OFF; unknown token -> 403 not_owner), then check banned-ness,
// then compare device ids (403 not_owner) last.
async function requireOwnedConfig(db, theme, id, deviceToken) {
  const row = await db
    .prepare("SELECT * FROM configs WHERE theme = ? AND id = ? AND status = 'active'")
    .bind(theme, id)
    .first();
  if (!row) {
    throw new HttpError(404, "not_found", "Config not found.");
  }

  const device = await deviceFromToken(db, deviceToken, { register: false });
  if (!device) {
    throw new HttpError(403, "not_owner", "Device is not the owner of this config.");
  }

  if (device.banned) {
    throw new HttpError(403, "device_banned", "This device has been banned.");
  }

  if (row.device_id !== device.id) {
    throw new HttpError(403, "not_owner", "Device is not the owner of this config.");
  }

  return row;
}

async function updateConfig(request, env, theme, id) {
  const body = await parseJsonBody(request);
  const row = await requireOwnedConfig(env.DB, theme, id, body.device_token);

  // Full replace: re-run the exact same metadata/payload/asset validation
  // pipeline as share (#3) — see reconcileAssets above.
  const meta = validateMeta({ name: body.name, description: body.description });
  const payload = validatePayload(body.payload);
  const resolvedAssets = await reconcileAssets(payload.assets, body.assets);

  return updateConfigWithAssets(env, {
    theme,
    row,
    meta,
    payload,
    sources: resolvedAssets.map((a) => bytesSource(a.kind, a.bytes, a.format)),
  });
}

// The whole second half of updateConfig, lifted out for the same reason
// insertConfigWithAssets was: drafts.js commits an update through here with
// sources whose bytes sit in R2, not in memory.
export async function updateConfigWithAssets(env, { theme, row, meta, payload, sources }) {
  const id = row.id;
  const canonicalPayload = canonicalJson(payload);
  const hash = await contentHash(payload);

  // Content-hash dedup against every OTHER active config (this row's own
  // current hash is excluded, so keeping the payload unchanged is a no-op
  // here, not a self-conflict).
  const dup = await findDuplicateExcluding(env.DB, theme, hash, id);
  if (dup) {
    throw new HttpError(409, "duplicate_content", "Another config already has this content.");
  }

  // Assets diff: for each kind in the new manifest, keep the existing row
  // as-is only if it was already 'approved' with the identical sha256;
  // otherwise upsert it to 'pending' with the new sha256/size and queue a
  // fresh R2 pending/ put. Kinds that existed before but are absent from the
  // new manifest are dropped entirely (row + both R2 states).
  const { results: existingAssetRows } = await env.DB
    .prepare("SELECT kind, sha256, size, status FROM assets WHERE config_id = ?")
    .bind(id)
    .all();
  const existingByKind = new Map(existingAssetRows.map((r) => [r.kind, r]));
  const newKinds = new Set(sources.map((a) => a.kind));

  const statements = [];
  const r2Puts = [];
  const r2Deletes = [];
  let anyPending = false;

  for (const source of sources) {
    const manifestItem = payload.assets.find((item) => item.kind === source.kind);
    const existing = existingByKind.get(source.kind);
    const kept = existing && existing.status === "approved" && existing.sha256 === manifestItem.sha256;

    if (kept) continue;

    anyPending = true;
    statements.push(
      env.DB.prepare(
        `INSERT INTO assets (config_id, kind, r2_key, sha256, size, status)
         VALUES (?, ?, ?, ?, ?, 'pending')
         ON CONFLICT(config_id, kind) DO UPDATE SET
           r2_key = excluded.r2_key, sha256 = excluded.sha256, size = excluded.size, status = 'pending'`
      ).bind(id, source.kind, r2Key("pending", id, source.kind), manifestItem.sha256, manifestItem.size)
    );
    r2Puts.push(source);
  }

  for (const [kind] of existingByKind) {
    if (!newKinds.has(kind)) {
      statements.push(env.DB.prepare("DELETE FROM assets WHERE config_id = ? AND kind = ?").bind(id, kind));
      r2Deletes.push(r2Key("pending", id, kind), r2Key("approved", id, kind));
    }
  }

  const assetsStatus = sources.length === 0 ? "none" : anyPending ? "pending" : "approved";
  const newVersion = row.version + 1;

  statements.push(
    env.DB.prepare(
      `UPDATE configs
         SET name = ?, description = ?, payload = ?, content_hash = ?,
             version = ?, assets_status = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).bind(meta.name, meta.description, canonicalPayload, hash, newVersion, assetsStatus, id)
  );

  // R2 puts happen before the D1 batch, same orphan-tolerant ordering as
  // share (#3): a failed batch leaves at most some unreferenced pending
  // bytes behind, never a D1 row pointing at bytes that don't exist.
  for (const source of r2Puts) {
    await source.writeTo(env, r2Key("pending", id, source.kind));
  }

  try {
    await env.DB.batch(statements);
  } catch (err) {
    // Race: another request committed the same (theme, content_hash) between
    // our SELECT and this UPDATE — idx_configs_dedup rejects the batch.
    const raced = await findDuplicateExcluding(env.DB, theme, hash, id);
    if (raced) {
      throw new HttpError(409, "duplicate_content", "Another config already has this content.");
    }
    throw err;
  }

  // R2 deletes for dropped kinds only happen after the D1 batch commits —
  // deleting first and then losing the batch would strand a still-approved
  // row pointing at bytes that no longer exist.
  for (const key of r2Deletes) {
    await env.R2.delete(key);
  }

  return jsonResponse({ id, version: newVersion });
}

async function deleteConfig(request, env, theme, id) {
  const body = await parseJsonBody(request, SMALL_BODY_BYTES);
  await requireOwnedConfig(env.DB, theme, id, body.device_token);

  // owner 自己删除 = 下架 + 销毁字节。走 purgeConfig 而不是只标 removed,
  // 是因为作者删掉自己的作品时没有留着字节的理由;而它必须盖上 purged_at,
  // 否则管理端会看到一条「已下架、资产还在」的配置并提供恢复,恢复出来却是
  // 一份没有字体和登录背景的空壳。
  //
  // status='removed' 释放了这一行在 idx_configs_dedup(建在 status='active'
  // 上的 partial unique index)里的 (theme, content_hash) 槽位,所以同样的
  // 内容之后可以重新分享而不撞 duplicate_content。
  // dl_dedup / reports 行一概不动 —— 已删配置的历史仍然有意义。
  await softTakedown(env, id);
  await purgeConfig(env, id);

  return jsonResponse({ id, removed: true });
}

export async function handleUpdateConfig(request, env, params) {
  try {
    return await updateConfig(request, env, params.theme, params.id);
  } catch (err) {
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.code, err.message);
    }
    console.error(err);
    return errorResponse(500, "internal_error", "Something went wrong.");
  }
}

export async function handleDeleteConfig(request, env, params) {
  try {
    return await deleteConfig(request, env, params.theme, params.id);
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
