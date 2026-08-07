import {
  renderConfigList,
  renderDeviceDetail,
  renderDeviceList,
  renderLogList,
  renderReportList,
  renderStatsBar,
} from "./views.js";
import { closeDrawer, confirmDestructive, openDrawer } from "./drawer.js";

"use strict";

// -----------------------------------------------------------------------------
// Auth / session
// -----------------------------------------------------------------------------

// index.html's inline bootstrap reads this same key to pick a screen before
// any module loads, so the literal exists in two places. pages.test.js fails
// if they drift.
const TOKEN_KEY = "aurora_hub_admin_token";

export function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}
export function setToken(token) {
  sessionStorage.setItem(TOKEN_KEY, token);
}
export function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

function showLogin(message) {
  document.getElementById("app-view").hidden = true;
  document.getElementById("login-view").hidden = false;
  document.getElementById("login-error").textContent = message || "";
}
function showApp() {
  document.getElementById("login-view").hidden = true;
  document.getElementById("app-view").hidden = false;
}

// Every authenticated call goes through here: attaches the Bearer token and
// uniformly reacts to 401 by clearing the (bad) token and dropping back to
// the login screen, per the functional contract.
export async function apiFetch(path, options) {
  const token = getToken();
  if (!token) {
    showLogin("");
    throw new Error("Not signed in.");
  }
  const opts = options || {};
  const headers = Object.assign({}, opts.headers, { Authorization: "Bearer " + token });
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401) {
    clearToken();
    showLogin("Session expired or invalid token — please sign in again.");
    throw new Error("Unauthorized.");
  }
  return res;
}

export async function apiFetchJson(path, options) {
  const res = await apiFetch(path, options);
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (body && body.error && body.error.message) || ("Request failed (" + res.status + ").");
    throw new Error(message);
  }
  return body;
}

// -----------------------------------------------------------------------------
// DOM helper
// -----------------------------------------------------------------------------

export function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      if (key === "class") node.className = attrs[key];
      else if (key === "text") node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    }
  }
  for (const child of children || []) {
    if (child) node.appendChild(child);
  }
  return node;
}

// -----------------------------------------------------------------------------
// Tab / list state
// -----------------------------------------------------------------------------

const state = {
  tab: "configs",
  config: { status: "all", q: "", sort: "updated", page: 1 },
  // selected 把创作者 tab 分成两个画面:列表和某一个人的详情。它留在 tab 状态
  // 里而不是一个模块级变量,因为「刚才在看谁」必须和筛选、页码一样,熬得过一
  // 次写动作之后的重新加载。
  device: { q: "", banned: "all", page: 1, selected: null },
  log: { page: 1 },
  total: 0,
  pageSize: 50,
};

async function refreshStats() {
  let stats;
  try {
    stats = await apiFetchJson("/api/v1/admin/stats");
  } catch (err) {
    // The stats bar is header chrome, not the primary view — a failed
    // refresh leaves the previous numbers in place (or blank, on first
    // load) rather than blocking the tab underneath it from rendering.
    return;
  }
  renderStatsBar(document.getElementById("stats-bar"), stats, (tab, patch) => {
    // 顶栏那几个数字都是全局计数,所以它们落地的那个列表也必须是全局的:留着
    // 上一次的搜索词或者上一次点开的某个人,数字说 N、点进去看到别的(往往是
    // 空的),正是这排数字最不该干的事。两个 tab 都先归位再套 patch。
    //
    // 归位包含排序:数字不承诺任何排序,让它继承上一次选的「下载量」只会让人
    // 以为跳错了地方。
    //
    // 待处理的搜索防抖也要一并取消 —— 输入框里敲了两个字、250ms 还没到就点了
    // 这排数字,那次回调会在跳转之后把刚清掉的 q 重新写回去。
    clearTimeout(searchDebounceTimer);
    clearTimeout(deviceSearchDebounceTimer);
    if (tab === "configs") {
      Object.assign(state.config, { status: "all", q: "", sort: "updated", page: 1 }, patch);
    }
    if (tab === "devices") {
      Object.assign(state.device, { q: "", banned: "all", page: 1, selected: null }, patch);
    }
    // switchTab() 会把工具栏里的三个控件按 state 重画一遍,所以清掉的 q 不会
    // 只清在 state 里、输入框还留着旧字 —— 那是同一个谎换个地方说。
    switchTab(tab);
  });
}

// -----------------------------------------------------------------------------
// Configs tab
// -----------------------------------------------------------------------------

async function loadConfigs() {
  const tabBody = document.getElementById("tab-body");
  const params = new URLSearchParams({
    status: state.config.status,
    sort: state.config.sort,
    page: String(state.config.page),
  });
  if (state.config.q) params.set("q", state.config.q);

  let body;
  try {
    body = await apiFetchJson(`/api/v1/admin/configs?${params}`);
  } catch (err) {
    tabBody.replaceChildren(el("div", { class: "empty", text: "Failed to load configs: " + (err.message || err) }));
    renderPager();
    return;
  }
  state.total = body.total;
  state.pageSize = body.page_size;

  renderConfigList(tabBody, body.items, {
    open: (item) => openDrawer(item.id, drawerCallbacks),
    takedown: (item) => act(`/configs/${item.id}/takedown`, `下架「${item.name}」？`),
    restore: (item) => act(`/configs/${item.id}/restore`, `恢复「${item.name}」？`),
  });
  renderPager();
}

// Every write action refreshes both the list and the header numbers: the
// numbers double as navigation, so leaving them stale means clicking one
// lands on a filtered view that no longer matches what it promised.
//
// reloadTab() rather than loadConfigs(): the same 下架/恢复 pair is now also
// on the creator detail page, and reloading the config list from there would
// paint the list over the page you are standing on.
async function act(path, confirmText) {
  if (!confirm(confirmText)) return;
  try {
    await apiFetchJson(`/api/v1/admin${path}`, { method: "POST" });
  } catch (err) {
    alert("Action failed: " + (err.message || err));
    return;
  }
  await Promise.all([reloadTab(), refreshStats()]);
}

// 哪些画面有分页,以及翻页翻的是谁的页码。举报一次全量返回,创作者详情不是
// 一个列表 —— 这两个画面下面不该有一排点了没反应的按钮,所以整条 pager 收起。
function pagedState() {
  if (state.tab === "configs") return state.config;
  if (state.tab === "devices" && !state.device.selected) return state.device;
  if (state.tab === "log") return state.log;
  return null;
}

function renderPager() {
  const pager = document.getElementById("pager");
  const pageLabel = document.getElementById("page-label");
  const prevBtn = document.getElementById("prev-page");
  const nextBtn = document.getElementById("next-page");

  const paged = pagedState();
  pager.hidden = paged === null;
  if (!paged) return;

  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  pageLabel.textContent = `${paged.page} / ${totalPages}`;
  prevBtn.disabled = paged.page <= 1;
  nextBtn.disabled = paged.page >= totalPages;
}

document.getElementById("prev-page").addEventListener("click", () => {
  const paged = pagedState();
  if (!paged || paged.page <= 1) return;
  paged.page -= 1;
  reloadTab();
});

document.getElementById("next-page").addEventListener("click", () => {
  const paged = pagedState();
  if (!paged) return;
  const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
  if (paged.page >= totalPages) return;
  paged.page += 1;
  reloadTab();
});

let searchDebounceTimer;
document.getElementById("config-search").addEventListener("input", (event) => {
  const value = event.target.value;
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    state.config.q = value.trim();
    state.config.page = 1;
    loadConfigs();
  }, 250);
});

document.getElementById("config-status").addEventListener("change", (event) => {
  state.config.status = event.target.value;
  state.config.page = 1;
  loadConfigs();
});

document.getElementById("config-sort").addEventListener("change", (event) => {
  state.config.sort = event.target.value;
  state.config.page = 1;
  loadConfigs();
});

// -----------------------------------------------------------------------------
// 创作者 tab
// -----------------------------------------------------------------------------

async function loadDevices() {
  const tabBody = document.getElementById("tab-body");
  if (state.device.selected) {
    await loadDeviceDetail(tabBody, state.device.selected);
    return;
  }

  const params = new URLSearchParams({
    banned: state.device.banned,
    page: String(state.device.page),
  });
  if (state.device.q) params.set("q", state.device.q);

  let body;
  try {
    body = await apiFetchJson(`/api/v1/admin/devices?${params}`);
  } catch (err) {
    tabBody.replaceChildren(el("div", { class: "empty", text: "创作者列表加载失败:" + (err.message || err) }));
    renderPager();
    return;
  }
  state.total = body.total;
  state.pageSize = body.page_size;

  renderDeviceList(tabBody, body.items, {
    open: (item) => openDevice(item.id),
    ban: (item) => banDevice(item.id),
    unban: (item) => unbanDevice(item.id, item.nickname || item.id),
  });
  renderPager();
}

async function loadDeviceDetail(tabBody, deviceId) {
  let detail;
  try {
    detail = await apiFetchJson(`/api/v1/admin/devices/${encodeURIComponent(deviceId)}`);
  } catch (err) {
    tabBody.replaceChildren(el("div", { class: "empty", text: "创作者详情加载失败:" + (err.message || err) }));
    renderPager();
    return;
  }

  renderDeviceDetail(tabBody, detail, {
    back: () => {
      state.device.selected = null;
      reloadTab();
    },
    ban: () => banDevice(detail.id),
    unban: () => unbanDevice(detail.id, detail.nickname || detail.id),
    clearNickname: () => clearNickname(detail),
    openConfig: (config) => openDrawer(config.id, drawerCallbacks),
    takedown: (config) => act(`/configs/${encodeURIComponent(config.id)}/takedown`, `下架「${config.name}」?字节都还在,随时可以恢复。`),
    restore: (config) => act(`/configs/${encodeURIComponent(config.id)}/restore`, `恢复「${config.name}」?它会重新出现在列表里。`),
  });
  renderPager();
}

function openDevice(deviceId) {
  if (!deviceId) return;
  closeDrawer();
  state.device.selected = deviceId;
  switchTab("devices");
}

// 封禁不走 confirm():它一次下架一个人的全部在架作品,而解封不会自动把它们
// 放回去。对话框里那个「N 条」是这个动作唯一说得出口的后果,所以它必须是真
// 的 —— 每次都现拉一遍详情按 status === "active" 数,而不是相信列表行里那个
// 可能已经过期的 configs_active,也不是相信详情页上停留了十分钟的那份快照。
// 一次多余的 GET,换一句不会骗人的提示。
async function banDevice(deviceId) {
  let detail;
  try {
    detail = await apiFetchJson(`/api/v1/admin/devices/${encodeURIComponent(deviceId)}`);
  } catch (err) {
    alert("读取创作者详情失败,没有封禁:" + (err.message || err));
    return;
  }

  const answer = await confirmDestructive({
    title: "封禁这个创作者",
    detail: `会连带下架他名下 ${detail.configs.filter((c) => c.status === "active").length} 条仍在架上的配置。解封不会自动把它们恢复。`,
    expected: detail.id,
    confirmLabel: "封禁",
  });
  if (!answer) return;

  try {
    // 路由上这一段是 :device_id 而不是 :id(worker.js),URL 长得一样,但
    // 别照着 unban 的路径去改这里的参数名。
    await apiFetchJson(`/api/v1/admin/devices/${encodeURIComponent(deviceId)}/ban`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: answer.reason }),
    });
  } catch (err) {
    alert("封禁失败:" + (err.message || err));
    return;
  }
  await Promise.all([reloadTab(), refreshStats()]);
}

async function unbanDevice(deviceId, label) {
  // 解封只解封禁本身,这是后端有意的行为 —— 提示语必须先说清楚,不然操作者
  // 会以为点完就完事了。
  if (!confirm(`解封「${label}」?他名下已下架的配置不会自动恢复,要在详情页里逐条恢复。`)) return;
  try {
    await apiFetchJson(`/api/v1/admin/devices/${encodeURIComponent(deviceId)}/unban`, { method: "POST" });
  } catch (err) {
    alert("解封失败:" + (err.message || err));
    return;
  }
  await Promise.all([reloadTab(), refreshStats()]);
}

async function clearNickname(detail) {
  if (!confirm(`清空昵称「${detail.nickname}」?他的配置在列表里会变成没有作者名,这个名字随后可以被别人认领。`)) return;
  try {
    await apiFetchJson(`/api/v1/admin/devices/${encodeURIComponent(detail.id)}/nickname/clear`, { method: "POST" });
  } catch (err) {
    alert("清空昵称失败:" + (err.message || err));
    return;
  }
  await Promise.all([reloadTab(), refreshStats()]);
}

// -----------------------------------------------------------------------------
// 举报 tab
// -----------------------------------------------------------------------------

async function loadReports() {
  const tabBody = document.getElementById("tab-body");
  let body;
  try {
    body = await apiFetchJson("/api/v1/admin/reports");
  } catch (err) {
    tabBody.replaceChildren(el("div", { class: "empty", text: "举报列表加载失败:" + (err.message || err) }));
    renderPager();
    return;
  }

  renderReportList(tabBody, body.items, {
    view: (item) => openDrawer(item.config_id, drawerCallbacks),
    takedownAndResolve: (item) => takedownAndResolve(item),
    resolve: (item) => resolveReport(item),
  });
  renderPager();
}

// 两个请求,顺序写死:先下架,只有下架成功了才结案。反过来的话,下架失败会
// 留下一条已经被静默清掉的举报 —— 该处理的东西从待办里消失了,比动作直接失
// 败糟得多。所以下架失败就在这里返回,举报原样留着。
async function takedownAndResolve(item) {
  if (!confirm(`下架「${item.name}」并结案这条举报?字节都还在,随时可以恢复。`)) return;

  try {
    await apiFetchJson(`/api/v1/admin/configs/${encodeURIComponent(item.config_id)}/takedown`, { method: "POST" });
  } catch (err) {
    alert("下架失败,这条举报没有结案:" + (err.message || err));
    return;
  }

  try {
    await apiFetchJson(`/api/v1/admin/reports/${encodeURIComponent(item.id)}/resolve`, { method: "POST" });
  } catch (err) {
    // 下架已经生效了,不能当作什么都没发生 —— 说清楚做到哪一步,然后照常
    // 刷新:那条举报会仍然留在列表里,再点一次「仅结案」就是。
    alert("配置已下架,但结案失败:" + (err.message || err));
  }
  await Promise.all([reloadTab(), refreshStats()]);
}

async function resolveReport(item) {
  if (!confirm(`结案这条举报?被举报的配置不会有任何变化。`)) return;
  try {
    await apiFetchJson(`/api/v1/admin/reports/${encodeURIComponent(item.id)}/resolve`, { method: "POST" });
  } catch (err) {
    alert("结案失败:" + (err.message || err));
    return;
  }
  await Promise.all([reloadTab(), refreshStats()]);
}

// -----------------------------------------------------------------------------
// 日志页
// -----------------------------------------------------------------------------

async function loadLog() {
  const tabBody = document.getElementById("tab-body");
  let body;
  try {
    body = await apiFetchJson(`/api/v1/admin/log?page=${state.log.page}`);
  } catch (err) {
    tabBody.replaceChildren(el("div", { class: "empty", text: "操作日志加载失败:" + (err.message || err) }));
    renderPager();
    return;
  }
  state.total = body.total;
  state.pageSize = body.page_size;

  renderLogList(tabBody, body.items, {
    openConfig: (configId) => openDrawer(configId, drawerCallbacks),
    openDevice: (deviceId) => openDevice(deviceId),
  });
  renderPager();
}

// -----------------------------------------------------------------------------
// Tabs
// -----------------------------------------------------------------------------

// Reloads whatever tab is on screen without touching its filters, its page or
// the scroll position — which is exactly what the drawer needs after a write:
// the row it changed has to catch up, but everything the operator set up to
// find that row must survive.
function reloadTab() {
  syncChrome();
  if (state.tab === "configs") return loadConfigs();
  if (state.tab === "devices") return loadDevices();
  if (state.tab === "reports") return loadReports();
  if (state.tab === "log") return loadLog();
  return Promise.resolve();
}

// 每个画面自己决定顶上那条工具栏摆什么。创作者详情不是一个列表,它的筛选框
// 一起收起来 —— 留着一个搜完了没地方生效的输入框只会让人以为坏了。
//
// 日志不是三个 tab 之一(它在顶栏),但它一样是一个画面:进去以后三个 tab 全
// 部不高亮,所以「日志」这个按钮自己得亮起来,否则整条导航看起来像是坏了。
function syncChrome() {
  document.getElementById("config-toolbar").hidden = state.tab !== "configs";
  document.getElementById("device-toolbar").hidden =
    state.tab !== "devices" || Boolean(state.device.selected);
  document.getElementById("log-btn").setAttribute("aria-pressed", String(state.tab === "log"));
}

function switchTab(name) {
  state.tab = name;
  for (const btn of document.querySelectorAll(".tab")) {
    btn.setAttribute("aria-selected", String(btn.dataset.tab === name));
  }

  if (name === "configs") {
    document.getElementById("config-status").value = state.config.status;
    document.getElementById("config-sort").value = state.config.sort;
    document.getElementById("config-search").value = state.config.q;
  }
  if (name === "devices") {
    document.getElementById("device-banned").value = state.device.banned;
    document.getElementById("device-search").value = state.device.q;
  }
  return reloadTab();
}

for (const btn of document.querySelectorAll(".tab")) {
  btn.addEventListener("click", () => {
    // 再点一次「创作者」是回到列表,不是停在刚才那个人的详情页上。
    if (btn.dataset.tab === "devices") state.device.selected = null;
    switchTab(btn.dataset.tab);
  });
}

let deviceSearchDebounceTimer;
document.getElementById("device-search").addEventListener("input", (event) => {
  const value = event.target.value;
  clearTimeout(deviceSearchDebounceTimer);
  deviceSearchDebounceTimer = setTimeout(() => {
    state.device.q = value.trim();
    state.device.page = 1;
    loadDevices();
  }, 250);
});

document.getElementById("device-banned").addEventListener("change", (event) => {
  state.device.banned = event.target.value;
  state.device.page = 1;
  loadDevices();
});

document.getElementById("log-btn").addEventListener("click", () => {
  state.log.page = 1;
  switchTab("log");
});

// -----------------------------------------------------------------------------
// Drawer
//
// The drawer owns its own rendering (drawer.js); this side only says what to
// do when something in it changes. Closing it is deliberately not one of
// those things: the list underneath keeps its filter, its page and its scroll
// position, so working through ten queued configs is open-act-close-next
// rather than ten round trips back through the filter bar.
// -----------------------------------------------------------------------------

const drawerCallbacks = {
  onChanged: () => {
    reloadTab();
    refreshStats();
  },
  // 抽屉里点作者,直接落到这个人的详情页 —— 那里才有「他还有哪些配置」和
  // 「封禁会带走多少」,而这正是从一条配置看向它的作者时想知道的事。
  onOpenDevice: (deviceId) => openDevice(deviceId),
};

document.getElementById("drawer-scrim").addEventListener("click", closeDrawer);

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

// Signing in verifies the token BEFORE storing it and before the console is
// ever shown. The old order — store, show the app, let the first background
// request 401 and bounce back — meant a wrong password flashed the whole
// console for one round trip before returning to a login screen, which reads
// as "I was in and got thrown out" rather than "that token is wrong".
//
// The check is a bare fetch(), deliberately not apiFetch(): apiFetch's 401
// branch clears the token and calls showLogin(), which would wipe the specific
// message we are about to write with a generic "session expired" — and it
// would have to read the token out of storage, which is exactly what must not
// happen until it is known to work.
//
// /admin/stats is the cheapest authenticated GET there is (four COUNTs in one
// statement). boot() fetches it again a moment later; one duplicated scalar
// query per sign-in buys a login path with no second entry point into the app.
const loginForm = document.getElementById("login-form");
const loginSubmit = loginForm.querySelector("button[type=submit]");

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("login-token");
  const errorBox = document.getElementById("login-error");
  const token = input.value.trim();
  if (!token) return;

  const label = loginSubmit.textContent;
  loginSubmit.disabled = true;
  loginSubmit.textContent = "Verifying…";
  errorBox.textContent = "";

  let res;
  try {
    res = await fetch("/api/v1/admin/stats", { headers: { Authorization: "Bearer " + token } });
  } catch (err) {
    errorBox.textContent = "Could not reach the server: " + (err.message || err);
    return;
  } finally {
    loginSubmit.disabled = false;
    loginSubmit.textContent = label;
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const code = body && body.error && body.error.code;
    // admin_disabled is a 500 about the deployment, not about the token —
    // telling the operator "wrong token" there sends them off retyping a
    // token that was never going to work.
    if (code === "admin_disabled") {
      errorBox.textContent = "This deployment has no ADMIN_TOKEN configured — the console is disabled.";
    } else if (res.status === 401) {
      errorBox.textContent = "That token is not valid.";
    } else {
      errorBox.textContent =
        (body && body.error && body.error.message) || ("Sign-in failed (" + res.status + ").");
    }
    // Nothing was stored and nothing was shown: the screen has not moved.
    return;
  }

  setToken(token);
  input.value = "";
  boot();
});

document.getElementById("logout-btn").addEventListener("click", () => {
  clearToken();
  showLogin("");
});

function boot() {
  if (!getToken()) {
    showLogin("");
    return;
  }
  showApp();
  refreshStats();
  switchTab(state.tab);
}

boot();
