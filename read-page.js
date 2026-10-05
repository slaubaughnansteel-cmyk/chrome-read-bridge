#!/usr/bin/env node
/**
 * read-page.js —— 通过桥接服务驱动扩展读取页面
 *
 * 用法：
 *   node read-page.js tabs                  列出所有标签页
 *   node read-page.js read                  读取当前活动标签页正文
 *   node read-page.js read url:github.com   读取 URL 含 github.com 的标签页
 *   node read-page.js read 123456789        读取指定 tabId
 *   node read-page.js open https://github.com  新开标签页
 *
 * 环境变量 BRIDGE 可覆盖桥地址，默认 http://127.0.0.1:8787
 */

'use strict';

const BRIDGE = process.env.BRIDGE || 'http://127.0.0.1:8787';
const WAIT_MS = 40000;

async function main() {
  const [action = 'read', arg] = process.argv.slice(2);

  if (action === '-h' || action === '--help') {
    console.log(`用法：
  node read-page.js tabs
  node read-page.js read [active|url:<片段>|<tabId>]
  node read-page.js open <https://...>`);
    return;
  }
  if (!['tabs', 'read', 'open'].includes(action)) {
    console.error(`未知动作：${action}（可用：tabs / read / open）`);
    process.exit(2);
  }

  let payload;
  if (action === 'open') {
    if (!arg) { console.error('open 需要一个 http(s) URL'); process.exit(2); }
    payload = { action, url: arg };
  } else if (action === 'read') {
    let tab = 'active';
    if (arg && arg !== 'active') tab = /^\d+$/.test(arg) ? Number(arg) : `url:${arg}`;
    payload = { action, tab };
  } else {
    payload = { action };
  }

  // 1) 检查桥是否在线
  let health;
  try {
    const r = await fetch(`${BRIDGE}/health`, { signal: AbortSignal.timeout(4000) });
    health = await r.json();
  } catch {
    console.error(`连不上桥接服务 ${BRIDGE}`);
    console.error('请先在另一个终端启动：node bridge.js');
    process.exit(3);
  }
  if (!health.extensionConnected) {
    console.error('桥在线，但扩展还没连上。');
    console.error('请确认 Chrome 已加载本扩展，并打开扩展弹窗看状态是否为「桥已连接」。');
    process.exit(4);
  }

  // 2) 下发指令
  const cmdRes = await fetch(`${BRIDGE}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const cmd = await cmdRes.json();
  if (!cmd.ok) {
    console.error(`下发指令失败：${cmd.error} ${cmd.message || ''}`);
    process.exit(5);
  }

  // 3) 等结果
  const r = await fetch(`${BRIDGE}/result?id=${cmd.id}&wait=${Math.round(WAIT_MS / 1000)}`, {
    signal: AbortSignal.timeout(WAIT_MS + 5000),
  });
  const out = await r.json();

  if (!out.ready) {
    console.error('等待扩展回传结果超时。请检查扩展是否正常运行。');
    process.exit(6);
  }
  if (!out.ok) {
    console.error(`执行失败：${out.error && out.error.code} ${out.error && out.error.message}`);
    process.exit(7);
  }

  // 4) 输出：read 时把正文放最后，方便直接看
  if (action === 'read') {
    const d = out.data;
    console.log(`标题: ${d.title}`);
    console.log(`地址: ${d.url}`);
    console.log(`状态: ${d.readyState}${d.truncated ? '（正文已截断到 30000 字）' : ''}`);
    console.log('--- 正文 ---');
    console.log(d.text);
  } else {
    console.log(JSON.stringify(out.data, null, 2));
  }
}

main().catch((e) => {
  console.error('异常：', e.message);
  process.exit(1);
});
