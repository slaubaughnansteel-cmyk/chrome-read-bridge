/**
 * background.js —— MV3 service worker
 *
 * 职责：向本地桥长轮询领取指令 → 在标签页里执行 → 回传结果。
 * 只做「列标签 / 读正文 / 开网页」，不读取 Cookie、localStorage 或凭据。
 */

const BRIDGE = 'http://127.0.0.1:8787';
const POLL_WAIT = 25;

let polling = false;

/** 注入到页面里执行的取正文函数（必须自包含，不能引用外部变量） */
function grabPage() {
  const body = document.body;
  const text = body ? body.innerText : '';
  return {
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    text: text.slice(0, 30000),
    truncated: text.length > 30000,
  };
}

async function bridgeHealth() {
  const r = await fetch(`${BRIDGE}/health`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** 解析目标标签页 id */
async function resolveTabId(spec) {
  if (spec === undefined || spec === null || spec === 'active') {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw { code: 'NO_ACTIVE_TAB', message: '找不到当前活动标签页' };
    return tab.id;
  }
  if (typeof spec === 'number') return spec;
  if (typeof spec === 'string' && spec.startsWith('url:')) {
    const needle = spec.slice(4);
    const tabs = await chrome.tabs.query({});
    const hit = tabs.find((t) => (t.url || '').includes(needle));
    if (!hit) throw { code: 'TARGET_NOT_FOUND', message: `没有 URL 含 "${needle}" 的标签页` };
    return hit.id;
  }
  if (typeof spec === 'string' && /^\d+$/.test(spec)) return Number(spec);
  throw { code: 'BAD_TAB_SPEC', message: `无法识别的 tab 参数：${JSON.stringify(spec)}` };
}

async function doTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    id: t.id,
    title: t.title,
    url: t.url,
    active: t.active,
    windowId: t.windowId,
  }));
}

async function doRead(spec) {
  const tabId = await resolveTabId(spec);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  let injected;
  try {
    injected = await chrome.scripting.executeScript({ target: { tabId }, func: grabPage });
  } catch (e) {
    // 常见于 chrome:// 、扩展页、应用商店等受限页面
    throw {
      code: 'READ_FAILED',
      message: `无法注入该页面（可能是浏览器内置页、扩展页或应用商店）：${e.message}`,
    };
  }
  const picked = (injected || []).find((x) => x && x.result);
  if (!picked) throw { code: 'READ_FAILED', message: '页面没有返回可读正文' };
  return { ...picked.result, tabId, tabTitle: tab ? tab.title : null };
}

async function doOpen(url) {
  const tab = await chrome.tabs.create({ url });
  return { tabId: tab.id, url: tab.pendingUrl || tab.url || url };
}

async function executeTask(task) {
  switch (task.action) {
    case 'tabs':
      return doTabs();
    case 'read':
      return doRead(task.tab);
    case 'open':
      return doOpen(task.url);
    default:
      throw { code: 'UNKNOWN_ACTION', message: `未知动作：${task.action}` };
  }
}

async function postResult(id, ok, data, error) {
  await fetch(`${BRIDGE}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ok, data, error }),
  }).catch(() => {});
}

async function pollOnce() {
  const r = await fetch(`${BRIDGE}/task?wait=${POLL_WAIT}`, { cache: 'no-store' });
  if (r.status === 204) return; // 无指令，继续下一轮
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const task = await r.json();
  if (!task || !task.id) return;

  await chrome.storage.local.set({ lastTask: { ...task, at: Date.now() } });
  try {
    const data = await executeTask(task);
    await postResult(task.id, true, data, null);
    await chrome.storage.local.set({ lastResult: { id: task.id, ok: true, at: Date.now() } });
  } catch (err) {
    const error =
      err && err.code
        ? { code: err.code, message: err.message }
        : { code: 'EXEC_FAILED', message: (err && err.message) || String(err) };
    await postResult(task.id, false, null, error);
    await chrome.storage.local.set({ lastResult: { id: task.id, ok: false, error, at: Date.now() } });
  }
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    while (true) {
      try {
        await pollOnce();
      } catch {
        // 桥没起来时退避重试，不要打爆
        await new Promise((res) => setTimeout(res, 3000));
      }
    }
  } finally {
    polling = false;
  }
}

/** 唤醒并启动轮询循环 */
function ensurePolling() {
  pollLoop();
}

chrome.runtime.onStartup.addListener(ensurePolling);
chrome.runtime.onInstalled.addListener(() => {
  // 每 30 秒唤醒一次 SW，避免被回收后彻底停摆
  chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  ensurePolling();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'keepalive') ensurePolling();
});

// SW 启动即尝试挂上
ensurePolling();

// popup 可手动查询状态
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'health') {
    bridgeHealth()
      .then((h) => sendResponse({ ok: true, health: h }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg && msg.type === 'readNow') {
    doRead('active')
      .then((d) => sendResponse({ ok: true, data: d }))
      .catch((e) => sendResponse({ ok: false, error: e.code ? e : { code: 'FAIL', message: e.message } }));
    return true;
  }
  return false;
});
