# WorkBuddy 产物下载器 · 给下一个 AI 的交接手册

- 版本：v2.2.0
- 交接日期：2026-11-09
- 源码目录：`workbuddy-artifact-downloader/`
- 扩展 ID（当前用户机器）：`eglddnndecmjkioimmcofmiagbbcdkhl`

这是一份“踩坑记录 + 设计说明”。下次接手时先读这里，不要重新搜索同样的内容。

---

## 1. 用户这次提出的 5 件事与状态

| # | 用户需求 | 状态 | 实现位置 |
| --- | --- | --- | --- |
| 1 | `.apkg` 逐个下载后变成 `.zip`，要保留原后缀 | 已修复 | `background.js` 的 `startBlobDownload` + `offscreen.js` |
| 2 | 在扩展文件夹里新增给下一个 AI 的交接手册 | 已新增 | 本文件 `HANDOVER.md` |
| 3 | 下载选中文件时建了文件夹，但文件最后落在文件夹外 | 已修复 | `fixExtensionIfNeeded` 改用带完整相对路径的 `chrome.downloads.download` |
| 4 | 删掉界面上的「全不选」 | 已删除 | `popup.html` / `popup.js` |
| 5 | 界面顶部增加产物搜索 | 已新增 | `popup.html` / `popup.css` / `popup.js` |

---

## 2. 最重要结论：为什么 `.apkg` 会变 `.zip`

**根因不在扩展的文件名参数，而在 Chrome 的下载目标判定（DownloadTargetDeterminer）。**

- WorkBuddy 文件服务对 `.apkg` 返回的 `Content-Type` 是 `application/zip`。
- Chrome 发现“文件名的扩展名”和 MIME 不匹配时，会按 MIME 强制把落盘扩展名改成 `.zip`。
- `chrome.downloads.download({ filename: 'xxx.apkg' })` 的 `filename` 不能可靠阻止这个改写。
- 用 `webRequest` / `declarativeNetRequest` 修改响应头 `Content-Type`，在下载 API 场景下也不可靠（上一版 v2.1 已经试过 DNR，仍会复现）。
- `chrome.downloads.onDeterminingFilename` 里 `suggest()` 也不能可靠阻止。

参考（这些是实际查过的资料，不用再搜）：

- StackOverflow 63045043：Chrome extension doing a download can't always specify file extension?
  - 关键结论：Chrome 会按 MIME 强制扩展名；唯一可靠做法是自己 `fetch` 字节，包成 `application/octet-stream` 的 Blob，再下载这个 blob URL。
  - https://stackoverflow.com/questions/63045043/chrome-extension-doing-a-download-cant-always-specify-file-extension
- Chromium issue 437316556：File extension replaced when downloading with `chrome.downloads`
  - https://issues.chromium.org/issues/437316556
- Chromium issue 40453079：`filename` parameter for `chrome.downloads.download`...
  - https://issues.chromium.org/issues/40453079
- Chrome offscreen API 文档（Reason 枚举含 `BLOBS`；offscreen 文档只支持 runtime API）
  - https://developer.chrome.com/docs/extensions/reference/api/offscreen

### 当前采用的可靠方案

1. `offscreen.js` 用带 `X-Access-Token` 的 `fetch` 把文件完整读成 `Uint8Array` 分片。
2. 用 `new Blob(chunks, { type: 'application/octet-stream' })` 重新包一层。
3. `URL.createObjectURL(blob)` 得到 `blob:chrome-extension://...` URL。
4. `background.js` 调 `chrome.downloads.download({ url: blobUrl, filename: '任务目录/真实子目录/文件.apkg' })`。
5. 下载完成后 `URL.revokeObjectURL`，并关闭 offscreen 文档。

### 为什么必须用 offscreen，不能用页面内容脚本的 blob URL

已经用真实下载验证过：

- `chrome.downloads.download` 传**页面（https://www.workbuddy.cn）创建的 blob URL** 时，`filename` 会被忽略，落盘变成 blob UUID（无扩展名），位于下载根目录。
  - 验证记录：下载 id 6239，`filename: C:\Users\enoog\Downloads\c5ffcadc-...`，mime `application/octet-stream`。
- `chrome.downloads.download` 传 `data:` URL 时，`filename` 也会被忽略，落盘变成 `download.zip`。
  - 验证记录：下载 id 6238。
- 因此：**必须用扩展自己 origin 的 blob URL**（offscreen 文档创建），后台 `chrome.downloads` 才会认 `filename` 和子目录。

### 为什么不能用 `<a download>` 做兜底

页面里的 `<a download>` 的 `download` 属性只能给“纯文件名”，浏览器会忽略路径分隔符，文件一定落在系统“下载”根目录。旧版 v2.1 的兜底就是这样：先建了任务文件夹，兜底修正后的 `.apkg` 却落在文件夹外，正好是用户第 3 条抱怨。

---

## 3. 关键实现细节 / 坑

### 3.1 MV3 offscreen 的限制

Chrome 官方文档明确写：

> The `runtime` API is the only extensions API supported by offscreen documents.

所以 offscreen 里**不能**直接 `chrome.downloads.download`，必须把 blob URL 回传给 service worker，由 SW 调下载 API。

### 3.2 检查 offscreen 是否存在

- `chrome.offscreen.hasDocument()` 是 Chrome 150+ 才有的 API，当前最低版本 117 不能用。
- 用 `chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL('offscreen.html')] })` 检查（Chrome 116+）。
- 并发创建会报“只能有一个 offscreen document”，所以 `background.js` 用 `offscreenCreating` Promise 做了并发锁。

### 3.3 `.apkg` / `.colpkg` 走预判路径

`background.js`：

```js
const BLOB_ROUTE_EXTENSIONS = new Set(['.apkg', '.colpkg']);
```

满足扩展名的文件一开始就走 Blob 中继，不会先产生一个 `.zip` 再删除。
这条路径**始终启用**，不受 `settings.fixFileExtension` 影响；设置项只控制其他类型被改写后的兜底修正。

其他扩展名如果仍被 Chrome 改写，`fixExtensionIfNeeded` 会在下载完成后用同样的 Blob 中继按“原完整路径”重新保存，再删掉错误副本。这是兜底，不会经常触发。

### 3.4 保存路径必须带 `dirName`

所有 `chrome.downloads.download` 的 `filename` 都是：

```
WorkBuddy产物_任务名_任务ID_时间/真实相对路径/文件名
```

不要只传 `basename`，否则就会重现“文件在文件夹外”。

### 3.5 搜索与勾选语义

- 顶部搜索框按 `rel` / `name` 做不区分大小写的子串匹配。
- **搜索状态下**：
  - 列表只显示匹配项；
  - 「全选」只作用于匹配项；
  - 「逐个下载 / 打包 ZIP」只下载“匹配项 ∩ 已勾选”。
- 清空搜索后，之前勾选的隐藏项会恢复显示；这是有意设计，避免搜索时误删用户的选择。
- `popup.js` 里 `selectedFiles()` 和 `updateSelectionUi()` 都按 `searchQuery` 过滤。
- 列表最多渲染 600 条匹配项（`MAX_RENDER_FILES`），避免 1 万+ 产物时卡顿；全选/下载仍按全部匹配项计算。

### 3.6 「全不选」已删除

- `popup.html` 不再有 `#btn-select-none`。
- `popup.js` 不再绑定它。
- 取消勾选「全选」复选框即可全不选（无搜索时）。

---

## 4. 文件清单（v2.2）

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | MV3 清单；新增 `offscreen` 权限，移除 `declarativeNetRequest` |
| `background.js` | 任务调度、并发、进度、Blob 中继、扩展名修正、下载记录清理 |
| `offscreen.html` / `offscreen.js` | 隐藏文档：fetch 文件 + `URL.createObjectURL`，只使用 runtime API |
| `content.js` | 产物扫描、ZIP 打包；页面直存兜底已删除 |
| `zip.js` | 极简 ZIP 打包器 |
| `popup.html/css/js` | 弹窗 UI：搜索、勾选、双击单文件、日志 |
| `options.html/css/js` | 设置页 |
| `logs.html/css/js` | 独立日志窗口 |
| `settings.js` | 共享设置与格式化 |
| `README.md` | 用户文档 |
| `HANDOVER.md` | 本文件 |

---

## 5. 已验证 / 未验证

### 已验证

- 旧版下载记录 id 6199 / 6201：`.apkg` 落盘为 `.zip`（旧版问题复现）。
- 新版下载记录 6234–6237：最终文件为 `.apkg`，但 `finalUrl` 是页面 blob、且没有 `byExtensionId`，说明是旧版 `<a download>` 兜底，文件在下载根目录。这正是第 3 条问题的证据。
- 试验 6238：`data:` URL + 指定 `filename` → 落盘 `download.zip`，`filename` 被忽略。
- 试验 6239：页面 origin 的 blob URL + 指定 `filename` → 落盘 blob UUID，`filename` 被忽略。
- 源码静态检查：见 `jscheck` 技能 / 打包时的语法检查。

### 需要在用户机器上验证

由于无法直接运行用户安装的扩展，以下两点需要在用户重新加载扩展后实测：

1. offscreen 文档 fetch 能否带 `X-Access-Token` 正常读取 WorkBuddy 文件服务（理论上 host_permissions 允许）。
2. offscreen 创建的 blob URL + `chrome.downloads.download({ filename: '目录/文件.apkg' })` 是否落在任务目录内（按 Chrome 文档和 SO 方案应当可以）。

如果第 1 点失败：把 `offscreen.js` 的 `fetch` 改成由 content script 读取字节，再通过 `chrome.runtime.sendMessage` 把 `ArrayBuffer` 传给 offscreen（注意大文件内存），或者由 offscreen 使用 `mode: 'cors'` / 检查 `Origin` 限制。

如果第 2 点失败：检查 `onDeterminingFilename` 是否覆盖了文件名；可临时移除该监听器测试。

---

## 6. 下次修改 / 测试建议

1. 修改后在 `chrome://extensions` 点扩展卡片上的刷新按钮。
2. **必须刷新 WorkBuddy 页面**（Ctrl+R），否则旧 content script 还在页面里。
3. 测 `.apkg`：随便下载一个小的 `.apkg`，看日志里是否出现：
   - `已读取 xxx.apkg ... 正在保存`
   - `完成 xxx.apkg`
   然后检查 `下载\WorkBuddy产物_...\...\xxx.apkg`。
4. 测搜索：输入 `apkg` / `CET4`，确认列表过滤、已选数、下载按钮文案同步变化。
5. 测文件夹：下载一个被 Chrome 改写的非 `.apkg` 文件，确认修正后的文件仍在任务子目录中，而不是下载根目录。
6. 测「全不选」：取消勾选「全选」，确认所有复选框取消；界面上不应再有「全不选」字样。

---

## 7. 不要重复踩的坑

- ❌ 不要再试图用 `declarativeNetRequest` / `webRequest` 改 `Content-Type` 来修 `.apkg`；上一版已试过，仍会变 `.zip`。
- ❌ 不要只改 `onDeterminingFilename` 的 `suggest({ filename: 'x.apkg' })`；Chrome 仍可能按 MIME 改写。
- ❌ 不要用 content script 的 blob URL 传给 background 下载；跨 origin，`filename` 会被忽略（实测 6239）。
- ❌ 不要用 `data:` URL 传给 `chrome.downloads.download`；`filename` 会被忽略（实测 6238）。
- ❌ 不要用页面 `<a download>` 做需要保留目录的下载；它只能落下载根目录。
- ❌ 不要在 offscreen 文档里调用 `chrome.downloads`；offscreen 只支持 `runtime` API。
- ✅ 用 offscreen + `application/octet-stream` Blob + 完整相对 `filename`。

---

## 8. 用户原始需求原文（备查）

1. 如果是下载 `.apkg` 文件，逐个下载后会下成 `.zip`。这不行。需要保持原来的后缀。我其实已经让上一个 agent 改过了，但是改完还是出现了下下来后缀变成 `.zip` 的情况。
2. 文件夹中新增一个给下一个 AI 的交接手册，告诉它你花时间解决的东西，或者搜索得到的信息，这样它就不用再搜一遍。
3. 下载选中的文件的时候，会在“下载”文件夹中创建文件夹，这和下载全部是一样的，但是最终下载下来，会到创建的文件夹外面去。这个要修改。
4. 删去插件界面上的“全不选”字样，因为取消勾选全选的前面的勾选框就是全不选，不用专门设置一个按钮。
5. 扩展界面顶部增加搜索功能，要能搜索下载产物。
