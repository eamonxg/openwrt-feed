// 创作者管理(设计文档 §6.4-§6.6)。devices 行就是创作者档案:id 是配置永远
// 指向的内部键,nickname 是可改的展示名。

import { HttpError, requireAdmin } from "./auth.js";
import { jsonResponse, errorResponse } from "./http.js";
import { logAction } from "./admin-audit.js";

function toErrorResponse(err) {
  if (err instanceof HttpError) {
    return errorResponse(err.status, err.code, err.message);
  }
  console.error(err);
  return errorResponse(500, "internal_error", "Something went wrong.");
}

const DEVICE_PAGE_SIZE = 50;

const BANNED_CLAUSES = {
  all: "1 = 1",
  yes: "d.banned = 1",
  no: "d.banned = 0",
};

function parsePage(url) {
  const n = Number(url.searchParams.get("page"));
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/devices
// ---------------------------------------------------------------------------

async function listDevices(request, env) {
  requireAdmin(request, env);

  const url = new URL(request.url);
  const page = parsePage(url);

  // Plain `TABLE[key] ?? TABLE.default` is not safe here: BANNED_CLAUSES is an
  // ordinary object literal, so a query parameter naming an inherited member
  // (?banned=constructor) resolves through the prototype chain to a Function
  // rather than undefined, and `??` does not fall back to a value that isn't
  // nullish. That non-string value would then get template-interpolated into
  // the SQL below. Object.hasOwn restricts the lookup to the table's own
  // keys, so any unrecognised value -- prototype member or not -- falls back
  // to the default. Same gotcha as admin-configs.js's STATUS_CLAUSES/SORTS.
  const bannedKey = url.searchParams.get("banned") ?? "all";
  const bannedClause = Object.hasOwn(BANNED_CLAUSES, bannedKey) ? BANNED_CLAUSES[bannedKey] : BANNED_CLAUSES.all;

  const q = (url.searchParams.get("q") ?? "").trim();
  const searchClause = q ? "AND (d.nickname LIKE ? OR d.id LIKE ?)" : "";
  const searchBinds = q ? [`%${q}%`, `%${q}%`] : [];

  const totalRow = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM devices d WHERE ${bannedClause} ${searchClause}`)
    .bind(...searchBinds)
    .first();

  // LEFT JOIN 是必需的:一个注册了但还没分享过任何配置的 device 也要出现,
  // 否则「这个 device id 到底是谁」在管理端无从查起。三个聚合值一次拿全,
  // 不做 per-row 查询。
  const { results } = await env.DB
    .prepare(
      `SELECT d.id, d.nickname, d.banned, d.created_at,
              COUNT(c.id) AS configs_total,
              SUM(CASE WHEN c.status = 'active' THEN 1 ELSE 0 END) AS configs_active,
              COALESCE(SUM(c.downloads), 0) AS downloads_total
         FROM devices d
         LEFT JOIN configs c ON c.device_id = d.id
        WHERE ${bannedClause} ${searchClause}
        GROUP BY d.id
        ORDER BY d.created_at DESC, d.id ASC
        LIMIT ? OFFSET ?`
    )
    .bind(...searchBinds, DEVICE_PAGE_SIZE, (page - 1) * DEVICE_PAGE_SIZE)
    .all();

  const items = results.map((row) => ({
    id: row.id,
    nickname: row.nickname ?? "",
    banned: row.banned === 1,
    created_at: row.created_at,
    configs_total: row.configs_total,
    // 没有任何配置时 SUM(CASE …) 返回 NULL,不是 0。
    configs_active: row.configs_active ?? 0,
    downloads_total: row.downloads_total,
  }));

  return jsonResponse({ items, page, page_size: DEVICE_PAGE_SIZE, total: totalRow.n });
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/devices/:id
// ---------------------------------------------------------------------------

async function deviceDetail(request, env, deviceId) {
  requireAdmin(request, env);

  const device = await env.DB
    .prepare("SELECT id, nickname, banned, created_at FROM devices WHERE id = ?")
    .bind(deviceId)
    .first();
  if (!device) {
    throw new HttpError(404, "not_found", "Device not found.");
  }

  // 不限状态:被封禁级联下架的那些配置正是这一页最需要显示的东西 —— 逐条
  // 恢复的入口就在这里。
  const { results: configs } = await env.DB
    .prepare(
      `SELECT id, name, status, assets_status, purged_at, downloads, created_at, updated_at
         FROM configs WHERE device_id = ? ORDER BY updated_at DESC, id ASC`
    )
    .bind(deviceId)
    .all();

  const { results: history } = await env.DB
    .prepare(
      `SELECT actor, action, note, created_at FROM admin_actions
        WHERE target_type = 'device' AND target_id = ? ORDER BY id DESC`
    )
    .bind(deviceId)
    .all();

  return jsonResponse({
    id: device.id,
    nickname: device.nickname ?? "",
    banned: device.banned === 1,
    created_at: device.created_at,
    configs: configs.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      assets_status: c.assets_status,
      purged: c.purged_at !== null,
      downloads: c.downloads,
      created_at: c.created_at,
      updated_at: c.updated_at,
    })),
    history,
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/admin/devices/:id/unban
// ---------------------------------------------------------------------------

async function unbanDevice(request, env, deviceId) {
  const actor = requireAdmin(request, env);

  const device = await env.DB.prepare("SELECT id FROM devices WHERE id = ?").bind(deviceId).first();
  if (!device) {
    throw new HttpError(404, "not_found", "Device not found.");
  }

  await env.DB.prepare("UPDATE devices SET banned = 0 WHERE id = ?").bind(deviceId).run();
  await logAction(env, actor, "unban", "device", deviceId);

  // 有意不自动恢复被级联下架的配置。创作者详情页已经列出他的全部配置,
  // 每行一个恢复按钮 —— 逐条恢复比一个猜不透的批量动作可控得多,尤其是
  // 封禁期间他可能又有别的配置因为别的原因被下架。
  return jsonResponse({ device_id: deviceId, banned: false });
}

// ---------------------------------------------------------------------------
// POST /api/v1/admin/devices/:id/nickname/clear
// ---------------------------------------------------------------------------

// 冒名或脏词的昵称影响这个作者的全部分享,但为此封号会连带下架一堆本来
// 没问题的作品。清空昵称是那两者之间的中间选项。
async function clearNickname(request, env, deviceId) {
  const actor = requireAdmin(request, env);

  const device = await env.DB
    .prepare("SELECT id, nickname FROM devices WHERE id = ?")
    .bind(deviceId)
    .first();
  if (!device) {
    throw new HttpError(404, "not_found", "Device not found.");
  }

  // nickname_lc 一并清空:idx_devices_nick 建在它上面,且是 WHERE
  // nickname_lc IS NOT NULL 的 partial index —— NULL 可以有任意多个,
  // 而这个名字随即可以被别人认领。
  await env.DB
    .prepare("UPDATE devices SET nickname = NULL, nickname_lc = NULL WHERE id = ?")
    .bind(deviceId)
    .run();

  await logAction(env, actor, "clear_nickname", "device", deviceId, `was "${device.nickname ?? ""}"`);

  return jsonResponse({ device_id: deviceId, nickname: "" });
}

// ---------------------------------------------------------------------------
// Exported route handlers
// ---------------------------------------------------------------------------

export async function handleDeviceList(request, env) {
  try {
    return await listDevices(request, env);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleDeviceDetail(request, env, params) {
  try {
    return await deviceDetail(request, env, params.id);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleUnbanDevice(request, env, params) {
  try {
    return await unbanDevice(request, env, params.id);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleClearNickname(request, env, params) {
  try {
    return await clearNickname(request, env, params.id);
  } catch (err) {
    return toErrorResponse(err);
  }
}
