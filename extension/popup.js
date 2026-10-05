/** popup.js —— 状态显示与手动读取 */

const $ = (id) => document.getElementById(id);
const dot = $('dot'), status = $('status'), meta = $('meta'), out = $('out');
const readBtn = $('read'), copyBtn = $('copy');

let lastText = '';

function setStatus(state, text) {
  dot.className = 'dot' + (state === 'on' ? ' on' : state === 'off' ? ' off' : '');
  status.textContent = text;
}

async function checkHealth() {
  setStatus('', '正在检查桥接服务…');
  const res = await chrome.runtime.sendMessage({ type: 'health' });
  if (res && res.ok) {
    const h = res.health;
    setStatus('on', `桥已连接 · 127.0.0.1:${h.port}`);
  } else {
    setStatus('off', `连不上桥服务：${(res && res.error) || '未知错误'}`);
    meta.textContent = '请先在终端运行：node bridge.js';
  }
}

async function readNow() {
  readBtn.disabled = true;
  setStatus('', '正在读取当前页…');
  const res = await chrome.runtime.sendMessage({ type: 'readNow' });
  readBtn.disabled = false;

  if (!res || !res.ok) {
    const e = (res && res.error) || {};
    setStatus('off', `读取失败：${e.code || ''} ${e.message || ''}`.trim());
    return;
  }
  const d = res.data;
  lastText = d.text || '';
  copyBtn.disabled = !lastText;
  setStatus('on', `已读取 ${lastText.length} 字`);
  meta.textContent = `${d.title}\n${d.url}${d.truncated ? '\n（正文已截断到 30000 字）' : ''}`;
  out.hidden = false;
  out.textContent = lastText.slice(0, 1500) + (lastText.length > 1500 ? '\n…（预览截断）' : '');
}

readBtn.addEventListener('click', readNow);

copyBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(lastText);
  copyBtn.textContent = '已复制';
  setTimeout(() => { copyBtn.textContent = '复制正文'; }, 1200);
});

checkHealth();
