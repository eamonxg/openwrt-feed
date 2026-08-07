import { apiFetchJson, el } from "./app.js";
import { statusBadge } from "./views.js";
import {
  bytesToBase64,
  sanitizeAsset,
  renderAssetPreview,
  fetchApprovedPreview,
  renderAlreadyApprovedPreview,
} from "./review.js";

// Mirrors APPROVE_FROM_R2_KINDS in src/assets.js — lifted verbatim from the
// standalone queue card this drawer replaces. These kinds are still fetched
// and previewed here, but their bytes never go back up: approve reads them
// from pending/ server-side. A full-coverage CJK woff2 is several MB, and
// base64ing two of them into the approve body is what used to push it past
// the cap.
//
// The two lists are kept honest by the wire format rather than by discipline:
// each entry declares which form it is using and approve rejects any
// disagreement, so a kind that gains a real sanitizer here but stays in this
// set fails immediately instead of silently approving unsanitized bytes.
const APPROVE_FROM_R2_KINDS = new Set(["font_sans", "font_mono"]);

let onChanged = () => {};
let onOpenDevice = () => {};
let currentId = null;

export function closeDrawer() {
  currentId = null;
  document.getElementById("drawer").hidden = true;
  document.getElementById("drawer-panel").replaceChildren();
}

// 抽屉而不是跳页:处理完一条直接关掉接着下一条,列表的滚动位置和筛选
// 条件都还在。这是审核连着做十条时唯一舒服的形状。
export function openDrawer(configId, callbacks = {}) {
  onChanged = callbacks.onChanged ?? (() => {});
  onOpenDevice = callbacks.onOpenDevice ?? (() => {});
  currentId = configId;

  const drawer = document.getElementById("drawer");
  const panel = document.getElementById("drawer-panel");
  drawer.hidden = false;
  panel.replaceChildren(el("div", { class: "empty", text: "加载中…" }));

  apiFetchJson(`/api/v1/admin/configs/${encodeURIComponent(configId)}`)
    .then((detail) => renderDrawer(panel, detail))
    .catch((err) => panel.replaceChildren(el("div", { class: "asset-tile state-error", text: String(err) })));
}

function renderDrawer(panel, detail) {
  // reports 这一节没有举报时返回 null,而 replaceChildren(null) 会把 null
  // 当成文本插进去 —— 过滤掉,别在页面上写一个 "null"。
  panel.replaceChildren(
    ...[
      renderHeader(detail),
      renderAssetSection(detail),
      renderReportSection(detail),
      renderActionSection(detail),
      renderHistorySection(detail),
    ].filter(Boolean)
  );
}

// 每个写动作成功后都走这里:抽屉自己重新拉一次详情重渲染,列表和顶栏各自
// 刷新。抽屉里刚改完名字而列表还写着旧名字,下一次点击就点错了行;顶栏的
// 数字同时是导航,停在旧值上等于让下一次点击跳到一个对不上的筛选。
async function afterWrite() {
  const panel = document.getElementById("drawer-panel");
  const id = currentId;
  try {
    const detail = await apiFetchJson(`/api/v1/admin/configs/${encodeURIComponent(id)}`);
    // 期间抽屉被关掉或换了一条,就不要把旧的内容画回去。
    if (currentId === id) renderDrawer(panel, detail);
  } catch (err) {
    if (currentId === id) panel.replaceChildren(el("div", { class: "asset-tile state-error", text: String(err) }));
  }
  onChanged();
}

function fail(what, err) {
  alert(what + "失败:" + (err.message || err));
}

// ---------------------------------------------------------------------------
// 头部:名字(就地改名)、id、作者、状态、关闭
// ---------------------------------------------------------------------------

function renderHeader(detail) {
  const close = el("button", { class: "drawer-close", text: "关闭" });
  close.addEventListener("click", closeDrawer);

  const author = el("button", { class: "link", text: detail.author || "(无昵称)" });
  author.setAttribute("title", "查看这位创作者");
  author.addEventListener("click", () => onOpenDevice(detail.author_id));

  const meta = el("div", { class: "drawer-meta" }, [
    el("code", { text: detail.id }),
    el("span", { text: "作者" }),
    author,
    detail.author_banned ? el("span", { class: "badge purged", text: "已封禁" }) : null,
    el("span", { text: `下载 ${detail.downloads}` }),
    el("span", { text: `更新 ${detail.updated_at}` }),
  ]);

  return el("header", { class: "drawer-head" }, [
    el("div", { class: "drawer-title" }, [renderName(detail), statusBadge(detail), close]),
    meta,
  ]);
}

// 改名是「整条下架」之外唯一的中间选项,所以它得像编辑一句话一样轻:点标题
// 就地变输入框,回车或失焦提交,Esc 放弃。
function renderName(detail) {
  const holder = el("h2", { class: "drawer-name" });
  const button = el("button", { class: "name-button", text: detail.name || "(未命名)" });
  button.setAttribute("title", "点击改名");
  button.addEventListener("click", startEdit);
  holder.append(button);

  function startEdit() {
    const input = el("input", { type: "text" });
    input.value = detail.name;
    holder.replaceChildren(input);
    input.focus();
    input.select();

    // 三条出口(回车 / 失焦 / Esc)会互相触发 —— Esc 之后浏览器还会再发一次
    // blur,提交成功后重渲染又会把这个 input 摘掉。settled 保证只走一次。
    let settled = false;
    const restore = () => {
      settled = true;
      holder.replaceChildren(button);
    };
    const commit = async () => {
      if (settled) return;
      const name = input.value.trim();
      if (!name || name === detail.name) {
        restore();
        return;
      }
      settled = true;
      input.disabled = true;
      try {
        await apiFetchJson(`/api/v1/admin/configs/${encodeURIComponent(detail.id)}/edit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
      } catch (err) {
        fail("改名", err);
        holder.replaceChildren(button);
        return;
      }
      await afterWrite();
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        if (!settled) restore();
      }
    });
    input.addEventListener("blur", commit);
  }

  return holder;
}

// ---------------------------------------------------------------------------
// 资产:预览 + 批准/驳回。就是原来那张审核卡片,只是从任意一条配置都能进来。
// ---------------------------------------------------------------------------

function renderAssetSection(detail) {
  const section = el("section", { class: "drawer-section" }, [el("h3", { text: "资产" })]);

  // 字节已经销毁,这里一个请求都不该发:/admin/assets 对它只会回 404,而
  // 满屏红色的失败提示会读成「系统坏了」,而不是「这本来就没了」。
  if (detail.purged) {
    section.append(el("div", { class: "empty", text: "资产已永久删除。" }));
    return section;
  }
  if (detail.assets.length === 0) {
    section.append(el("div", { class: "empty", text: "这份配置没有任何资产。" }));
    return section;
  }

  const grid = el("div", { class: "asset-grid" });
  section.append(grid);

  // 一份配置可能同时处在 approved+pending 的混合状态:owner 的 PUT 可以让
  // 一个 kind 的 sha256 原样不动(还是 approved),同时换掉另一个(重新变回
  // pending)。只有 pending 的那些参与消毒并进 approve 的请求体 —— 后端会
  // 拒绝一个包含已批准 kind 的请求体,而那些字节这边也没什么可再消毒的。
  // 已批准的 kind 仍然取回来展示,只是画成一张「已批准」的预览。
  const pendingAssets = detail.assets.filter((a) => a.status !== "approved");
  const results = {};

  const tiles = new Map();
  for (const asset of detail.assets) {
    const tile = el("div", { class: "asset-tile" }, [el("span", { class: "kind", text: asset.kind })]);
    grid.append(tile);
    tiles.set(asset.kind, tile);
  }

  // 待审 = 在架上且资产未过审,和后端 approve/reject 的闸门(admin.js:
  // `status = 'active' AND assets_status = 'pending'`)以及列表的 pending
  // 筛选是同一个谓词。一条已下架但资产还挂着 pending 的配置照样把预览摆
  // 出来(/admin/assets 有意对已下架的配置也放行),但不给这两个按钮 ——
  // 那个状态下点它们只会拿到 409 not_pending,一个必然失败的按钮比没有
  // 按钮更糟。要先恢复,才谈得上审。
  const reviewable = detail.status === "active" && detail.assets_status === "pending";

  let approveBtn = null;
  if (reviewable) {
    approveBtn = el("button", { class: "primary", text: "批准全部" });
    approveBtn.disabled = true;
    const rejectBtn = el("button", { text: "驳回全部" });
    section.append(el("div", { class: "card-actions" }, [approveBtn, rejectBtn]));

    approveBtn.addEventListener("click", async () => {
      if (!confirm(`按预览里消毒后的字节批准「${detail.name}」?`)) return;
      approveBtn.disabled = true;
      try {
        // 两种形式必须与后端的 APPROVE_FROM_R2_KINDS 一致:passthrough 的
        // kind 由 Worker 自己从 pending/ 读,其余才把消毒后的字节发上去。
        // 后端拒绝任何不一致,所以搞错这里会在批准时立刻炸,而不是悄悄放行
        // 一份没消毒的字节。
        const body = {
          assets: pendingAssets.map((a) =>
            APPROVE_FROM_R2_KINDS.has(a.kind)
              ? { kind: a.kind, passthrough: true }
              : { kind: a.kind, data_b64: bytesToBase64(results[a.kind].bytes) }
          ),
        };
        await apiFetchJson(`/api/v1/admin/configs/${encodeURIComponent(detail.id)}/approve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (err) {
        fail("批准", err);
        approveBtn.disabled = false;
        return;
      }
      await afterWrite();
    });

    rejectBtn.addEventListener("click", async () => {
      if (!confirm(`驳回「${detail.name}」的待审资产?`)) return;
      rejectBtn.disabled = true;
      try {
        await apiFetchJson(`/api/v1/admin/configs/${encodeURIComponent(detail.id)}/reject`, {
          method: "POST",
        });
      } catch (err) {
        fail("驳回", err);
        rejectBtn.disabled = false;
        return;
      }
      await afterWrite();
    });
  }

  // 取字节、消毒、画预览都是异步的,但这一节得先交出去 —— 抽屉的其余部分
  // 不该等一张 8 MB 的字体。逐个而不是并发:六个 kind 同时抢带宽只会让每
  // 一张预览都来得更晚。
  (async () => {
    for (const asset of detail.assets) {
      const tile = tiles.get(asset.kind);
      const line = el("div", {
        class: "state-pending",
        text: asset.status === "approved" ? "载入预览…" : "消毒中…",
      });
      tile.append(line);

      if (asset.status === "approved") {
        // eslint-disable-next-line no-await-in-loop
        const preview = await fetchApprovedPreview(detail.id, asset.kind);
        line.remove();
        renderAlreadyApprovedPreview(tile, asset.kind, preview);
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const result = await sanitizeAsset(detail.id, asset.kind);
      results[asset.kind] = result;
      line.remove();
      renderAssetPreview(tile, asset.kind, result);
    }

    // 有一个 kind 消不干净就不给批准 —— 批准的语义是「我看过这些字节」,
    // 一张画不出来的预览等于没看过。
    if (approveBtn) {
      approveBtn.disabled = !pendingAssets.every((a) => results[a.kind] && results[a.kind].ok);
    }
  })();

  return section;
}

// ---------------------------------------------------------------------------
// 举报:未处理的在上并各带一个结案按钮,已结案的折叠成一行计数
// ---------------------------------------------------------------------------

function renderReportSection(detail) {
  // 从没被举报过的配置不需要一节空白告诉你这件事。
  if (!detail.reports || detail.reports.length === 0) return null;

  const open = detail.reports.filter((r) => !r.resolved);
  const resolved = detail.reports.filter((r) => r.resolved);

  const section = el("section", { class: "drawer-section" }, [
    el("h3", { text: `举报（未处理 ${open.length}）` }),
  ]);

  if (open.length > 0) {
    const list = el("ul", { class: "report-list" });
    for (const report of open) {
      const btn = el("button", { text: "结案" });
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await apiFetchJson(`/api/v1/admin/reports/${encodeURIComponent(report.id)}/resolve`, {
            method: "POST",
          });
        } catch (err) {
          fail("结案", err);
          btn.disabled = false;
          return;
        }
        await afterWrite();
      });
      list.append(
        el("li", null, [
          el("div", { class: "report-reason", text: report.reason || "(未填理由)" }),
          el("div", { class: "muted", text: report.created_at }),
          btn,
        ])
      );
    }
    section.append(list);
  }

  // 已结案的只留一个数字:处理新举报时「这份配置以前被举报过几次」是有用的
  // 上下文,但把十条已经处理完的理由再摊开一遍,只会把待办埋进历史里。
  if (resolved.length > 0) {
    section.append(el("div", { class: "empty", text: `另有 ${resolved.length} 条已结案。` }));
  }

  return section;
}

// ---------------------------------------------------------------------------
// 动作:按状态给按钮
// ---------------------------------------------------------------------------

function renderActionSection(detail) {
  const section = el("section", { class: "drawer-section" }, [el("h3", { text: "动作" })]);

  // 已经永久删除过了:没有一个动作还说得通,所以一个按钮都不给,只留一句
  // 「什么时候没的」。
  if (detail.purged) {
    section.append(el("div", { class: "empty", text: `已永久删除于 ${detail.purged_at ?? "未知时间"}。` }));
    return section;
  }

  const actions = el("div", { class: "card-actions" });
  section.append(actions);

  const post = async (path, what) => {
    try {
      await apiFetchJson(`/api/v1/admin${path}`, { method: "POST" });
    } catch (err) {
      fail(what, err);
      return;
    }
    await afterWrite();
  };

  if (detail.status === "active") {
    const btn = el("button", { text: "下架" });
    btn.addEventListener("click", () => {
      // 下架只是可逆的一步,普通 confirm() 够用。
      if (!confirm(`下架「${detail.name}」?字节都还在,随时可以恢复。`)) return;
      post(`/configs/${encodeURIComponent(detail.id)}/takedown`, "下架");
    });
    actions.append(btn);
    // 在架上的配置拿不到永久删除,那是有意的 —— 不可逆的销毁前面必须隔着
    // 一步可逆的操作。但界面此前没有任何地方说出这件事,于是「怎么删除」
    // 看上去像个缺失的功能而不是一道闸。这句话就是那道闸的说明。
    section.append(el("div", { class: "empty", text: "永久删除需先下架:下架后重新打开这份配置,动作区会多出「永久删除」。" }));
    return section;
  }

  const restoreBtn = el("button", { text: "恢复" });
  restoreBtn.addEventListener("click", () => {
    if (!confirm(`恢复「${detail.name}」?它会重新出现在列表里。`)) return;
    post(`/configs/${encodeURIComponent(detail.id)}/restore`, "恢复");
  });

  const purgeBtn = el("button", { class: "danger", text: "永久删除" });
  purgeBtn.addEventListener("click", async () => {
    const answer = await confirmDestructive({
      title: "永久删除这份配置",
      detail: `「${detail.name}」的资产字节会被立刻销毁,此后连恢复都不再可能。`,
      expected: detail.id,
      confirmLabel: "永久删除",
    });
    if (!answer) return;
    try {
      await apiFetchJson(`/api/v1/admin/configs/${encodeURIComponent(detail.id)}/purge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: answer.reason }),
      });
    } catch (err) {
      fail("永久删除", err);
      return;
    }
    await afterWrite();
  });

  actions.append(restoreBtn, purgeBtn);
  return section;
}

// ---------------------------------------------------------------------------
// 操作记录
// ---------------------------------------------------------------------------

function renderHistorySection(detail) {
  const section = el("section", { class: "drawer-section" }, [el("h3", { text: "操作记录" })]);

  if (!detail.history || detail.history.length === 0) {
    section.append(el("div", { class: "empty", text: "暂无操作记录。" }));
    return section;
  }

  const list = el("ul", { class: "history-list" });
  for (const entry of detail.history) {
    list.append(
      el("li", null, [
        el("span", { class: "history-actor", text: entry.actor }),
        el("span", { class: "history-action", text: entry.action }),
        el("span", { class: "history-note", text: entry.note || "" }),
        el("span", { class: "muted", text: entry.created_at }),
      ])
    );
  }
  section.append(list);
  return section;
}

// ---------------------------------------------------------------------------
// 危险确认
// ---------------------------------------------------------------------------

// 永久删除和封禁走这个,不走 confirm()。要求手抄一遍 id 是有意的摩擦:
// 这两个动作一个销毁字节、一个连带下架某人的全部作品,而 confirm() 的
// 「确定」按钮和「保存」的手感完全一样。
export function confirmDestructive({ title, detail, expected, confirmLabel }) {
  return new Promise((resolve) => {
    const input = el("input", { type: "text", placeholder: expected });
    // 500 字的上限不是排版,是后端那条 readJsonBounded(request, 2048) 的余量:
    // 请求体超出 2048 字节时它读失败,而 purge / ban 都把这个失败吞掉当作
    // 「没带理由」—— 于是一段长理由会静默变成一条空的审计记录。500 个汉字按
    // UTF-8 是 1500 字节，加上 JSON 外壳仍稳稳在闸门以内。
    const reason = el("input", {
      type: "text",
      maxlength: "500",
      placeholder: "理由（可选，会记进操作日志）",
    });
    const ok = el("button", { class: "danger", text: confirmLabel });
    ok.disabled = true;
    input.addEventListener("input", () => {
      ok.disabled = input.value.trim() !== expected;
    });

    const cancel = el("button", { text: "取消" });
    const scrim = el("div", { class: "drawer-scrim" });
    const box = el("div", { class: "confirm-box" }, [
      el("h3", { text: title }),
      el("p", { text: detail }),
      el("p", { class: "muted", text: `输入 ${expected} 以确认：` }),
      input,
      reason,
      el("div", { class: "card-actions" }, [cancel, ok]),
    ]);
    const modal = el("div", { class: "drawer" }, [scrim, box]);
    document.body.append(modal);
    input.focus();

    const done = (value) => {
      modal.remove();
      resolve(value);
    };
    cancel.addEventListener("click", () => done(null));
    scrim.addEventListener("click", () => done(null));
    ok.addEventListener("click", () => done({ reason: reason.value.trim() }));
  });
}
