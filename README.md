# chrome-read-bridge

**Let your AI assistant read pages inside the Chrome you're already logged into.**

A tiny Chrome extension reads the page from *inside* the browser and ships the text out over a loopback bridge — so your assistant can read login-gated and JavaScript-rendered pages, without ever touching your cookies.

[中文说明 →](#中文说明)

---

## English

### Why this exists

Since **Chrome 136**, `--remote-debugging-port` is **silently ignored** when it targets the default profile directory. Google did this to stop infostealers from exporting Chrome cookies over the debugging port. The practical consequence: **CDP can no longer attach to your real, logged-in Chrome.**

| Approach | Logged-in state? | Assistant can read? |
| --- | --- | --- |
| CDP against your daily Chrome | ✅ | ❌ blocked by Chrome 136+ |
| CDP against an isolated profile | ❌ | ✅ |
| **This project (extension + bridge)** | ✅ | ✅ |

Copying your profile elsewhere does **not** work either: Chrome 127+ App-Bound Encryption binds cookies to the original profile path and machine, so they cannot be decrypted after a copy — and copying credentials is a security risk anyway.

### How it works

```
read-page.js  ──POST /cmd────▶  bridge.js  ◀──GET /task (long-poll)──  extension worker
     ▲                        127.0.0.1:8787                              │
     └───────GET /result────────────┘                        chrome.scripting reads the tab
                                                                          ▼
                                                                your logged-in tab
```

| Component | Role |
| --- | --- |
| `bridge.js` | Loopback HTTP bridge. Zero dependencies. Listens on `127.0.0.1:8787` only. |
| `extension/` | Chrome MV3 extension. Reads pages from inside your browser. |
| `read-page.js` | CLI. Sends commands, prints results. |

**Requirements:** Node.js 22+ (only for its built-in `fetch`), and Google Chrome. No npm install, no third-party packages.

### Install

```bash
# 1. Start the bridge (keep this terminal open)
node bridge.js
```

2. Load the extension:

- Open `chrome://extensions`
- Turn on **Developer mode** (top right)
- Click **Load unpacked**
- ⚠️ **Select the `extension` subfolder** — the one that directly contains `manifest.json`.
  Selecting the repo root fails with *"Manifest file is missing or unreadable"*.

3. Verify — click the extension icon; it should say **bridge connected**. Then:

```bash
node read-page.js tabs
```

If your tabs are listed, the whole chain works.

### Usage — opening a page in Chrome and reading it

```bash
# List every tab
node read-page.js tabs

# Read the currently active tab
node read-page.js read

# Read a tab by URL fragment (no window switching needed)
node read-page.js read url:github.com

# Read a specific tab by id (ids come from `tabs`)
node read-page.js read 123456789

# Open a URL in the Chrome you are logged into
node read-page.js open https://github.com
```

**Full workflow for "open this link and read it":**

1. `node read-page.js open <url>` — takes the returned `tabId`.
2. Wait ~8–12 seconds for the page to render (heavy SPAs need it).
3. `node read-page.js tabs` — confirm the tab's URL/title now show the expected page.
4. `node read-page.js read <tabId>` — prints title, URL, `readyState`, and up to 30,000 characters of body text.

Because the extension runs inside your everyday Chrome, whatever that browser is logged into is what gets read. Nothing is faked or inferred.

### Security

This deliberately opens a page-reading channel inside your browser. Please read this.

- The extension needs `<all_urls>` + `scripting`, meaning it can read the text of **any page you visit**. That is the necessary cost of reading login-gated pages.
- The bridge binds to `127.0.0.1` only and is never exposed to the network — but **any local process** can send it commands. Same trust model as a debugging port.
- It reads **plain body text only**. It never reads cookies, `localStorage`, passwords, or form values, and never exports credentials.
- Disable or remove the extension from `chrome://extensions` whenever you don't need it.

### Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| *Manifest file is missing or unreadable* | You selected the repo root. Select the `extension` subfolder. |
| Popup says bridge not connected | Bridge isn't running. Run `node bridge.js`. |
| CLI says *extension not connected* | Extension not loaded, or its service worker was suspended. Open the popup once to wake it. |
| `READ_FAILED` | The tab is a `chrome://` page, an extension page, or the Web Store — browsers block injection there. Expected. |
| Port already in use | Use `node bridge.js --port 8788` and change `BRIDGE` in `extension/background.js` to match. |

### Known limitations

- `chrome://` pages, extension pages, and the Web Store cannot be injected.
- The extension returns `document.body.innerText`, which **drops semantic labels carried by icons**. On Douyin, for example, the four engagement numbers arrive with no text labels and must be inferred from the page's standard ordering.
- Fields the page never displays (such as Douyin view counts) cannot be obtained — and are not estimated from other numbers.

### License

MIT — see [LICENSE](LICENSE).

---

## 中文说明

**让你已在登录状态的 Chrome，把页面内容交给 AI 读取。**

一个很小的 Chrome 扩展在你**浏览器内部**读取页面，再通过本地回环桥把正文传出来。于是需要登录态的页面、纯前端渲染的页面都能读，而且完全不碰你的 Cookie。

### 为什么需要它

从 **Chrome 136** 起，当 `--remote-debugging-port` 指向默认配置目录时会被**静默忽略**。Google 这么做是为了阻止信息窃取程序通过调试端口导出 Chrome Cookie。直接后果是：**调试协议再也无法接管你那个已登录的日常 Chrome。**

| 方案 | 有登录态？ | AI 能读？ |
| --- | --- | --- |
| 用调试协议接管日常 Chrome | ✅ | ❌ 被 Chrome 136+ 阻止 |
| 用调试协议 + 独立配置 | ❌ | ✅ |
| **本项目（扩展 + 桥）** | ✅ | ✅ |

把配置目录复制到别处同样行不通：Chrome 127+ 的 App-Bound Encryption 会把 Cookie 绑定到原配置路径与机器身份，复制后**无法解密**；而且复制凭据本身就带来泄露风险。

### 工作原理

```
read-page.js ──POST /cmd────▶ bridge.js ◀──长轮询 /task── 扩展 service worker
     ▲                      127.0.0.1:8787                        │
     └──────GET /result───────────┘                  chrome.scripting 读取标签页
                                                                    ▼
                                                          你已登录的标签页
```

| 部件 | 作用 |
| --- | --- |
| `bridge.js` | 本地回环 HTTP 桥。零第三方依赖，只监听 `127.0.0.1:8787`。 |
| `extension/` | Chrome MV3 扩展，在你的浏览器里读页面。 |
| `read-page.js` | 命令行入口，下指令并打印结果。 |

**环境要求**：Node.js 22+（只用其内置 `fetch`）和 Google Chrome。无需 `npm install`，无任何第三方包。

### 安装

```bash
# 第 1 步：启动桥接服务（保持这个终端开着）
node bridge.js
```

第 2 步，加载扩展：

- 打开 `chrome://extensions`
- 打开右上角 **开发者模式**
- 点 **加载已解压的扩展程序**
- ⚠️ **必须选中 `extension` 子目录**——也就是直接包含 `manifest.json` 的那一层。
  如果选中仓库根目录，会报错 *「清单文件缺失或不可读取 / 无法加载清单」*。

第 3 步，验证：点一下扩展图标，应显示**桥已连接**。然后：

```bash
node read-page.js tabs
```

能列出你的标签页，说明整条链路通了。

### 使用：在 Chrome 中打开网页并读取

```bash
# 列出全部标签页
node read-page.js tabs

# 读取当前活动标签页
node read-page.js read

# 按 URL 片段指定标签页（不用切窗口）
node read-page.js read url:github.com

# 按 tabId 指定（id 来自 tabs 的输出）
node read-page.js read 123456789

# 在你已登录的 Chrome 中打开一个链接
node read-page.js open https://github.com
```

**「打开某个链接并读取」的完整步骤：**

1. `node read-page.js open <url>` —— 记下返回的 `tabId`。
2. 等 8–12 秒让页面完成渲染（重前端页面必需，过早读取只能拿到「加载中」）。
3. `node read-page.js tabs` —— 确认该标签页的 URL 与标题已变成目标页面。
4. `node read-page.js read <tabId>` —— 打印标题、地址、`readyState` 和最多 30000 字的正文。

因为扩展运行在你日常的 Chrome 里，**那个浏览器登录了什么，读到的就是什么**。不会伪造，也不会推断。

### 安全边界

这个方案本质上是**在你的浏览器里开了一条读页面的通道**，权限不低，请务必了解：

- 扩展需要 `<all_urls>` 与 `scripting` 权限，意味着它能读取你访问的**任意页面**正文。这是「读有登录态页面」的必要代价。
- 桥只绑定 `127.0.0.1`，不对外网暴露 —— 但**本机任何程序**都能向它下指令。与调试端口同级的信任模型。
- 只读取**正文纯文本**，不读取 Cookie、`localStorage`、密码或表单值，不导出任何登录凭据。
- 不需要时，随时在 `chrome://extensions` 停用或移除扩展。

### 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 报「清单文件缺失或不可读取」 | 选错目录了。要选中 `extension` 这一层（直接含 `manifest.json`）。 |
| 扩展弹窗显示「连不上桥服务」 | 桥没启动。运行 `node bridge.js`。 |
| CLI 提示「扩展还没连上」 | 扩展未加载，或其 service worker 被回收。打开一次扩展弹窗即可唤醒。 |
| `READ_FAILED` | 目标是 `chrome://` 页、扩展页或应用商店 —— 浏览器禁止注入，属正常。 |
| 端口被占用 | 换端口：`node bridge.js --port 8788`，并把 `extension/background.js` 里的 `BRIDGE` 常量改成一致后重新加载扩展。 |

### 已知限制

- `chrome://` 内部页、扩展页、应用商店无法注入。
- 扩展取的是 `document.body.innerText`，**会丢失图标上承载的语义标签**。例如抖音的四个互动数字没有文字标签，只能按页面标准布局顺序推断。
- 页面从不展示的字段（如抖音播放量）无法获取，也不应拿其他数字推算。

### 许可证

MIT，详见 [LICENSE](LICENSE)。
