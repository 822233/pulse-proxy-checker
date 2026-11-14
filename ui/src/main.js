// Pulse — frontend logic. Talks to the Rust backend commands and listens for
// `proxy-progress` events streamed while proxies are checked.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "flag-icons/css/flag-icons.min.css";

const $ = (id) => document.getElementById(id);

// Cross-platform flag: an <i class="fi fi-xx"> image (emoji flags don't render
// on Windows). Returns empty string for unknown/missing country codes.
function flagHtml(cc) {
  if (!cc || cc.length !== 2) return "";
  return `<span class="fi fi-${cc.toLowerCase()}"></span>`;
}

const input = $("proxy-input");
const countEl = $("proxy-count");
const checkBtn = $("btn-check");
const clearBtn = $("btn-clear");
const exportBtn = $("btn-export");
const resultsList = $("results-list");
const progressBar = $("progress-bar");

// views
const viewInput = $("view-input");
const viewChecker = $("view-checker");
const viewSaved = $("view-saved");
const backBtn = $("btn-back");
const copyBtn = $("btn-copy");
const saveWorkingBtn = $("btn-save-working");
const hideDeadToggle = $("hide-dead");
const checkTitle = $("check-title");
const checkStatus = $("check-status");

let selectedScheme = "http";
let lastResults = [];
let liveWorking = 0;
let liveDead = 0;
let mode = "paste";

const freeBar = $("free-bar");
const freeStatus = $("free-status");
const pageTitle = $("page-title");
const findAliveBtn = $("btn-find-alive");

let checkRunning = false;
let cancelled = false;
let lastFetchSummary = null;

// Normalize a raw proxy string to its host:port identity (for dedup).
function proxyKey(raw) {
  let s = String(raw).replace(/^[a-z0-9]+:\/\//i, "");       // drop scheme
  if (s.includes("@")) s = s.split("@")[0];                   // host:port@user:pass
  const parts = s.split(":");
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : s;
}

// ============================ view switching ============================
function showView(name) {
  viewInput.hidden = name !== "input";
  viewChecker.hidden = name !== "checker";
  viewSaved.hidden = name !== "saved";
}

backBtn.addEventListener("click", async () => {
  if (checkRunning) {
    cancelled = true;
    try { await invoke("cancel_check"); } catch { /* ignore */ }
  }
  showView(mode === "saved" ? "saved" : "input");
});

// ============================ mode tabs ============================
// Tabs exist in BOTH the input view and the saved view; bind all of them and
// keep the active state synced so navigation works from any view.
function selectMode(newMode) {
  mode = newMode;
  document.querySelectorAll(".mode-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.mode === mode)
  );
  if (mode === "saved") {
    showView("saved");
    loadSavedPool();
  } else {
    showView("input");
    freeBar.hidden = mode !== "free";
    pageTitle.textContent = mode === "free" ? "免费代理获取" : "粘贴代理列表";
  }
}
document.querySelectorAll(".mode-tabs").forEach((row) =>
  row.addEventListener("click", (e) => {
    const tab = e.target.closest(".mode-tab");
    if (tab) selectMode(tab.dataset.mode);
  })
);

function collectOptions(extra) {
  return Object.assign(
    {
      concurrency: Math.min(300, Math.max(5, parseInt($("concurrency").value, 10) || 100)),
      timeoutMs: parseInt($("timeout").value, 10) || 6000,
      testUrl: null,
    },
    extra || {}
  );
}

// ============================ checker run ============================
function beginResults() {
  showView("checker");
  resultsList.innerHTML = "";
  lastResults = [];
  liveWorking = 0;
  liveDead = 0;
  __rowQueue = [];
  __pending = { done: 0, total: 0 };
  saveWorkingBtn.disabled = true;
  saveWorkingBtn.hidden = true; // only shows once a filter is applied
  $("btn-save-all").disabled = true;
  exportBtn.disabled = true;
  copyBtn.disabled = true;
  resetFilters();
  setStats(0, 0, 0);
  progressBar.style.width = "0%";
}

findAliveBtn.addEventListener("click", async () => {
  findAliveBtn.disabled = true;
  cancelled = false;
  checkRunning = true;
  lastFetchSummary = null;
  beginResults();
  checkTitle.textContent = "正在获取并检测可用代理…";
  checkStatus.classList.add("busy");
  checkStatus.textContent = `正在从公开列表获取 ${selectedScheme.toUpperCase()} 代理…`;
  try {
    const conc = Math.min(300, Math.max(10, parseInt($("concurrency").value, 10) || 100));
    await invoke("find_alive_proxies", { protocol: selectedScheme, options: collectOptions({ limit: 0, concurrency: conc }) });
    finishCheck();
  } catch (err) {
    if (!cancelled) checkStatus.textContent = "获取代理失败：" + translateError(err);
  } finally {
    checkRunning = false;
    findAliveBtn.disabled = false;
    checkStatus.classList.remove("busy");
  }
});

listen("free-fetched", (event) => {
  const p = event.payload || {};
  const fetched = Number.isFinite(p.fetched) ? p.fetched : (p.proxies ? p.proxies.length : 0);
  const checking = Number.isFinite(p.checking) ? p.checking : (p.proxies ? p.proxies.length : 0);
  const details = Object.entries(p.sourceDetails || {}).map(([name, item]) =>
    item.ok
      ? `${name}：成功 ${item.count} 个`
      : `${name}：失败（${item.error || "未知错误"}）`
  );
  const dnsInfo = Array.isArray(p.dnsServers) && p.dnsServers.length
    ? `系统 DNS：${p.dnsServers.join(", ")}`
    : "系统 DNS：未能读取";
  lastFetchSummary = { fetched, checking, details, dnsInfo };
  checkStatus.textContent = fetched > 0
    ? `已获取 ${fetched} 个，正在检测 ${checking} 个…`
    : `代理列表获取失败：${details.join("；") || "所有来源均未返回数据"}；${dnsInfo}`;
});

function finishCheck() {
  if (cancelled) return;
  const alive = liveWorking;
  const total = lastResults.length;
  checkTitle.textContent = lastFetchSummary && lastFetchSummary.fetched === 0
    ? "代理列表获取失败"
    : `${alive} 个可用 / 共检测 ${total} 个`;
  checkStatus.classList.remove("busy");
  if (lastFetchSummary && lastFetchSummary.fetched === 0) {
    checkStatus.textContent = `没有获取到代理列表。详细原因：${lastFetchSummary.details.join("；") || "所有来源均未返回数据"}；${lastFetchSummary.dnsInfo}`;
  } else if (alive > 0) {
    checkStatus.textContent = `检测完成：发现 ${alive} 个可用代理。`;
  } else if (lastFetchSummary) {
    checkStatus.textContent = `已获取 ${lastFetchSummary.fetched} 个代理，但没有检测到可用代理。`;
  } else {
    checkStatus.textContent = "没有发现可用代理。";
  }
  updateActionButtons();
  populateCountryFilter();
  rerenderResults();
}

// ============================ filters ============================
const fRisk = $("f-risk"), fCountry = $("f-country"), fLatency = $("f-latency"), fQuality = $("f-quality"), filterCount = $("filter-count");

function resetFilters() {
  fRisk.value = ""; fCountry.innerHTML = '<option value="">全部</option>';
  fLatency.value = ""; fQuality.value = ""; hideDeadToggle.checked = true;
}

function populateCountryFilter() {
  const seen = new Map();
  for (const r of lastResults) if (r.ok && r.countryCode) seen.set(r.countryCode, r.countryCode);
  const cur = fCountry.value;
  fCountry.innerHTML = '<option value="">全部</option>' +
    [...seen.entries()].sort().map(([cc, label]) => `<option value="${cc}">${label}</option>`).join("");
  fCountry.value = cur;
}

// Does a result pass the active filters?
// Generic filter predicate, reused by the checker view and the saved view.
function makeFilter(els) {
  return (r) => {
    if (els.hideDead.checked && !r.ok) return false;
    if (!r.ok) return true; // dead shown only when hide-dead off; filters apply to working
    if (els.risk.value && r.risk !== els.risk.value) return false;
    if (els.country.value && r.countryCode !== els.country.value) return false;
    const maxLat = parseInt(els.latency.value, 10);
    if (!isNaN(maxLat) && (r.latencyMs == null || r.latencyMs > maxLat)) return false;
    const minQ = parseInt(els.quality.value, 10);
    if (!isNaN(minQ) && (r.quality == null || r.quality < minQ)) return false;
    return true;
  };
}

const checkerFilterEls = { hideDead: hideDeadToggle, risk: fRisk, country: fCountry, latency: fLatency, quality: fQuality };
const passesFilters = (r) => makeFilter(checkerFilterEls)(r);

function filteredResults() {
  return lastResults.filter(passesFilters);
}

// Sort only when rendering or exporting, never during every progress update.
function sortByLatency(rows) {
  return rows
    .map((result, index) => ({ result, index }))
    .sort((a, b) => {
      if (a.result.ok !== b.result.ok) return a.result.ok ? -1 : 1;
      if (a.result.ok && b.result.ok) {
        return (a.result.latencyMs ?? Infinity) - (b.result.latencyMs ?? Infinity) || a.index - b.index;
      }
      return a.index - b.index;
    })
    .map(({ result }) => result);
}

function rerenderResults() {
  resultsList.innerHTML = "";
  const rows = sortByLatency(filteredResults());
  const frag = document.createDocumentFragment();
  for (const r of rows.slice(0, 1000)) frag.appendChild(buildRow(r));
  resultsList.appendChild(frag);
  const workingShown = rows.filter((r) => r.ok).length;
  filterCount.textContent = `显示 ${workingShown} 个`;
  updateActionButtons();
}

[fRisk, fCountry, fLatency, fQuality, hideDeadToggle].forEach((el) => el.addEventListener("input", rerenderResults));

// True when any narrowing filter is set (hide-dead alone doesn't count — it only
// affects display of dead rows, and "save" already ignores dead proxies).
function anyFilterActive() {
  return !!(fRisk.value || fCountry.value || fLatency.value || fQuality.value);
}

function updateActionButtons() {
  const shownWorking = filteredResults().filter((r) => r.ok).length;
  const totalWorking = liveWorking;
  copyBtn.disabled = shownWorking === 0;
  exportBtn.disabled = shownWorking === 0;
  $("btn-save-all").disabled = totalWorking === 0;
  // "Save filtered" only appears when a filter is actually applied (otherwise
  // it'd be identical to "Save all working").
  saveWorkingBtn.hidden = !anyFilterActive();
  saveWorkingBtn.disabled = shownWorking === 0;
}

// ============================ copy / export / save ============================
// These act on the FILTERED working set so "save/copy/export filtered" is implicit.
function visibleWorking() {
  return sortByLatency(filteredResults().filter((r) => r.ok));
}

async function copyToClipboard(text, btn, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
  const old = btn.textContent; btn.textContent = "✓ 已复制";
  setTimeout(() => (btn.textContent = old || label), 1200);
}

copyBtn.addEventListener("click", () => copyToClipboard(visibleWorking().map((r) => r.raw).join("\n"), copyBtn, "复制"));

async function exportToFile(content, filename, btn) {
  try {
    const path = await invoke("export_proxies", { filename, content });
    const old = btn.textContent;
    btn.textContent = "✓ 已保存到下载文件夹";
    setTimeout(() => (btn.textContent = old), 1800);
    console.log("exported to", path);
  } catch (e) {
    btn.textContent = "导出失败";
    setTimeout(() => (btn.textContent = "导出"), 1800);
  }
}

// Timestamp like 20261012-1305 for export filenames.
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
// Most common scheme among a set of results (for the filename).
function dominantScheme(rows) {
  const counts = {};
  for (const r of rows) counts[r.scheme || "http"] = (counts[r.scheme || "http"] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "mixed";
}

exportBtn.addEventListener("click", () => {
  const rows = visibleWorking();
  exportToFile(rows.map((r) => r.raw).join("\n"), `proxies-${dominantScheme(rows)}-${stamp()}.txt`, exportBtn);
});

// Save a set of working results into the per-protocol saved pools (deduped),
// grouping each proxy into the pool matching its own scheme.
async function saveToPools(toSave, btn) {
  if (toSave.length === 0) return;
  const byProto = {};
  for (const r of toSave) {
    const proto = (r.scheme || "http").toLowerCase();
    (byProto[proto] = byProto[proto] || []).push(r);
  }
  let added = 0;
  for (const [proto, items] of Object.entries(byProto)) {
    added += await mergeIntoPool(proto, items);
  }
  const old = btn.textContent;
  btn.textContent = `✓ 已保存 ${added} 个`;
  setTimeout(() => (btn.textContent = old), 1500);
}

const saveAllBtn = $("btn-save-all");
// "Save filtered" — only what matches the active filters.
saveWorkingBtn.addEventListener("click", () => saveToPools(visibleWorking(), saveWorkingBtn));
// "Save all working" — every working proxy from the run, ignoring filters.
saveAllBtn.addEventListener("click", () => saveToPools(lastResults.filter((r) => r.ok), saveAllBtn));

// Merge results into a protocol's saved pool, dedup by host:port. Returns #added.
async function mergeIntoPool(proto, items) {
  const existing = await invoke("load_saved", { protocol: proto });
  const pool = Array.isArray(existing) ? existing : [];
  const index = new Map(pool.map((r) => [proxyKey(r.raw), r]));
  let added = 0;
  for (const r of items) {
    const k = proxyKey(r.raw);
    if (!index.has(k)) added++;
    index.set(k, r); // insert or refresh
  }
  await invoke("save_saved", { protocol: proto, proxies: [...index.values()] });
  return added;
}

// ============================ input (paste) ============================
function lines() {
  return input.value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}
function refreshCount() {
  const n = lines().length;
  countEl.textContent = String(n);
  checkBtn.disabled = n === 0;
}
input.addEventListener("input", refreshCount);

$("protocol-group").addEventListener("click", (e) => {
  const pill = e.target.closest(".pill");
  if (!pill) return;
  $("protocol-group").querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
  pill.classList.add("active");
  selectedScheme = pill.dataset.scheme;
  if (!freeBar.hidden) freeStatus.textContent = `将从公开列表获取 ${selectedScheme.toUpperCase()} 代理。`;
});

clearBtn.addEventListener("click", () => { input.value = ""; refreshCount(); });

function applyScheme(list) {
  return list.map((line) => {
    if (/:\/\//.test(line)) return line;
    if (/@/.test(line)) return line;
    const parts = line.split(":");
    if (parts.length === 2) return `${selectedScheme}://${line}`;
    return line;
  });
}

checkBtn.addEventListener("click", async () => {
  const list = applyScheme(lines());
  if (list.length === 0) return;
  checkBtn.disabled = true;
  checkBtn.textContent = "正在检测…";
  cancelled = false;
  checkRunning = true;
  beginResults();
  checkTitle.textContent = "正在检测代理…";
  checkStatus.classList.add("busy");
  checkStatus.textContent = `正在检测 ${list.length} 个代理…`;
  try {
    await invoke("check_proxies_native", { proxies: list, options: collectOptions() });
    finishCheck();
  } catch (err) {
    if (!cancelled) checkStatus.textContent = "检测失败：" + translateError(err);
  } finally {
    checkRunning = false;
    checkBtn.disabled = false;
    checkBtn.textContent = "开始检测";
    checkStatus.classList.remove("busy");
  }
});

// ============================ live progress stream ============================
let __rowQueue = [];
let __pending = { done: 0, total: 0 };
let __flushScheduled = false;

function scheduleFlush() {
  if (__flushScheduled) return;
  __flushScheduled = true;
  requestAnimationFrame(flushProgress);
}

function flushProgress() {
  __flushScheduled = false;
  if (__rowQueue.length) {
    const frag = document.createDocumentFragment();
    for (const r of __rowQueue) if (passesFilters(r)) frag.appendChild(buildRow(r));
    resultsList.appendChild(frag);
    __rowQueue = [];
    while (resultsList.childElementCount > 1000) resultsList.removeChild(resultsList.firstChild);
  }
  const { done, total } = __pending;
  progressBar.style.width = total ? `${Math.round((done / total) * 100)}%` : "0%";
  setStats(total || done, liveWorking, liveDead);
  updateActionButtons();
  if (checkStatus.classList.contains("busy") && done) {
    checkStatus.textContent = `检测进度 ${done}/${total} — ${liveWorking} 个可用，${liveDead} 个失效`;
  }
}

listen("proxy-progress", (event) => {
  if (savedRecheckActive) return; // saved-recheck has its own handler below
  const { result, done, total } = event.payload;
  lastResults.push(result);
  if (result.ok) { liveWorking++; if (result.countryCode) maybeAddCountry(result); }
  else liveDead++;
  __rowQueue.push(result);
  __pending = { done, total };
  scheduleFlush();
});

let __countrySeen = new Set();
function maybeAddCountry(r) {
  if (__countrySeen.has(r.countryCode)) return;
  __countrySeen.add(r.countryCode);
  const opt = document.createElement("option");
  opt.value = r.countryCode; opt.textContent = r.countryCode;
  fCountry.appendChild(opt);
}

function setStats(total, working, dead) {
  $("stat-total").textContent = total;
  $("stat-working").textContent = working;
  $("stat-dead").textContent = dead;
}

function buildRow(r) {
  const row = document.createElement("div");
  row.className = "result-row " + (r.ok ? "ok" : "dead");
  const status = r.ok ? "可用" : translateError(r.error || "Failed");
  // flag is trusted markup (built from a validated 2-letter code); code is escaped.
  const country = r.ok ? `${flagHtml(r.countryCode)} ${escapeHtml(r.countryCode || "??")}` : "";
  const exit = r.ok && r.exitIp ? r.exitIp : "";
  const quality = r.ok && r.quality != null ? `${r.quality}%` : "";
  const risk = r.ok && r.risk ? ({ Low: "低", Medium: "中", High: "高" }[r.risk] || r.risk) : "";
  const latency = r.ok && r.latencyMs != null
    ? `${r.latencyMs} ms · ${r.latencyMs < 500 ? "快速" : r.latencyMs < 1000 ? "较快" : r.latencyMs < 2000 ? "一般" : "较慢"}`
    : "";
  const riskClass = risk ? `risk-${risk.toLowerCase()}` : "";
  row.innerHTML = `
    <span class="dot" title="${escapeHtml(r.isp || "")}"></span>
    <span class="col-proxy raw">${escapeHtml(r.raw)}</span>
    <span class="col-status">${escapeHtml(status)}</span>
    <span class="col-country">${country}</span>
    <span class="col-ip">${escapeHtml(exit)}</span>
    <span class="col-quality"><span class="qbar"><span style="width:${r.ok ? r.quality : 0}%"></span></span>${quality}</span>
    <span class="col-risk ${riskClass}">${escapeHtml(risk)}</span>
    <span class="col-latency meta">${escapeHtml(latency)}</span>`;
  return row;
}

function translateError(value) {
  const text = String(value || "").trim();
  const messages = [
    ["parse error", "代理地址格式无法识别"],
    ["not forwarding", "代理未正确转发请求"],
    ["ECONNREFUSED", "代理服务器拒绝连接"],
    ["ECONNRESET", "连接被对端重置"],
    ["ENOTFOUND", "域名解析失败"],
    ["EHOSTUNREACH", "目标主机不可达"],
    ["ENETUNREACH", "网络不可达"],
    ["ETIMEDOUT", "连接超时"],
    ["timeout", "连接超时"],
    ["no response", "未收到响应"],
    ["Failed to spawn engine", "检测引擎启动失败"],
    ["resource dir", "无法定位程序资源目录"],
    ["app data dir", "无法访问应用数据目录"],
    ["create saved dir", "无法创建代理池目录"],
    ["serialize", "代理池数据处理失败"],
    ["write saved", "代理池保存失败"],
    ["could not resolve a download directory", "无法定位下载目录"],
    ["write failed", "导出文件写入失败"],
    ["Error sending message", "向检测引擎发送数据失败"],
    ["engine task join error", "检测任务异常中断"],
    ["unknown message type", "检测引擎返回了无法识别的消息"],
    ["Failed to resolve PulseEngine", "无法定位代理检测引擎"],
    ["cannot determine Chrome NM directory", "无法定位 Chrome 原生消息目录"],
    ["cannot determine Firefox NM directory", "无法定位 Firefox 原生消息目录"],
    ["create dir", "无法创建浏览器集成目录"],
    ["write manifest", "无法写入浏览器集成配置"]
  ];
  for (const [key, label] of messages) {
    if (text.toLowerCase().includes(key.toLowerCase())) return label;
  }
  if (!text || text.toLowerCase() === "failed") return "操作失败，请重试";
  return text;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ============================ Saved Proxies view ============================
const savedList = $("saved-list");
const savedStatus = $("saved-status");
const savedProtoGroup = $("saved-proto-group");
const recheckBtn = $("btn-recheck-saved");
const removeDeadBtn = $("btn-remove-dead");
const savedCopyBtn = $("btn-saved-copy");
const savedExportBtn = $("btn-saved-export");
const savedClearBtn = $("btn-saved-clear");

let savedScheme = "http";
let savedPool = []; // array of result objects for the current savedScheme

savedProtoGroup.addEventListener("click", (e) => {
  const pill = e.target.closest(".pill");
  if (!pill) return;
  savedProtoGroup.querySelectorAll(".pill").forEach((p) => p.classList.remove("active"));
  pill.classList.add("active");
  savedScheme = pill.dataset.scheme;
  loadSavedPool();
});

async function loadSavedPool() {
  savedStatus.textContent = "正在加载…";
  const data = await invoke("load_saved", { protocol: savedScheme });
  savedPool = Array.isArray(data) ? data : [];
  renderSavedPool();
  savedStatus.textContent = `已保存 ${savedPool.length} 个 ${savedScheme.toUpperCase()} 代理`;
}

// Saved-view filters (independent from the checker view).
const savedFilterEls = {
  hideDead: $("sf-hide-dead"), risk: $("sf-risk"), country: $("sf-country"),
  latency: $("sf-latency"), quality: $("sf-quality"),
};
const savedFilterCount = $("saved-filter-count");
const passesSavedFilter = (r) => makeFilter(savedFilterEls)(r);
Object.values(savedFilterEls).forEach((el) => el.addEventListener("input", renderSavedPool));

function populateSavedCountryFilter() {
  const seen = new Map();
  for (const r of savedPool) if (r.ok && r.countryCode) seen.set(r.countryCode, r.countryCode);
  const cur = savedFilterEls.country.value;
  savedFilterEls.country.innerHTML = '<option value="">全部</option>' +
    [...seen.entries()].sort().map(([cc, label]) => `<option value="${cc}">${label}</option>`).join("");
  savedFilterEls.country.value = cur;
}

function renderSavedPool() {
  populateSavedCountryFilter();
  savedList.innerHTML = "";
  const rows = sortByLatency(savedPool.filter(passesSavedFilter));
  const frag = document.createDocumentFragment();
  for (const r of rows.slice(0, 2000)) frag.appendChild(buildRow(r));
  savedList.appendChild(frag);
  savedFilterCount.textContent = `显示 ${rows.filter((r) => r.ok).length} 个`;
  const hasDead = savedPool.some((r) => !r.ok);
  removeDeadBtn.disabled = !hasDead;
  savedCopyBtn.disabled = savedPool.length === 0;
  savedExportBtn.disabled = savedPool.length === 0;
  savedClearBtn.disabled = savedPool.length === 0;
}

// Recheck every proxy in the pool, updating rows live, then persist.
recheckBtn.addEventListener("click", async () => {
  if (savedPool.length === 0) { savedStatus.textContent = "代理池为空。"; return; }
  recheckBtn.disabled = true;
  savedStatus.textContent = `正在重新检测 ${savedPool.length} 个代理…`;
  const raws = savedPool.map((r) => r.raw);
  savedRecheckActive = true;
  savedRecheckMap = new Map(); // key -> new result
  try {
    await invoke("check_proxies_native", { proxies: raws, options: collectOptions() });
    // merge new results back into the pool by key (keep dead, mark them)
    savedPool = savedPool.map((old) => savedRecheckMap.get(proxyKey(old.raw)) || { ...old, ok: false, status: "dead", error: "no response" });
    await invoke("save_saved", { protocol: savedScheme, proxies: savedPool });
    renderSavedPool();
    const alive = savedPool.filter((r) => r.ok).length;
    savedStatus.textContent = `重新检测完成 — ${alive}/${savedPool.length} 个仍然可用`;
  } catch (err) {
    savedStatus.textContent = "重新检测失败：" + translateError(err);
  } finally {
    savedRecheckActive = false;
    recheckBtn.disabled = false;
  }
});

// During a saved recheck, capture progress into the map + show live progress.
let savedRecheckActive = false;
let savedRecheckMap = null;
listen("proxy-progress", (event) => {
  if (!savedRecheckActive) return;
  const { result, done, total } = event.payload;
  savedRecheckMap.set(proxyKey(result.raw), result);
  const alive = [...savedRecheckMap.values()].filter((r) => r.ok).length;
  savedStatus.textContent = `重新检测进度 ${done}/${total} — ${alive} 个仍然可用`;
});

removeDeadBtn.addEventListener("click", async () => {
  savedPool = savedPool.filter((r) => r.ok);
  await invoke("save_saved", { protocol: savedScheme, proxies: savedPool });
  renderSavedPool();
  savedStatus.textContent = `已删除失效代理，剩余 ${savedPool.length} 个`;
});

const savedVisibleWorking = () => savedPool.filter((r) => r.ok && passesSavedFilter(r));
savedCopyBtn.addEventListener("click", () => copyToClipboard(savedVisibleWorking().map((r) => r.raw).join("\n"), savedCopyBtn, "复制"));
savedExportBtn.addEventListener("click", () =>
  exportToFile(savedVisibleWorking().map((r) => r.raw).join("\n"), `proxies-${savedScheme}-${stamp()}.txt`, savedExportBtn)
);
savedClearBtn.addEventListener("click", async () => {
  savedPool = [];
  await invoke("save_saved", { protocol: savedScheme, proxies: [] });
  renderSavedPool();
  savedStatus.textContent = "代理池已清空。";
});

refreshCount();

// ============================ update check (launch) ============================
(async function checkForUpdate() {
  const banner = $("update-banner");
  const text = $("update-text");
  const download = $("update-download");
  const dismiss = $("update-dismiss");
  let updateUrl = "https://github.com/822233/pulse-proxy-checker/releases/latest";

  dismiss.addEventListener("click", () => { banner.hidden = true; });
  download.addEventListener("click", async (e) => {
    e.preventDefault();
    try { await invoke("plugin:opener|open_url", { url: updateUrl }); } catch { /* ignore */ }
  });

  try {
    const info = await invoke("check_for_update");
    if (info && info.update) {
      updateUrl = info.url || updateUrl;
      text.textContent = `Pulse 有新版本 ${info.latest} 可用（当前版本 ${info.current}）。`;
      banner.hidden = false;
    }
  } catch {
    // offline / rate-limited — stay silent, never block the app.
  }
})();
