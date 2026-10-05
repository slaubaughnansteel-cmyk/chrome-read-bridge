#!/usr/bin/env node
/**
 * bridge.js —— 本地桥接服务（零第三方依赖，Node 22+）
 *
 * 作用：让 Chrome 扩展和本机脚本互相传话。
 *   - 本机脚本 POST /cmd      下一条指令（read / tabs / open）
 *   - 扩展    GET  /task      长轮询取指令
 *   - 扩展    POST /result    回传执行结果
 *   - 本机脚本 GET  /result   取回结果
 *
 * 安全边界：只监听 127.0.0.1，不对外网暴露；不落盘、不记录页面内容。
 *
 * 用法：
 *   node bridge.js            # 默认 8787
 *   node bridge.js --port 8787
 *
 * 约定：所有 wait 查询参数的单位都是「秒」。
 */

'use strict';

const http = require('http');

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 8787;
const HOST = '127.0.0.1';

if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
  console.error('端口非法：需为 1024-65535 之间的整数');
  process.exit(1);
}

const MAX_BODY = 2 * 1024 * 1024; // 2MB，够放 30000 字正文
const TASK_WAIT_SEC = 25;         // 扩展长轮询单次最长挂起
const RESULT_WAIT_SEC = 30;       // 脚本等待结果最长挂起
const MAX_WAIT_SEC = 60;

/** 待领取的指令（同一时刻只允许一条，避免并发读同一标签页） */
let pendingTask = null;
/** 正在长轮询等指令的扩展连接 */
let taskWaiter = null;
/** id -> 执行结果 */
const results = new Map();
/** id -> 正在等待该结果的连接列表 */
const resultWaiters = new Map();
/** 扩展最近一次心跳时间 */
let extensionLastSeen = 0;

const now = () => Date.now();
const rid = () => Math.random().toString(36).slice(2, 10);
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

function send(res, code, obj) {
  if (res.writableEnded) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('REQUEST_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('INVALID_JSON')); }
    });
    req.on('error', reject);
  });
}

/** 把 wait 查询参数（秒）转成毫秒，并夹在合法区间内 */
function waitMs(raw, fallbackSec) {
  const sec = Number(raw) || fallbackSec;
  return Math.min(Math.max(sec, 1), MAX_WAIT_SEC) * 1000;
}

function validTask(t) {
  if (!t || typeof t !== 'object') return false;
  if (!['read', 'tabs', 'open'].includes(t.action)) return false;
  if (t.action === 'open' && typeof t.url !== 'string') return false;
  if (t.action === 'open' && !/^https?:\/\//i.test(t.url)) return false;
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, {});

  try {
    // ---------- 健康检查 ----------
    if (path === '/health') {
      return send(res, 200, {
        ok: true,
        port: PORT,
        extensionConnected: now() - extensionLastSeen < 60000,
        extensionLastSeen: extensionLastSeen || null,
        pendingTask: pendingTask ? pendingTask.id : null,
        resultCount: results.size,
      });
    }

    // ---------- 下指令 ----------
    if (path === '/cmd' && req.method === 'POST') {
      const body = await readBody(req);
      const task = {
        id: rid(),
        action: body.action || 'read',
        tab: body.tab ?? 'active',
        url: body.url,
      };
      if (!validTask(task)) {
        return send(res, 400, {
          ok: false,
          error: 'INVALID_TASK',
          message: 'action 需为 read/tabs/open；open 需要 http(s) 的 url',
        });
      }
      if (pendingTask) {
        return send(res, 409, {
          ok: false,
          error: 'TASK_BUSY',
          message: '上一条指令还没被扩展取走，稍后重试',
        });
      }
      pendingTask = task;
      log(`下发指令 ${task.id} action=${task.action} tab=${task.tab}`);

      // 若扩展正挂着长轮询，立即把指令交给它
      if (taskWaiter) {
        const w = taskWaiter;
        w.answered = true;
        clearTimeout(w.timer);
        taskWaiter = null;
        pendingTask = null;
        send(w.res, 200, task);
        log(`指令 ${task.id} 已直接推给挂起中的扩展`);
      }
      return send(res, 200, { ok: true, id: task.id, status: 'queued' });
    }

    // ---------- 扩展取指令（长轮询）----------
    if (path === '/task' && req.method === 'GET') {
      extensionLastSeen = now();

      if (pendingTask) {
        const t = pendingTask;
        pendingTask = null;
        return send(res, 200, t);
      }
      if (taskWaiter) {
        // 上一个挂起连接还没结束，避免堆积
        return send(res, 204, {});
      }

      const w = { res, answered: false, timer: null };
      w.timer = setTimeout(() => {
        if (w.answered) return;
        w.answered = true;
        if (taskWaiter === w) taskWaiter = null;
        send(res, 204, {});
      }, waitMs(url.searchParams.get('wait'), TASK_WAIT_SEC));
      taskWaiter = w;

      // 关键：监听 res 的 close（客户端断开或响应结束）。
      // 不能用 req.on('close')——它在请求体读完时就触发，会立刻清掉定时器，
      // 导致长轮询永不返回（本 bug 实测踩过）。
      res.on('close', () => {
        if (w.answered) return;
        w.answered = true;
        clearTimeout(w.timer);
        if (taskWaiter === w) taskWaiter = null;
      });
      return;
    }

    // ---------- 扩展回传结果 ----------
    if (path === '/result' && req.method === 'POST') {
      const body = await readBody(req);
      extensionLastSeen = now();
      if (!body.id) return send(res, 400, { ok: false, error: 'ID_REQUIRED' });

      const entry = {
        id: body.id,
        ok: body.ok !== false,
        data: body.data ?? null,
        error: body.error ?? null,
        at: now(),
      };
      results.set(body.id, entry);
      if (results.size > 50) results.delete([...results.keys()][0]);

      const waiters = resultWaiters.get(body.id) || [];
      resultWaiters.delete(body.id);
      for (const w of waiters) {
        if (w.answered) continue;
        w.answered = true;
        clearTimeout(w.timer);
        send(w.res, 200, { ready: true, ...entry });
      }

      log(`收到结果 ${body.id} ok=${entry.ok}${entry.ok ? '' : ' error=' + JSON.stringify(entry.error)}`);
      return send(res, 200, { ok: true });
    }

    // ---------- 脚本取结果 ----------
    if (path === '/result' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id) return send(res, 400, { ok: false, error: 'ID_REQUIRED' });

      const hit = results.get(id);
      if (hit) return send(res, 200, { ready: true, ...hit });

      const w = { res, answered: false, timer: null };
      w.timer = setTimeout(() => {
        if (w.answered) return;
        w.answered = true;
        const l = resultWaiters.get(id) || [];
        resultWaiters.set(id, l.filter((x) => x !== w));
        send(res, 200, { ready: false, id, message: 'TIMEOUT' });
      }, waitMs(url.searchParams.get('wait'), RESULT_WAIT_SEC));

      const list = resultWaiters.get(id) || [];
      list.push(w);
      resultWaiters.set(id, list);

      res.on('close', () => {
        if (w.answered) return;
        w.answered = true;
        clearTimeout(w.timer);
        const l = resultWaiters.get(id) || [];
        resultWaiters.set(id, l.filter((x) => x !== w));
      });
      return;
    }

    return send(res, 404, { ok: false, error: 'NOT_FOUND', path });
  } catch (err) {
    return send(res, 400, { ok: false, error: err.message || 'BAD_REQUEST' });
  }
});

server.listen(PORT, HOST, () => {
  log(`桥接服务已启动：http://${HOST}:${PORT}`);
  log('等待 Chrome 扩展连接（扩展会向 /task 长轮询）...');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，换一个：node bridge.js --port 8788`);
  } else {
    console.error('服务错误：', e.message);
  }
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('正在关闭桥接服务...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000);
  });
}
