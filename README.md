# WorkBuddy 产物下载器（Chrome 扩展）v2.2

一键下载 [WorkBuddy](https://www.workbuddy.cn) 对话里的**产物**：逐个下载（保留真实目录结构）或打包成单个 ZIP。
v2.2 重点修复了 `.apkg` 被 Chrome 改写成 `.zip`、以及“修正后的文件跑到下载文件夹外面”的问题，并新增了产物搜索。

## v2.2 更新内容

| 需求 | 实现 |
| --- | --- |
| `.apkg` 逐个下载后被改成 `.zip` | 新增 **offscreen Blob 中继**：扩展自己读取文件字节，包成 `application/octet-stream` 的 Blob，再用 `chrome.downloads` 按完整相对路径保存。Chrome 不再按服务器 `application/zip` 改写扩展名 |
| 下载选中文件时文件跑到任务文件夹外 | 扩展名修正不再使用页面 `<a download>`（它只能存到下载根目录），改为 `chrome.downloads.download({ filename: '任务目录/...' })`，始终落在任务子目录内 |
| 搜索下载产物 | 弹窗顶部新增搜索框，按文件名 / 路径过滤；搜索状态下勾选与下载只作用于当前筛选结果 |
| 删掉「全不选」 | 已删除按钮；取消勾选「全选」复选框即可全不选 |
| 给下一个 AI 的交接手册 | 新增 `HANDOVER.md`，记录 `.apkg` / `.zip` 的根因、验证记录和设计取舍 |

## 安装 / 更新

1. 打开 `chrome://extensions/`
2. 右上角开启 **开发者模式**
3. 首次安装：点 **加载已解压的扩展程序**，选择本目录（包含 `manifest.json` 的那一层）
4. **覆盖更新：**
   - 用新版本文件覆盖原来的扩展目录（解压后整个文件夹覆盖即可）
   - 在扩展卡片上点 **刷新**（🔄）
   - **刷新 WorkBuddy 页面**（Ctrl+R）——旧页面里还运行着旧版 content script
5. 建议把扩展固定到工具栏

> 需要 Chrome 117+（`chrome.offscreen`、`runtime.getContexts`、`downloads.setUiOptions`）。

## 使用

1. 打开任意 WorkBuddy 对话页（`https://www.workbuddy.cn/app/conversation/<任务ID>`）
2. 点击扩展图标，弹窗会自动扫描产物
3. **搜索**：在顶部输入文件名或路径关键词，列表会实时过滤
   - 搜索状态下，「全选」只选择搜索结果；
   - 「逐个下载」「打包 ZIP」只处理“搜索结果 ∩ 已勾选”的文件；
   - 点「清除」恢复完整列表，之前勾选的隐藏项会恢复显示；
   - 文件特别多时列表只渲染前 600 条匹配项（避免卡顿），但全选/下载仍按全部匹配项计算，继续输入关键词即可缩小范围。
4. 勾选要下载的文件（默认全选）
5. 选择：
   - **逐个下载（已选 N 个）**：保留 `/workspace` 下的真实子目录，支持任意大小文件
   - **打包 ZIP（已选 N 个）**：把所有勾选文件打成一个 Zip
   - **双击某一行**：只单独下载这个文件
6. 点右上角「设置」可调整并发数、日志默认展开、进度 / 速度 / 剩余时间的口径
7. 下载过程中可以关闭弹窗，任务在后台继续

## 关于 `.apkg` 变成 `.zip`（重要）

Chrome 在下载时会根据服务器返回的 `Content-Type` **强制改写扩展名**：
WorkBuddy 文件服务把 `.apkg` 按 `application/zip` 返回，Chrome 就会把 `CET4_词汇.apkg` 存成 `CET4_词汇.zip`。
这不是扩展“文件名写错”，而是 Chrome 下载目标判定（DownloadTargetDeterminer）的安全策略；单靠 `chrome.downloads.download({ filename })`、`onDeterminingFilename` 或 DNR / webRequest 改响应头都不一定能绕过。

v2.2 的做法：

1. `.apkg` / `.colpkg` **预判走 offscreen Blob 中继**（始终启用，不受设置项影响）：`offscreen.js` 用 `X-Access-Token` 读取文件字节，包成 `application/octet-stream` 的 Blob，`URL.createObjectURL()` 得到扩展 origin 的 blob URL。
2. 后台 `background.js` 调用 `chrome.downloads.download({ url: blobUrl, filename: 'WorkBuddy产物_任务.../真实子目录/文件.apkg' })`。
3. 因为 Blob 的 MIME 是 `application/octet-stream`，Chrome 不会再按 ZIP 改写扩展名；`filename` 带完整子目录，文件会正确落在任务文件夹内。
4. 下载完成后释放 blob URL；offscreen 文档在任务结束后自动关闭。

**为什么必须用 offscreen：** MV3 service worker 没有 `URL.createObjectURL()`；而页面 content script 创建的 blob URL 属于页面 origin，传给后台后 Chrome 会忽略 `filename`（实测会存成 blob UUID）。offscreen 文档是扩展自己的 origin，且只支持 runtime API，所以由它创建 URL、后台负责下载，是官方推荐且可靠的组合。

其他扩展名如果仍被 Chrome 改写，`background.js` 会检测落盘扩展名，用同样的 Blob 中继按原路径重新保存，并删除错误副本。

## 权限说明

- `downloads`：发起下载、读取字节进度、隐藏下载 UI、清除本扩展的下载记录
- `storage`：设置、任务状态与日志持久化
- `alarms`：MV3 后台保活与任务恢复
- `activeTab` / `scripting`：页面早于插件安装打开时补注入内容脚本
- `offscreen`：创建隐藏文档，用 `fetch` + `URL.createObjectURL` 生成扩展 origin 的 Blob URL
- `https://www.workbuddy.cn/*`：读取对话页数据与会话接口
- `https://*.workbuddy.agentos-worker.net/*`：访问沙盒文件服务

扩展不收集、不上传任何数据，所有请求只发往 WorkBuddy 自己的服务。

## 目录结构

```
workbuddy-artifact-downloader/
├── manifest.json       扩展清单（MV3）
├── settings.js         共享设置与格式化（进度 / 速度 / 剩余时间口径）
├── background.js       任务调度：并发、下载 UI、清除记录、Blob 中继、扩展名修正
├── offscreen.html      offscreen 文档入口
├── offscreen.js        fetch 文件 + URL.createObjectURL（只使用 runtime API）
├── content.js          产物扫描 + ZIP 打包
├── zip.js              极简 ZIP 打包器（STORE，增量 CRC，异步进度）
├── popup.html/css/js   弹窗 UI（搜索 / 勾选 / 双击单独下载 / 活跃文件 / 日志）
├── options.html/css/js 设置页（并发、单位口径、日志、下载 UI）
├── logs.html/css/js    独立日志窗口
├── README.md           用户文档
└── HANDOVER.md         给下一个 AI 的交接手册（排查记录 / 不要重复踩的坑）
```

## 工作原理

```
弹窗  --WBDA2_START_JOB(勾选的文件)-->  background（任务管理器）
                                            |
                                            |-- 普通文件：chrome.downloads.download({
                                            |      url: <文件服务>/files?path=...,
                                            |      headers: X-Access-Token,
                                            |      filename: 'WorkBuddy产物_任务_时间/真实/子目录/文件'
                                            |   })
                                            |
                                            |-- .apkg / .colpkg / 扩展名兜底：
                                            |      background → offscreen（fetch 字节）
                                            |      offscreen → background（blob URL）
                                            |      background → chrome.downloads.download({
                                            |        url: blob URL（application/octet-stream）,
                                            |        filename: 'WorkBuddy产物_任务_时间/真实/子目录/文件.apkg'
                                            |      })
                                            |
                                            '-- ZIP：chrome.tabs.sendMessage 给 content.js
                                                  流式读取 + CRC + wbBuildZipAsync
                                                  <a download> 保存为单个 .zip
```

## 常见问题

**Q：更新后提示「页面里运行的还是旧版内容脚本」？**
A：按 Ctrl+R 刷新 WorkBuddy 页面即可。扩展更新不会自动替换已经注入到旧页面的脚本。

**Q：为什么 `.apkg` 下载时日志先显示“已读取”，再显示“完成”？**
A：因为 `.apkg` 走 Blob 中继：先把文件读进内存，再交给 Chrome 保存。读取阶段也会显示进度。

**Q：为什么下载时看不到任何下载气泡？**
A：这是 v2.1 起的默认行为（设置里可关闭）。任务结束会自动恢复浏览器下载 UI。

**Q：清除下载记录会不会把我以前的下载也删掉？**
A：不会。只会删除本扩展本次任务创建的下载 ID，历史记录保持原样，已下载的文件也不会被删除。

**Q：搜索后为什么“已选”数量变少了？**
A：搜索状态下只统计当前筛选结果的勾选数，「逐个下载 / 打包 ZIP」也只下载当前筛选结果，避免误下载隐藏文件。

**Q：`.apkg` 很大时会不会占内存？**
A：会。Blob 中继需要把文件完整读进 offscreen 文档内存（例如 100 MB 的牌组约 100 MB 内存）。建议 `.apkg` 并发不要调太高。普通文件仍然走流式下载，不受影响。

**Q：所有文件都失败，日志显示 `SERVER_UNAUTHORIZED`？**
A：扩展会自动刷新一次会话 Token 再重试。若仍失败，请刷新 WorkBuddy 页面、确认登录态后再试。

## 版本

- **v2.2.0**：`.apkg` / `.colpkg` 走 offscreen Blob 中继保持后缀并保留子目录；扩展名兜底不再落到下载根目录；新增产物搜索；删除「全不选」；新增交接手册。
- **v2.1.0**：可调并发、隐藏下载 UI、自动清除下载记录、日志默认展开、双击单文件下载、文件勾选、完整活跃列表、进度/速度/剩余时间双口径、DNR + 页面直存尝试（仍会被 Chrome 改写 `.apkg`）。
- **v2.0.0**：重写下载执行层；`chrome.downloads` + 请求头；字节级进度/速度/ETA；逐文件状态；持久化任务与日志；取消/重试/Token 刷新/断点恢复；ZIP 流式进度与增量 CRC。
- **v1.1.0**：ZIP 打包 + 逐个下载、四层产物扫描（已归档）。
