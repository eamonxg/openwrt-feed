import { el } from "./app.js";

// 顶栏的四个数字同时是导航:点「待审 3」就是把配置列表切到 status=pending。
// 数字与列表筛选必须指向同一个谓词,后端的 /admin/stats 已按此实现。
//
// 「配置」这一档同理:stats.total_configs 在后端(admin-audit.js)按
// status='active' 计数,与 STATUS_CLAUSES.active 完全一致 —— 不含已下架、
// 更不含已永久删除的那些行。跳转目标必须是 status=active,而不是
// status=all,否则数字说 3、点进去却看到 5 条,比不给这个数字更糟。列表自
// 己的「全部」下拉选项仍然在,想看下架/删除的行从那里选。
export function renderStatsBar(container, stats, onJump) {
  container.replaceChildren(
    statButton("配置", stats.total_configs, () => onJump("configs", { status: "active" })),
    statButton("待审", stats.pending, () => onJump("configs", { status: "pending" }), stats.pending > 0),
    statButton("举报", stats.open_reports, () => onJump("reports", {}), stats.open_reports > 0),
    statButton("封禁", stats.banned_devices, () => onJump("devices", { banned: "yes" }))
  );
}

function statButton(label, value, onClick, alert = false) {
  const strong = el("strong", { text: String(value) });
  const button = el("button", { class: alert ? "alert" : "" }, [
    document.createTextNode(label + " "),
    strong,
  ]);
  button.addEventListener("click", onClick);
  return button;
}

// 四种状态一眼可分。purged 单列一档而不是并进 removed:一个还能恢复,
// 一个永远回不来,把它们画成同一个样子是在骗操作者。
export function statusBadge(item) {
  if (item.purged) return el("span", { class: "badge purged", text: "已删除" });
  if (item.status === "removed") return el("span", { class: "badge removed", text: "已下架" });
  if (item.assets_status === "pending") return el("span", { class: "badge pending", text: "待审" });
  return el("span", { class: "badge active", text: "上线中" });
}

// 行内只放一个最常用的动作,其余全在抽屉里 —— 一行摆五个按钮,每一个都
// 会被点错。
function primaryAction(item) {
  if (item.purged) return null;
  if (item.status === "removed") return { label: "恢复", action: "restore" };
  if (item.assets_status === "pending") return { label: "审核", action: "open" };
  return { label: "下架", action: "takedown" };
}

export function renderConfigList(container, items, handlers) {
  if (items.length === 0) {
    container.replaceChildren(el("div", { class: "empty", text: "没有符合条件的配置。" }));
    return;
  }

  const body = el("tbody");
  for (const item of items) {
    const swatch = el("div", { class: "swatch" });
    // 缩略色块取 payload 里的浅色主色,列表因此一眼能分辨风格,而不必为
    // 每一行去取一张图。
    swatch.style.background = item.colors?.light?.bg ?? "transparent";

    const nameCell = el("td", null, [
      el("div", { class: item.purged ? "name-purged" : "", text: item.name }),
      el("small", { class: "muted", text: item.id }),
    ]);

    const action = primaryAction(item);
    const actionCell = el("td");
    if (action) {
      const btn = el("button", { text: action.label });
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        handlers[action.action](item);
      });
      actionCell.append(btn);
    }

    const row = el("tr", null, [
      el("td", null, [swatch]),
      nameCell,
      el("td", { text: item.author || "—" }),
      el("td", null, [statusBadge(item)]),
      el("td", { text: String(item.downloads) }),
      el("td", { text: item.updated_at }),
      actionCell,
    ]);
    row.addEventListener("click", () => handlers.open(item));
    body.append(row);
  }

  const head = el("thead", null, [
    el("tr", null, [
      el("th", { text: "" }),
      el("th", { text: "名字" }),
      el("th", { text: "作者" }),
      el("th", { text: "状态" }),
      el("th", { text: "下载" }),
      el("th", { text: "更新" }),
      el("th", { text: "" }),
    ]),
  ]);

  container.replaceChildren(el("table", { class: "rows" }, [head, body]));
}

// 一个按钮加一个 stopPropagation:整行是「打开」,行内按钮是别的动作,少一次
// stopPropagation 就会在下架的同时把抽屉也弹出来。
function rowButton(label, onClick, options = {}) {
  const btn = el("button", { text: label });
  if (options.title) btn.setAttribute("title", options.title);
  if (options.disabled) btn.disabled = true;
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return btn;
}

function tableOf(headers, body, extraClass = "") {
  const head = el("thead", null, [el("tr", null, headers.map((text) => el("th", { text })))]);
  return el("table", { class: extraClass ? `rows ${extraClass}` : "rows" }, [head, body]);
}

// ---------------------------------------------------------------------------
// 创作者
// ---------------------------------------------------------------------------

// 一行就是一个人。分享数写成「在架 / 总共」而不是一个数字:封禁会把前者清成
// 0 而后者不动,两个数摆在一起,一眼看得出这个人是被下架过还是本来就没发过。
export function renderDeviceList(container, items, handlers) {
  if (items.length === 0) {
    container.replaceChildren(el("div", { class: "empty", text: "没有符合条件的创作者。" }));
    return;
  }

  const body = el("tbody");
  for (const item of items) {
    const action = item.banned
      ? rowButton("解封", () => handlers.unban(item))
      : rowButton("封禁", () => handlers.ban(item));

    const row = el("tr", null, [
      el("td", { text: item.nickname || "—" }),
      el("td", null, [el("code", { text: item.id })]),
      el("td", { text: `${item.configs_active} / ${item.configs_total}` }),
      el("td", { text: String(item.downloads_total) }),
      el("td", null, [
        item.banned
          ? el("span", { class: "badge purged", text: "已封禁" })
          : el("span", { class: "muted", text: "—" }),
      ]),
      el("td", null, [action]),
    ]);
    row.addEventListener("click", () => handlers.open(item));
    body.append(row);
  }

  container.replaceChildren(
    tableOf(["昵称", "device id", "分享", "下载", "封禁", ""], body)
  );
}

// 创作者详情。这一页存在的理由是封禁不该是一扇单向门:封禁前它说得出会连带
// 下架多少条,封禁后它把那些配置一条条摆出来,每条边上一个恢复 —— 解封只解
// 封禁本身,把作品放回去是在这里一次一个决定完成的。
export function renderDeviceDetail(container, detail, handlers) {
  const back = el("button", { text: "返回列表" });
  back.addEventListener("click", () => handlers.back());

  const banBtn = detail.banned
    ? el("button", { text: "解封" })
    : el("button", { class: "danger", text: "封禁" });
  banBtn.addEventListener("click", () => (detail.banned ? handlers.unban() : handlers.ban()));

  const clearBtn = el("button", { text: "清空昵称" });
  if (!detail.nickname) {
    // 没有昵称可清的时候点它只会写一条什么都没改的日志。留着按钮是为了让
    // 「可以这么做」看得见,禁用是为了让它不被白点一次。
    clearBtn.disabled = true;
    clearBtn.setAttribute("title", "这位创作者没有昵称");
  } else {
    clearBtn.addEventListener("click", () => handlers.clearNickname());
  }

  const header = el("header", { class: "detail-head" }, [
    el("div", { class: "detail-title" }, [
      el("h2", { text: detail.nickname || "(无昵称)" }),
      detail.banned ? el("span", { class: "badge purged", text: "已封禁" }) : null,
    ]),
    el("div", { class: "drawer-meta" }, [
      el("code", { text: detail.id }),
      el("span", { text: `注册于 ${detail.created_at}` }),
    ]),
    el("div", { class: "card-actions" }, [banBtn, clearBtn, back]),
  ]);

  container.replaceChildren(
    header,
    renderDeviceConfigs(detail, handlers),
    renderDeviceHistory(detail)
  );
}

// 不筛状态:被封禁级联下架的那些正是这一页最该显示的东西。
function detailConfigAction(config) {
  if (config.purged) return null;
  if (config.status === "removed") return { label: "恢复", action: "restore" };
  return { label: "下架", action: "takedown" };
}

function renderDeviceConfigs(detail, handlers) {
  const section = el("section", { class: "drawer-section" }, [
    el("h3", { text: `配置（${detail.configs.length}）` }),
  ]);

  if (detail.configs.length === 0) {
    section.append(el("div", { class: "empty", text: "这位创作者还没有分享过任何配置。" }));
    return section;
  }

  const body = el("tbody");
  for (const config of detail.configs) {
    const action = detailConfigAction(config);
    const row = el("tr", null, [
      el("td", null, [
        el("div", { class: config.purged ? "name-purged" : "", text: config.name }),
        el("small", { class: "muted", text: config.id }),
      ]),
      el("td", null, [statusBadge(config)]),
      el("td", { text: String(config.downloads) }),
      el("td", { text: config.updated_at }),
      el("td", null, [action ? rowButton(action.label, () => handlers[action.action](config)) : null]),
    ]);
    row.addEventListener("click", () => handlers.openConfig(config));
    body.append(row);
  }

  section.append(tableOf(["名字", "状态", "下载", "更新", ""], body));
  return section;
}

function renderDeviceHistory(detail) {
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
// 举报
// ---------------------------------------------------------------------------

// 被举报的配置已经不在了。列表端点用 LEFT JOIN 有意把这种行留着,所以这里
// 也画出来 —— 它是唯一能把这条举报从待办里清掉的地方。
function reportConfigBadge(item) {
  if (item.config_status === "missing") return el("span", { class: "badge purged", text: "已不存在" });
  return statusBadge({ purged: false, status: item.config_status, assets_status: item.assets_status });
}

export function renderReportList(container, items, handlers) {
  if (items.length === 0) {
    container.replaceChildren(el("div", { class: "empty", text: "没有待处理的举报。" }));
    return;
  }

  const body = el("tbody");
  for (const item of items) {
    const missing = item.config_status === "missing";

    // 配置没了就没有可看的、也没有可下架的。一个必然 404 的按钮比没有按钮
    // 更糟,所以这两个按钮在这里是禁用的,而结案照常 —— 待办里这条得能清掉。
    const view = rowButton("查看", () => handlers.view(item), {
      disabled: missing,
      title: missing ? "这份配置已经不存在了" : "",
    });
    // 已下架的配置同理:takedown 的闸门是 status = 'active',再点一次只会
    // 拿到 404,而那条举报还留在待办里。
    const takedownable = item.config_status === "active";
    const takedown = rowButton("下架并结案", () => handlers.takedownAndResolve(item), {
      disabled: !takedownable,
      title: missing ? "这份配置已经不存在了" : takedownable ? "" : "这份配置已经不在架上了",
    });
    const resolve = rowButton("仅结案", () => handlers.resolve(item));

    body.append(
      el("tr", null, [
        el("td", null, [
          el("div", { text: item.name || "(已不存在)" }),
          el("small", { class: "muted", text: item.config_id }),
        ]),
        el("td", null, [reportConfigBadge(item)]),
        el("td", { text: item.author || "—" }),
        el("td", { class: "report-reason", text: item.reason || "(未填理由)" }),
        el("td", { text: item.created_at }),
        el("td", null, [el("div", { class: "card-actions" }, [view, takedown, resolve])]),
      ])
    );
  }

  container.replaceChildren(tableOf(["配置", "状态", "作者", "理由", "时间", ""], body, "plain"));
}

// ---------------------------------------------------------------------------
// 操作日志
// ---------------------------------------------------------------------------

// target 一列是可点的:日志读到一半想知道「这条配置现在什么样」,不该退出去
// 再搜一遍 id。config 开抽屉,device 进创作者详情,其余(report)只是文本 ——
// 举报结案之后就没有一个页面还摆着它。
function logTarget(entry, handlers) {
  const cell = el("td", null, [el("small", { class: "muted", text: entry.target_type })]);
  if (!entry.target_id) return cell;

  if (entry.target_type === "config" || entry.target_type === "device") {
    const link = el("button", { class: "link", text: entry.target_id });
    link.addEventListener("click", () => {
      if (entry.target_type === "config") handlers.openConfig(entry.target_id);
      else handlers.openDevice(entry.target_id);
    });
    cell.append(link);
    return cell;
  }

  cell.append(el("code", { text: entry.target_id }));
  return cell;
}

export function renderLogList(container, items, handlers) {
  if (items.length === 0) {
    container.replaceChildren(el("div", { class: "empty", text: "还没有任何操作记录。" }));
    return;
  }

  const body = el("tbody");
  for (const entry of items) {
    body.append(
      el("tr", null, [
        el("td", { text: entry.created_at }),
        el("td", { text: entry.actor }),
        el("td", { class: "history-action", text: entry.action }),
        logTarget(entry, handlers),
        el("td", { class: "history-note", text: entry.note || "" }),
      ])
    );
  }

  container.replaceChildren(tableOf(["时间", "actor", "action", "target", "note"], body, "plain"));
}
