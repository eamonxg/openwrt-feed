// 操作日志的写入,以及读取(GET /admin/stats、GET /admin/log,Task 8 加入)。

import { HttpError, requireAdmin } from "./auth.js";
import { jsonResponse, errorResponse } from "./http.js";

// 日志写在动作成功之后,单独执行,失败只 console.error。
//
// 审计是辅助而不是业务约束:让它阻塞主流程,只会把「操作成功但日志写挂了」
// 变成「操作直接失败」,对操作者来说后者严格地更糟。
export async function logAction(env, actor, action, targetType, targetId, note = "") {
  try {
    await env.DB
      .prepare(
        `INSERT INTO admin_actions (actor, action, target_type, target_id, note)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(actor, action, targetType, targetId, note)
      .run();
  } catch (err) {
    console.error("admin_actions insert failed", err);
  }
}

function toErrorResponse(err) {
  if (err instanceof HttpError) {
    return errorResponse(err.status, err.code, err.message);
  }
  console.error(err);
  return errorResponse(500, "internal_error", "Something went wrong.");
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/stats — 顶栏那四个数字
// ---------------------------------------------------------------------------

// 四个标量一条 SQL。这些数字在页面上同时也是导航(点「待审 3」跳到
// status=pending),所以它们必须与列表端点的筛选条件字面一致 —— 数字说 3
// 而点进去看到 4 条,比没有这个数字更糟。
async function adminStats(request, env) {
  requireAdmin(request, env);

  const row = await env.DB
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM configs WHERE theme = 'aurora' AND status = 'active') AS total_configs,
         (SELECT COUNT(*) FROM configs
           WHERE theme = 'aurora' AND status = 'active' AND assets_status = 'pending') AS pending,
         (SELECT COUNT(*) FROM reports WHERE resolved = 0) AS open_reports,
         (SELECT COUNT(*) FROM devices WHERE banned = 1) AS banned_devices`
    )
    .first();

  return jsonResponse(row);
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/log
// ---------------------------------------------------------------------------

const LOG_PAGE_SIZE = 100;

async function listLog(request, env) {
  requireAdmin(request, env);

  const url = new URL(request.url);
  const n = Number(url.searchParams.get("page"));
  const page = Number.isInteger(n) && n >= 1 ? n : 1;

  const totalRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM admin_actions").first();

  const { results } = await env.DB
    .prepare(
      // ORDER BY 逐字对上 idx_admin_actions_recent (created_at DESC, id DESC),
      // 这个索引才用得上。单写 id DESC 时 id 就是 rowid,SQLite 会倒着扫主表
      // ——不需要排序,但每翻过一行都要读出整行(含 note 那段自由文本);走索
      // 引则只扫索引项,真正要返回的那 100 行才回表。翻到后面的页差别越大。
      // EXPLAIN QUERY PLAN 实测:前者 `SCAN admin_actions`,后者
      // `SCAN admin_actions USING INDEX idx_admin_actions_recent`。
      //
      // 顺序一个字节都没变:id 是 AUTOINCREMENT,created_at 是插入时的
      // datetime('now'),两者同向单调,所以 (created_at DESC, id DESC) 和
      // id DESC 排出来永远一致 —— 同一秒内的多条也一样,由 id DESC 兜底。
      `SELECT id, actor, action, target_type, target_id, note, created_at
         FROM admin_actions ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
    )
    .bind(LOG_PAGE_SIZE, (page - 1) * LOG_PAGE_SIZE)
    .all();

  return jsonResponse({ items: results, page, page_size: LOG_PAGE_SIZE, total: totalRow.n });
}

export async function handleStats(request, env) {
  try {
    return await adminStats(request, env);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function handleLogList(request, env) {
  try {
    return await listLog(request, env);
  } catch (err) {
    return toErrorResponse(err);
  }
}
