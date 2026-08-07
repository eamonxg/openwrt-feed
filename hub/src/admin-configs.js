// 配置的管理动作(设计文档 §3、§6.1-§6.3):恢复、永久删除,以及后续 Task 里
// 加进来的全量列表、详情和改名。每个 handler 第一步都调 requireAdmin。

import { HttpError, requireAdmin } from "./auth.js";
import { logAction } from "./admin-audit.js";
import { jsonResponse, errorResponse, readJsonBounded, readOptionalReason } from "./http.js";
import { purgeConfig } from "./lifecycle.js";
import { extractColors } from "./configs.js";
import { validateMeta } from "./validate.js";

function toErrorResponse(err) {
  if (err instanceof HttpError) {
    return errorResponse(err.status, err.code, err.message);
  }
  console.error(err);
  return errorResponse(500, "internal_error", "Something went wrong.");
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/configs
// ---------------------------------------------------------------------------

const ADMIN_PAGE_SIZE = 50;

// ORDER BY 子句永远取自这张表,绝不由用户输入拼接。
const SORTS = {
  updated: "c.updated_at DESC, c.id ASC",
  new: "c.created_at DESC, c.id ASC",
  downloads: "c.downloads DESC, c.id ASC",
};

// 同样是白名单,同样绝不拼接用户输入。
const STATUS_CLAUSES = {
  all: "1 = 1",
  active: "c.status = 'active'",
  // 现有待审队列的等价条件。审核从此只是列表的一个视图,不是独立页面。
  pending: "c.status = 'active' AND c.assets_status = 'pending'",
  removed: "c.status = 'removed'",
  reported: "EXISTS (SELECT 1 FROM reports r WHERE r.config_id = c.id AND r.resolved = 0)",
};

function parseAdminPage(url) {
  const n = Number(url.searchParams.get("page"));
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

async function listAllConfigs(request, env) {
  requireAdmin(request, env);

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "all";
  const sort = url.searchParams.get("sort") ?? "updated";
  const page = parseAdminPage(url);

  // Plain `TABLE[key] ?? TABLE.default` is not safe here: these are ordinary
  // object literals, so a query parameter naming an inherited member
  // (?status=constructor, ?sort=toString, ...) resolves through the
  // prototype chain to a Function/Object rather than undefined, and `??`
  // does not fall back to a value that isn't nullish. That non-string value
  // would then get template-interpolated into the SQL below. Object.hasOwn
  // restricts the lookup to the table's own keys, so any unrecognised value
  // -- prototype member or not -- falls back to the default.
  const statusClause = Object.hasOwn(STATUS_CLAUSES, status) ? STATUS_CLAUSES[status] : STATUS_CLAUSES.all;
  const orderBy = Object.hasOwn(SORTS, sort) ? SORTS[sort] : SORTS.updated;

  const q = (url.searchParams.get("q") ?? "").trim();
  // LIKE 全表扫,不上 FTS5:几千行以内 D1 扛得住,而 FTS5 要维护同步触发器。
  // 三个字段各绑一次同样的模式 —— D1 的 prepare 不做具名参数复用。
  const searchClause = q ? "AND (c.name LIKE ? OR c.id LIKE ? OR d.nickname LIKE ?)" : "";
  const searchBinds = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];

  // 管理端与前台列表在这里有意分道:前台用「多取一行判断 has_more」躲开
  // COUNT(*),因为它每台路由器都在打。这个端点只有一个人在用,而一张管理
  // 表格里「142 条、第 2/3 页」是实打实的信息,一次 COUNT 换得起。
  const totalRow = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n
         FROM configs c
         JOIN devices d ON d.id = c.device_id
        WHERE c.theme = ? AND ${statusClause} ${searchClause}`
    )
    .bind("aurora", ...searchBinds)
    .first();

  // GROUP_CONCAT + LEFT JOIN,与前台列表(configs.js:286)同一个套路:一页
  // 50 行否则就是 51 次往返。approved 谓词写在 JOIN 条件里而非 WHERE,
  // 放 WHERE 会把 LEFT JOIN 变回内连接,悄悄吞掉所有没有资产的配置。
  const { results } = await env.DB
    .prepare(
      `SELECT c.id, c.name, c.status, c.assets_status, c.purged_at, c.downloads,
              c.created_at, c.updated_at, c.payload, c.device_id,
              d.nickname AS author,
              GROUP_CONCAT(a.kind) AS approved_kinds,
              (SELECT COUNT(*) FROM reports r WHERE r.config_id = c.id AND r.resolved = 0) AS open_reports
         FROM configs c
         JOIN devices d ON d.id = c.device_id
         LEFT JOIN assets a ON a.config_id = c.id AND a.status = 'approved'
        WHERE c.theme = ? AND ${statusClause} ${searchClause}
        GROUP BY c.id
        ORDER BY ${orderBy}
        LIMIT ? OFFSET ?`
    )
    .bind("aurora", ...searchBinds, ADMIN_PAGE_SIZE, (page - 1) * ADMIN_PAGE_SIZE)
    .all();

  const items = results.map((row) => ({
    id: row.id,
    name: row.name,
    author: row.author ?? "",
    device_id: row.device_id,
    status: row.status,
    assets_status: row.assets_status,
    purged: row.purged_at !== null,
    downloads: row.downloads,
    created_at: row.created_at,
    updated_at: row.updated_at,
    asset_kinds: row.approved_kinds ? row.approved_kinds.split(",").sort() : [],
    colors: extractColors(JSON.parse(row.payload)),
    open_reports: row.open_reports,
  }));

  return jsonResponse({ items, page, page_size: ADMIN_PAGE_SIZE, total: totalRow.n });
}

// ---------------------------------------------------------------------------
// POST /api/v1/admin/configs/:id/restore
// ---------------------------------------------------------------------------

async function restoreConfig(request, env, id) {
  const actor = requireAdmin(request, env);

  const config = await env.DB
    .prepare("SELECT id, theme, content_hash, purged_at FROM configs WHERE id = ? AND status = 'removed'")
    .bind(id)
    .first();
  if (!config) {
    throw new HttpError(409, "not_removed", "Config is not taken down.");
  }
  // 字节已经销毁,恢复只能造出一份没有字体和登录背景的空壳。宁可在这里
  // 明确拒绝,也不要交出一个看起来成功、用起来残缺的结果。
  if (config.purged_at) {
    throw new HttpError(409, "purged", "Config was permanently deleted; its assets are gone.");
  }

  // 下架释放了这一行在 idx_configs_dedup(建在 status='active' 上的 partial
  // unique index)里的槽位,别人可能已经用同样的内容重新分享过。
  const clash = await env.DB
    .prepare("SELECT id FROM configs WHERE theme = ? AND content_hash = ? AND status = 'active'")
    .bind(config.theme, config.content_hash)
    .first();
  if (clash) {
    throw new HttpError(409, "duplicate_content", `The same content is already live as ${clash.id}.`);
  }

  try {
    // removed_by 跟着回到 NULL:它描述的是「这一次下架是谁干的」,配置一旦
    // 重新上架,那次下架就结束了。留着它,下一次 owner 自己删除之前,这一行
    // 会一直带着 'admin' 的旧答案。
    await env.DB
      .prepare(
        "UPDATE configs SET status = 'active', removed_by = NULL, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(id)
      .run();
  } catch (err) {
    // 竞态:上面 SELECT 之后、这条 UPDATE 之前有人提交了同样的内容,索引
    // 挡下了它。重新查一次给出同样的 409,而不是把原始约束错误抛出去。
    // 与 configs.js:459 的写法一致。
    const raced = await env.DB
      .prepare("SELECT id FROM configs WHERE theme = ? AND content_hash = ? AND status = 'active'")
      .bind(config.theme, config.content_hash)
      .first();
    if (raced) {
      throw new HttpError(409, "duplicate_content", `The same content is already live as ${raced.id}.`);
    }
    throw err;
  }

  await logAction(env, actor, "restore", "config", id);

  return jsonResponse({ id, restored: true });
}

// ---------------------------------------------------------------------------
// POST /api/v1/admin/configs/:id/purge
// ---------------------------------------------------------------------------

async function purgeConfigEndpoint(request, env, id) {
  const actor = requireAdmin(request, env);

  // 管理台的危险确认框里可以顺手写一句理由,它是这个动作在日志里唯一的
  // 自由文本 —— 「谁在什么时候删了什么」表结构里都有,「为什么」只能靠它。
  // 不发 body 依然合法(见 readOptionalReason):理由是可选的注解,不是这个
  // 动作的输入。
  const reason = await readOptionalReason(request);

  // 只允许对已下架的配置执行。要求先下架再永久删除,意味着任何一次不可逆的
  // 销毁前面都隔着一步可逆的操作 —— 没有一条路径能一键从「在架上」直达
  // 「字节没了」。
  const row = await env.DB
    .prepare("SELECT id, purged_at FROM configs WHERE id = ? AND status = 'removed'")
    .bind(id)
    .first();
  if (!row) {
    throw new HttpError(409, "not_removed", "Only a taken-down config can be permanently deleted.");
  }
  // 幂等:已经销毁过就直接回成功。重复点击不该报错,也不该再跑一遍 R2 删除。
  if (row.purged_at) {
    return jsonResponse({ id, purged: true });
  }

  await purgeConfig(env, id);
  await logAction(env, actor, "purge", "config", id, reason);

  return jsonResponse({ id, purged: true });
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/configs/:id
// ---------------------------------------------------------------------------

// 不限状态:管理端必须能看已下架的那条,否则「下架之后想确认自己下掉了
// 什么」就无处可去。前台的详情端点仍然只认 active,那道闸不在这里。
async function adminConfigDetail(request, env, id) {
  requireAdmin(request, env);

  const row = await env.DB
    .prepare(
      `SELECT c.*, d.id AS author_id, d.nickname AS author, d.banned AS author_banned
         FROM configs c
         JOIN devices d ON d.id = c.device_id
        WHERE c.id = ?`
    )
    .bind(id)
    .first();
  if (!row) {
    throw new HttpError(404, "not_found", "Config not found.");
  }

  const { results: assets } = await env.DB
    .prepare("SELECT kind, sha256, size, status FROM assets WHERE config_id = ? ORDER BY kind")
    .bind(id)
    .all();

  // 已结案的举报也一并返回:处理一条新举报时,「这份配置以前被举报过几次」
  // 正是最该看见的上下文。
  const { results: reports } = await env.DB
    .prepare("SELECT id, reason, resolved, created_at FROM reports WHERE config_id = ? ORDER BY id DESC")
    .bind(id)
    .all();

  const { results: history } = await env.DB
    .prepare(
      `SELECT actor, action, note, created_at FROM admin_actions
        WHERE target_type = 'config' AND target_id = ?
        ORDER BY id DESC`
    )
    .bind(id)
    .all();

  return jsonResponse({
    id: row.id,
    name: row.name,
    description: row.description,
    author: row.author ?? "",
    author_id: row.author_id,
    author_banned: row.author_banned === 1,
    status: row.status,
    assets_status: row.assets_status,
    purged: row.purged_at !== null,
    // 详情抽屉要写「已永久删除于 X」,光有布尔位说不出这句话。列表端点只按
    // 状态分档显示,所以那边仍然只给布尔位。
    purged_at: row.purged_at,
    downloads: row.downloads,
    schema: row.schema,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    payload: JSON.parse(row.payload),
    assets,
    reports,
    history,
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/admin/configs/:id/edit
// ---------------------------------------------------------------------------

const EDIT_BODY_BYTES = 8 * 1024;

// 名字/描述只存在 configs 的列里,payload 里没有副本,而 contentHash 只对
// payload 求值(configs.js:412)。所以改名是一条纯 UPDATE:不动 payload、
// 不重算 hash、不可能撞 idx_configs_dedup。
//
// 这是「脏词 → 整条下架」之外唯一的中间选项。
async function editConfig(request, env, id) {
  const actor = requireAdmin(request, env);

  const body = await readJsonBounded(request, EDIT_BODY_BYTES);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "bad_json", "Request body must be a JSON object.");
  }

  const wantsName = typeof body.name === "string";
  const wantsDescription = typeof body.description === "string";
  if (!wantsName && !wantsDescription) {
    throw new HttpError(400, "bad_request", "Provide name and/or description.");
  }

  const row = await env.DB.prepare("SELECT name, description FROM configs WHERE id = ?").bind(id).first();
  if (!row) {
    throw new HttpError(404, "not_found", "Config not found.");
  }

  // 复用分享时那一套校验,长度和字符清洗因此不会两边不一致。validateMeta
  // 要求两个字段都在,所以未修改的那个用当前值补齐。
  const cleaned = validateMeta({
    name: wantsName ? body.name : row.name,
    description: wantsDescription ? body.description : row.description,
  });

  await env.DB
    .prepare("UPDATE configs SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(cleaned.name, cleaned.description, id)
    .run();

  // note 存人能读懂的一句话,不存 JSON:日志只用于回溯「谁干了什么」,不做
  // 结构化查询。描述只记「改过」,不存全文 —— 那会把日志表撑成第二份内容库。
  const parts = [];
  if (wantsName && cleaned.name !== row.name) parts.push(`name "${row.name}" -> "${cleaned.name}"`);
  if (wantsDescription && cleaned.description !== row.description) parts.push("description edited");
  await logAction(env, actor, "edit", "config", id, parts.join("; "));

  return jsonResponse({ id, name: cleaned.name, description: cleaned.description });
}

// ---------------------------------------------------------------------------
// Exported route handlers
// ---------------------------------------------------------------------------

export async function handleRestore(request, env, params) {
  try {
    return await restoreConfig(request, env, params.id);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handlePurge(request, env, params) {
  try {
    return await purgeConfigEndpoint(request, env, params.id);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleAdminList(request, env) {
  try {
    return await listAllConfigs(request, env);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleAdminDetail(request, env, params) {
  try {
    return await adminConfigDetail(request, env, params.id);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleEdit(request, env, params) {
  try {
    return await editConfig(request, env, params.id);
  } catch (err) {
    return toErrorResponse(err);
  }
}
