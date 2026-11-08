/* ============================================================
 * WorkBuddy 产物下载器 — 后台服务 (background.js) v2.1
 *
 * v2.1 新增：
 *   - 并发数可配置（settings.concurrency，默认 3）；
 *   - 下载时隐藏 Chrome 下载气泡 / 下载动画（downloads.setUiOptions）；
 *   - 下载完成即清除本扩展产生的下载记录（downloads.erase），保留历史记录；
 *   - 强制保留真实扩展名：DNR 中和 MIME + onDeterminingFilename + 页面直存兜底，
 *     避免 .apkg 被 Chrome 按 application/zip 改写成 .zip；
 *   - 活跃下载列表返回全部并发文件（不再只取 1~5 个）；
 *   - 同时计算「字节口径」与「文件个数口径」的进度、速度、剩余时间；
 *   - 支持双击单文件下载（WBDA2_DOWNLOAD_ONE）；
 *   - 只下载弹窗里勾选的文件。
 * ============================================================ */

importScripts('settings.js');

const JOB_KEY = 'wbda.job.v2';
const KEEPALIVE_ALARM = 'wbda-job-keepalive';
const MAX_LOGS = 1000;
const BROADCAST_MS = 400;
const PERSIST_DEBOUNCE_MS = 900;
const STALL_MS = 180000; // 单个文件 180 秒没有任何新字节 → 判定卡死并重试
const ZIP_WATCHDOG_MS = 180000;
const MAX_RETRIES = 2;
const MIME_RULE_ID = 9101;

let settings = Object.assign({}, WBDA.DEFAULTS);
let job = null;
let initPromise = null;
let runnerActive = false;
let persistTimer = null;
let broadcastTimer = null;
let progressTimer = null;
let ticker = null;
let samples = [];
let uiDisabled = false;
let settingsPromise = null;

/** downloadId -> { finish(result), file } */
const waiters = new Map();
/** url -> { filename, at }，供 onDeterminingFilename 强制文件名 */
const pendingNames = new Map();

/* ------------------------------------------------------------
 * 基础工具
 * ---------------------------------------------------------- */
const now = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error((label || '操作') + '超时')), ms);
    }),
  ]);
}

function fmtBytes(n) {
  return WBDA.fmtBytes(n);
}

function fmtDuration(ms) {
  return WBDA.fmtDuration(ms);
}

function sanitizeSegment(seg) {
  let s = String(seg == null ? '' : seg)
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/[. ]+$/g, '');
  if (!s) s = '_';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = '_' + s;
  if (s.length > 90) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : '';
    s = s.slice(0, Math.max(12, 90 - ext.length)) + ext;
    s = s.replace(/[. ]+$/g, '') || '_';
  }
  return s;
}

function buildSafeRel(rel) {
  const parts = String(rel == null ? '' : rel)
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((p) => (p === '..' || p === '.' ? '_' : sanitizeSegment(p)));
  return parts.join('/') || '_';
}

function basename(p) {
  const s = String(p == null ? '' : p);
  const parts = s.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

function extOf(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i).toLowerCase() : '';
}

function safeBaseName(p) {
  return sanitizeSegment(basename(p));
}

function buildDirName(taskName, taskId) {
  let name = String(taskName || 'task')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (name.length > 50) name = name.slice(0, 50);
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '_' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds());
  return 'WorkBuddy产物_' + (name || 'task') + '_' + taskId + '_' + stamp;
}

function buildSingleDirName(taskName) {
  let name = String(taskName || 'task')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (name.length > 30) name = name.slice(0, 30);
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '_' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds());
  return 'WorkBuddy产物_单文件_' + (name || 'task') + '_' + stamp;
}

function filenameFor(dirName, f, flat) {
  if (flat) {
    return dirName + '/' + sanitizeSegment(String(f.rel || f.name || 'file').replace(/[\\/]+/g, '_'));
  }
  let name = dirName + '/' + buildSafeRel(f.rel);
  let bytes = 0;
  try {
    bytes = new TextEncoder().encode(name).length;
  } catch (e) {
    bytes = name.length;
  }
  if (name.length > 220 || bytes > 240) {
    const base = String(f.rel || '').split('/').pop() || 'file';
    name =
      dirName +
      '/_long_paths/' +
      String((f.index || 0) + 1).padStart(4, '0') +
      '_' +
      sanitizeSegment(base);
  }
  return name;
}

/* ------------------------------------------------------------
 * 设置 / 下载 UI / 下载记录
 * ---------------------------------------------------------- */
async function ensureSettings() {
  if (!settingsPromise) {
    settingsPromise = WBDA.load()
      .then((s) => {
        settings = s;
        return s;
      })
      .catch(() => settings);
  }
  return settingsPromise;
}

WBDA.onChange((s) => {
  settings = s;
});

async function setDownloadUiDisabledRaw(disabled) {
  if (uiDisabled === disabled) return;
  try {
    await chrome.downloads.setUiOptions({ enabled: !disabled });
    uiDisabled = disabled;
    return;
  } catch (e) {
    /* 旧版 Chrome 走 shelf 兜底 */
  }
  try {
    chrome.downloads.setShelfEnabled(!disabled);
    uiDisabled = disabled;
  } catch (e) {
    /* ignore */
  }
}

async function setDownloadUiDisabled(disabled) {
  if (!settings.hideDownloadUi) {
    await setDownloadUiDisabledRaw(false);
    return;
  }
  await setDownloadUiDisabledRaw(disabled);
}

async function resetDownloadUi() {
  uiDisabled = true; // 强制同步一次，避免上次异常退出后 UI 一直隐藏
  await setDownloadUiDisabledRaw(false);
}

async function eraseDownloadRecord(id) {
  if (!settings.clearDownloadHistory || id == null) return;
  try {
    await chrome.downloads.erase({ id });
  } catch (e) {
    /* ignore */
  }
}

async function eraseByUrl(url) {
  if (!settings.clearDownloadHistory || !url) return;
  for (let i = 0; i < 8; i++) {
    let items = [];
    try {
      items = await chrome.downloads.search({ url });
    } catch (e) {
      items = [];
    }
    const ready = (items || []).filter((it) => it && it.state !== 'in_progress');
    if (ready.length) {
      for (const it of ready) await eraseDownloadRecord(it.id);
      return;
    }
    await sleep(400);
  }
}

/* ------------------------------------------------------------
 * MIME 中和规则：避免 Chrome 按服务器 Content-Type 改写扩展名
 * （.apkg 被 application/zip 改成 .zip 的根因）
 * ---------------------------------------------------------- */
async function ensureMimeRule() {
  const dnr = chrome.declarativeNetRequest;
  if (!dnr || !dnr.updateSessionRules) return;
  try {
    const existing = dnr.getSessionRules ? await dnr.getSessionRules() : [];
    if (Array.isArray(existing) && existing.some((r) => r && r.id === MIME_RULE_ID)) return;
  } catch (e) {
    /* ignore */
  }

  const baseCondition = { urlFilter: '||workbuddy.agentos-worker.net/files' };
  const action = {
    type: 'modifyHeaders',
    responseHeaders: [
      { header: 'content-type', operation: 'set', value: 'application/octet-stream' },
      { header: 'content-disposition', operation: 'remove' },
    ],
  };

  const variants = [
    // 只命中带 X-Access-Token 的请求（即本扩展的下载/读取），不影响页面预览
    Object.assign({}, baseCondition, { requestHeaders: [{ header: 'x-access-token' }] }),
    Object.assign({}, baseCondition, { resourceTypes: ['other'] }),
  ];

  for (const condition of variants) {
    try {
      await dnr.updateSessionRules({
        removeRuleIds: [MIME_RULE_ID],
        addRules: [{ id: MIME_RULE_ID, priority: 1, action, condition }],
      });
      return;
    } catch (e) {
      /* 尝试下一种写法 */
    }
  }
}

/* ------------------------------------------------------------
 * 任务状态 / 日志
 * ---------------------------------------------------------- */
function jobLog(j, level, msg) {
  if (!j) return;
  if (!Array.isArray(j.logs)) j.logs = [];
  const line = { t: now(), level: level || 'info', msg: String(msg == null ? '' : msg) };
  j.logs.push(line);
  if (j.logs.length > MAX_LOGS) j.logs.splice(0, j.logs.length - MAX_LOGS);
  j.lastEventAt = now();
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  try {
    fn('[WBDA]', line.msg);
  } catch (e) {
    /* ignore */
  }
  scheduleBroadcast(j);
}

function publicJob(j) {
  if (!j) return null;
  const activeFiles = j.files
    .filter((f) => f.status === 'downloading')
    .map((f) => ({
      index: f.index,
      rel: f.rel,
      bytes: f.bytes || 0,
      size: Number.isFinite(f.size) ? f.size : null,
      percent: f.size ? Math.min(100, Math.round(((f.bytes || 0) / f.size) * 100)) : null,
      attempts: f.attempts || 0,
    }));
  return {
    id: j.id,
    mode: j.mode,
    single: !!j.single,
    taskId: j.taskId,
    taskName: j.taskName,
    status: j.status,
    phase: j.phase,
    dirName: j.dirName,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    elapsedMs: (j.finishedAt || now()) - j.startedAt,
    concurrency: j.concurrency || settings.concurrency,
    totalFiles: j.totalFiles,
    completedFiles: j.completedFiles,
    failedFiles: j.failedFiles,
    totalBytes: j.totalBytes,
    downloadedBytes: j.downloadedBytes,
    percent: j.percent || 0,
    percentBytes: j.percentBytes || 0,
    percentFiles: j.percentFiles || 0,
    speed: j.speed || 0,
    speedBytes: j.speedBytes || 0,
    speedFiles: j.speedFiles || 0,
    etaSeconds: j.etaSeconds == null ? null : j.etaSeconds,
    etaBytes: j.etaBytes == null ? null : j.etaBytes,
    etaFiles: j.etaFiles == null ? null : j.etaFiles,
    currentFile: j.currentFile || '',
    currentFileBytes: j.currentFileBytes || 0,
    currentFileTotal: j.currentFileTotal || 0,
    activeFiles,
    packingDone: j.packingDone || 0,
    packingTotal: j.packingTotal || 0,
    files: j.files.map((f) => ({
      index: f.index,
      rel: f.rel,
      name: f.name,
      size: f.size,
      status: f.status,
      bytes: f.bytes || 0,
      error: f.error || null,
      attempts: f.attempts || 0,
    })),
    logs: j.logs.slice(-MAX_LOGS),
    result: j.result || null,
    cancelRequested: !!j.cancelRequested,
  };
}

function scheduleBroadcast(j) {
  if (broadcastTimer) return;
  // 文件特别多时降低快照频率，避免每次都序列化上千条记录
  const size = j && j.totalFiles ? j.totalFiles : 0;
  const delay = size > 1500 ? 1200 : size > 500 ? 700 : BROADCAST_MS;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    if (!j || j !== job) return;
    try {
      chrome.runtime.sendMessage({ type: 'WBDA2_JOB_UPDATE', job: publicJob(j) }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      /* 弹窗可能已关闭 */
    }
  }, delay);
}

function schedulePersist(j, immediate) {
  if (!j) return;
  if (immediate) {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    try {
      chrome.storage.session.set({ [JOB_KEY]: j }).catch(() => {});
    } catch (e) {
      /* ignore */
    }
    return;
  }
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!job) return;
    try {
      chrome.storage.session.set({ [JOB_KEY]: job }).catch(() => {});
    } catch (e) {
      /* ignore */
    }
  }, PERSIST_DEBOUNCE_MS);
}

/* ------------------------------------------------------------
 * 进度汇总（字节口径 + 文件个数口径）
 * ---------------------------------------------------------- */
function sampleSpeeds(downloaded, completed) {
  const t = now();
  samples.push({ t, bytes: downloaded, files: completed });
  const windowMs = 6000;
  while (samples.length > 2 && t - samples[0].t > windowMs) samples.shift();
  const a = samples[0];
  const b = samples[samples.length - 1];
  const dt = (b.t - a.t) / 1000;
  if (!(dt > 0.8)) return { speedBytes: 0, speedFiles: 0 };
  return {
    speedBytes: Math.max(0, (b.bytes - a.bytes) / dt),
    speedFiles: Math.max(0, (b.files - a.files) / dt),
  };
}

function recompute(j) {
  if (!j) return;
  let completed = 0;
  let failed = 0;
  let downloaded = 0;
  let knownBytes = 0;
  const active = [];

  for (const f of j.files) {
    if (Number.isFinite(f.size)) knownBytes += f.size;
    if (f.status === 'done') {
      completed++;
      downloaded += Number.isFinite(f.bytes) ? f.bytes : f.size || 0;
    } else if (f.status === 'failed') {
      failed++;
    } else if (f.status === 'downloading') {
      downloaded += f.bytes || 0;
      active.push(f);
    }
  }

  j.completedFiles = completed;
  j.failedFiles = failed;
  j.downloadedBytes = downloaded;
  // 有些文件一开始大小未知，下载后才知道；这里持续向上修正总量
  if (knownBytes > (j.totalBytes || 0)) j.totalBytes = knownBytes;
  if (!j.totalBytes) j.totalBytes = knownBytes;

  const first = active[0];
  j.currentFile = first ? first.rel : '';
  j.currentFileBytes = first ? first.bytes || 0 : 0;
  j.currentFileTotal = first ? first.size || 0 : 0;

  const totalFiles = j.totalFiles || j.files.length || 0;
  j.percentFiles =
    j.status === 'done' ? 100 : totalFiles > 0 ? Math.min(99.9, (completed / totalFiles) * 100) : 0;
  j.percentBytes =
    j.status === 'done'
      ? 100
      : j.totalBytes > 0
        ? Math.min(99.9, (downloaded / j.totalBytes) * 100)
        : j.percentFiles;
  j.percent = j.percentBytes;

  const sp = sampleSpeeds(downloaded, completed);
  j.speedBytes = sp.speedBytes;
  j.speedFiles = sp.speedFiles;
  j.speed = sp.speedBytes;

  const remainBytes = Math.max(0, (j.totalBytes || 0) - downloaded);
  j.etaBytes = j.speedBytes > 1024 && remainBytes > 0 ? Math.round(remainBytes / j.speedBytes) : null;
  const remainFiles = Math.max(0, totalFiles - completed);
  j.etaFiles = j.speedFiles > 0.02 && remainFiles > 0 ? Math.round(remainFiles / j.speedFiles) : null;
  j.etaSeconds = j.etaBytes;
}

function scheduleProgress(j) {
  if (progressTimer) return;
  progressTimer = setTimeout(() => {
    progressTimer = null;
    if (!j || j !== job) return;
    recompute(j);
    scheduleBroadcast(j);
    schedulePersist(j);
  }, 200);
}

/* ------------------------------------------------------------
 * 定时轮询：字节进度 / 卡死检测
 * ---------------------------------------------------------- */
function startTicker(j) {
  stopTicker();
  ticker = setInterval(() => {
    tickJob(j).catch(() => {});
  }, 500);
}

function stopTicker() {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

async function tickJob(j) {
  if (!j || j !== job || j.status !== 'running') {
    stopTicker();
    return;
  }

  if (j.mode === 'each') {
    for (const f of j.files) {
      if (f.status !== 'downloading' || !f.downloadId) continue;
      try {
        const items = await chrome.downloads.search({ id: f.downloadId });
        const it = items && items[0];
        if (!it) continue;
        if (it.bytesReceived > (f.bytes || 0)) f.bytes = it.bytesReceived;
        if (it.totalBytes > 0 && !f.size) f.size = it.totalBytes;
      } catch (e) {
        /* ignore */
      }
    }
  }

  if (j.mode === 'zip' && j.lastEventAt && now() - j.lastEventAt > ZIP_WATCHDOG_MS) {
    jobLog(j, 'error', 'ZIP 任务超过 3 分钟没有进度上报，WorkBuddy 页面可能已关闭；任务终止。');
    j.status = 'error';
    finalizeJob(j);
    return;
  }

  recompute(j);
  scheduleBroadcast(j);
  schedulePersist(j);
}

/* ------------------------------------------------------------
 * 单文件下载（chrome.downloads + 自定义 X-Access-Token 请求头）
 * ---------------------------------------------------------- */
function fileUrl(j, f) {
  return j.base + '/files?path=' + encodeURIComponent(f.path);
}

function rememberName(url, filename) {
  pendingNames.set(url, { filename, at: now() });
  if (pendingNames.size > 300) {
    const cutoff = now() - 300000;
    for (const [k, v] of pendingNames) if (!v || v.at < cutoff) pendingNames.delete(k);
  }
}

async function startChromeDownload(j, f, filename) {
  const url = fileUrl(j, f);
  rememberName(url, filename);
  try {
    return await chrome.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false,
      headers: [{ name: 'X-Access-Token', value: j.token }],
    });
  } catch (e) {
    pendingNames.delete(url);
    throw e;
  }
}

function waitForDownload(j, f, downloadId) {
  return new Promise((resolve) => {
    let settled = false;
    let lastBytes = -1;
    let lastChange = now();
    let lastDanger = '';
    let lastPaused = false;
    let searchErrors = 0;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      waiters.delete(downloadId);
      resolve(result);
    };

    const check = async () => {
      if (settled) return;
      let items;
      try {
        items = await chrome.downloads.search({ id: downloadId });
        searchErrors = 0;
      } catch (e) {
        searchErrors++;
        if (searchErrors >= 10) {
          finish({ state: 'interrupted', error: 'DOWNLOAD_SEARCH_FAILED', item: null });
        }
        return;
      }
      const it = items && items[0];
      if (!it) {
        finish({ state: 'interrupted', error: 'DOWNLOAD_NOT_FOUND', item: null });
        return;
      }
      if (it.danger && it.danger !== 'safe' && it.danger !== lastDanger) {
        lastDanger = it.danger;
        jobLog(j, 'warn', `Chrome 对 ${f.rel} 给出安全提示（${it.danger}），若下载停住请在下载栏选择「保留」。`);
      }
      if (it.bytesReceived !== lastBytes) {
        lastBytes = it.bytesReceived;
        lastChange = now();
      }
      f.bytes = Math.max(f.bytes || 0, it.bytesReceived || 0);
      if (it.totalBytes > 0 && !f.size) f.size = it.totalBytes;
      if (it.paused) {
        if (!lastPaused) {
          lastPaused = true;
          jobLog(j, 'warn', `下载已暂停：${f.rel}。请在 Chrome 下载栏点「继续」，或取消后重试。`);
        }
        lastChange = now();
        return;
      }
      if (lastPaused) {
        lastPaused = false;
        jobLog(j, 'info', `下载已恢复：${f.rel}`);
      }
      if (it.state === 'complete') {
        finish({ state: 'complete', item: it });
      } else if (it.state === 'interrupted') {
        finish({ state: 'interrupted', error: it.error || 'INTERRUPTED', item: it });
      } else if (now() - lastChange > STALL_MS) {
        try {
          await chrome.downloads.cancel(downloadId);
        } catch (e) {
          /* ignore */
        }
        finish({ state: 'interrupted', error: 'STALLED', item: it });
      }
    };

    const timer = setInterval(check, 1000);
    waiters.set(downloadId, { finish, file: f });
    check();
  });
}

function failFile(j, f, error) {
  f.status = 'failed';
  f.error = String(error || '下载失败');
  jobLog(j, 'error', `[${f.index + 1}/${j.totalFiles}] 失败 ${f.rel}：${f.error}`);
  recompute(j);
  scheduleBroadcast(j);
  schedulePersist(j);
}

async function refreshJobSession(j) {
  try {
    const resp = await withTimeout(
      chrome.tabs.sendMessage(j.tabId, {
        type: 'WBDA2_REFRESH_SESSION',
        taskId: j.taskId,
      }),
      10000,
      '刷新会话凭证'
    );
    if (resp && resp.ok && resp.base && resp.token) {
      j.base = String(resp.base).replace(/\/+$/, '');
      j.token = resp.token;
      jobLog(j, 'info', '会话凭证已刷新');
      return true;
    }
    jobLog(j, 'warn', '刷新会话凭证失败：' + ((resp && resp.error) || '未知错误'));
  } catch (e) {
    jobLog(j, 'warn', '刷新会话凭证失败：' + String((e && e.message) || e));
  }
  return false;
}

/**
 * Chrome 会按服务器返回的 Content-Type 强制改写扩展名（例如 .apkg → .zip）。
 * 正常情况下 DNR 规则已经中和了 MIME；若仍然被改写，这里用页面直存兜底重新保存。
 */
async function fixExtensionIfNeeded(j, f, item) {
  const intended = f.savedAs || filenameFor(j.dirName, f, !!f.usedFlat);
  const want = extOf(intended);
  const got = extOf(item && item.filename);
  if (!want || !got || want === got) return;

  if (!settings.fixFileExtension) {
    jobLog(j, 'warn', `Chrome 按 MIME 改写了扩展名：${basename(item.filename)}（应为 ${basename(intended)}）。`);
    return;
  }

  jobLog(
    j,
    'warn',
    `Chrome 按 MIME 改写了扩展名：${basename(item.filename)}（应为 ${basename(intended)}），正在用页面直存重新保存…`
  );

  const name = safeBaseName(intended);
  let resp = null;
  try {
    resp = await withTimeout(
      chrome.tabs.sendMessage(j.tabId, {
        type: 'WBDA2_SAVE_BLOB',
        base: j.base,
        token: j.token,
        path: f.path,
        filename: name,
      }),
      600000,
      '页面直存'
    );
  } catch (e) {
    resp = { ok: false, error: String((e && e.message) || e) };
  }

  if (!resp || !resp.ok) {
    jobLog(j, 'error', `页面直存失败，文件仍是 ${basename(item.filename)}：${(resp && resp.error) || '未知错误'}`);
    return;
  }

  f.extensionFixed = true;
  f.savedAsReal = resp.filename || name;
  jobLog(j, 'info', `已重新保存为 ${f.savedAsReal}（位于下载目录根目录）`);

  if (resp.url) await eraseByUrl(resp.url);

  if (item && item.id != null) {
    try {
      await chrome.downloads.removeFile(item.id);
      jobLog(j, 'info', `已删除扩展名错误的副本 ${basename(item.filename)}`);
    } catch (e) {
      jobLog(j, 'warn', `扩展名错误的副本未能自动删除：${basename(item.filename)}`);
    }
  }
}

async function downloadOne(j, f) {
  if (j.cancelRequested) return;

  f.status = 'downloading';
  f.bytes = 0;
  f.error = null;
  f.attempts = (f.attempts || 0) + 1;
  recompute(j);
  jobLog(
    j,
    'info',
    `[${f.index + 1}/${j.totalFiles}] 开始下载 ${f.rel}` +
      (Number.isFinite(f.size) ? ` (${fmtBytes(f.size)})` : '') +
      (f.attempts > 1 ? ` · 第 ${f.attempts} 次尝试` : '')
  );

  let filename = f.savedAs || filenameFor(j.dirName, f, false);
  let id;
  try {
    id = await startChromeDownload(j, f, filename);
    f.savedAs = filename;
  } catch (e) {
    const msg = String((e && e.message) || e);
    jobLog(j, 'warn', `[${f.index + 1}/${j.totalFiles}] 启动下载失败：${msg}`);
    if (!f.usedFlat && /filename|path|invalid|too long|FILE_/i.test(msg)) {
      f.usedFlat = true;
      filename = filenameFor(j.dirName, f, true);
      try {
        id = await startChromeDownload(j, f, filename);
        f.savedAs = filename;
      } catch (e2) {
        return failFile(j, f, String((e2 && e2.message) || e2));
      }
    } else {
      return failFile(j, f, msg);
    }
  }

  f.downloadId = id;
  recompute(j);
  scheduleBroadcast(j);
  schedulePersist(j, true);

  const res = await waitForDownload(j, f, id);
  f.downloadId = null;
  return handleDownloadResult(j, f, res);
}

async function handleDownloadResult(j, f, res) {
  f.downloadId = null;

  if (j.cancelRequested) {
    f.status = 'pending';
    f.bytes = 0;
    if (res && res.item && res.item.id != null) await eraseDownloadRecord(res.item.id);
    recompute(j);
    scheduleBroadcast(j);
    return;
  }

  if (res.state === 'complete') {
    const it = res.item || {};
    f.status = 'done';
    f.bytes = it.fileSize > 0 ? it.fileSize : it.bytesReceived || f.size || 0;
    if (it.fileSize > 0) f.size = it.fileSize;
    jobLog(j, 'info', `[${f.index + 1}/${j.totalFiles}] 完成 ${f.rel} (${fmtBytes(f.bytes)})`);

    try {
      await fixExtensionIfNeeded(j, f, it);
    } catch (e) {
      jobLog(j, 'warn', '扩展名校验失败：' + String((e && e.message) || e));
    }

    if (it.id != null) await eraseDownloadRecord(it.id);

    recompute(j);
    scheduleBroadcast(j);
    schedulePersist(j);
    return;
  }

  const err = res.error || 'INTERRUPTED';
  if (res.item && res.item.id != null) await eraseDownloadRecord(res.item.id);

  if (err === 'SERVER_UNAUTHORIZED') {
    if (j.tokenRefreshed && !f.authRetried) {
      f.authRetried = true;
      f.status = 'pending';
      f.bytes = 0;
      jobLog(j, 'info', `[${f.index + 1}/${j.totalFiles}] 使用刷新后的会话令牌重试 ${f.rel}`);
      return downloadOne(j, f);
    }
    if (!j.tokenRefreshed && !j.refreshFailed) {
      jobLog(j, 'warn', '服务器返回 401，可能是会话令牌过期，正在刷新后重试…');
      const ok = await refreshJobSession(j);
      if (ok) {
        j.tokenRefreshed = true;
        f.authRetried = true;
        f.status = 'pending';
        f.bytes = 0;
        return downloadOne(j, f);
      }
      j.refreshFailed = true;
    }
    return failFile(j, f, '认证失败（HTTP 401），请刷新 WorkBuddy 页面并确认登录态后重试');
  }

  if (!f.usedFlat && /FILE_NAME_TOO_LONG|FILE_ACCESS_DENIED|FILE_FAILED/.test(err)) {
    jobLog(j, 'warn', `[${f.index + 1}/${j.totalFiles}] 文件名/路径不可用（${err}），改用短路径重试`);
    f.usedFlat = true;
    f.savedAs = null;
    f.status = 'pending';
    f.bytes = 0;
    return downloadOne(j, f);
  }

  if (f.attempts <= MAX_RETRIES && /NETWORK_|SERVER_|CRASH|STALLED|DOWNLOAD_NOT_FOUND|DOWNLOAD_SEARCH_FAILED/.test(err)) {
    jobLog(j, 'warn', `[${f.index + 1}/${j.totalFiles}] 下载中断（${err}），准备重试…`);
    await sleep(800 * f.attempts);
    f.status = 'pending';
    f.bytes = 0;
    return downloadOne(j, f);
  }

  return failFile(j, f, err);
}

async function adoptDownload(j, f) {
  if (j.cancelRequested) return;
  if (!f.downloadId) {
    f.status = 'pending';
    f.bytes = 0;
    return downloadOne(j, f);
  }
  const res = await waitForDownload(j, f, f.downloadId);
  f.downloadId = null;
  return handleDownloadResult(j, f, res);
}

/* ------------------------------------------------------------
 * 逐个下载任务
 * ---------------------------------------------------------- */
async function runEachJob(j, resume) {
  if (runnerActive) return;
  runnerActive = true;
  job = j;
  if (j._finalized) {
    runnerActive = false;
    return;
  }
  if (resume && j.cancelRequested) {
    runnerActive = false;
    finalizeJob(j);
    return;
  }

  await ensureSettings();
  j.status = 'running';
  j.phase = 'downloading';
  j.cancelRequested = false;
  j._finalized = false;
  j.finishedAt = null;
  j.concurrency = settings.concurrency;
  j.totalBytes =
    j.totalBytes || j.files.reduce((s, f) => s + (Number.isFinite(f.size) ? f.size : 0), 0);
  samples = [];

  await ensureMimeRule();
  await setDownloadUiDisabled(true);

  const adopted = [];
  if (resume) {
    jobLog(j, 'warn', '检测到未完成的下载任务，正在恢复…');
    for (const f of j.files) {
      if (f.status !== 'downloading') continue;
      if (!f.downloadId) {
        f.status = 'pending';
        f.bytes = 0;
        continue;
      }
      try {
        const items = await chrome.downloads.search({ id: f.downloadId });
        const it = items && items[0];
        if (it && it.state === 'complete') {
          f.status = 'done';
          f.bytes = it.fileSize > 0 ? it.fileSize : it.bytesReceived || f.size || 0;
          if (it.fileSize > 0) f.size = it.fileSize;
          f.downloadId = null;
          await eraseDownloadRecord(it.id);
          jobLog(j, 'info', `[${f.index + 1}/${j.totalFiles}] 恢复时发现已完成 ${f.rel}`);
        } else if (it && it.state === 'in_progress') {
          adopted.push(f);
          if (it.paused) {
            jobLog(j, 'warn', `[${f.index + 1}/${j.totalFiles}] 下载处于暂停状态 ${f.rel}，正在尝试继续`);
            try {
              await chrome.downloads.resume(f.downloadId);
            } catch (e) {
              /* ignore */
            }
          }
          jobLog(
            j,
            'info',
            `[${f.index + 1}/${j.totalFiles}] 接管进行中的下载 ${f.rel}（已收 ${fmtBytes(it.bytesReceived || 0)}）`
          );
        } else {
          f.status = 'pending';
          f.bytes = 0;
          f.downloadId = null;
          jobLog(j, 'warn', `[${f.index + 1}/${j.totalFiles}] 下载已中断，重新排队 ${f.rel}`);
        }
      } catch (e) {
        f.status = 'pending';
        f.bytes = 0;
        f.downloadId = null;
      }
    }
  } else {
    jobLog(
      j,
      'info',
      `任务开始：${j.single ? '单文件下载' : '逐个下载'}，共 ${j.totalFiles} 个文件，总计 ${fmtBytes(j.totalBytes)}，并发 ${j.concurrency}`
    );
    jobLog(j, 'info', `输出目录：${j.dirName}`);
  }

  ensureAlarm();
  recompute(j);
  scheduleBroadcast(j);
  schedulePersist(j, true);
  startTicker(j);

  if (adopted.length > 0) {
    jobLog(j, 'info', `正在接管 ${adopted.length} 个进行中的下载…`);
    await Promise.all(
      adopted.map((f) =>
        adoptDownload(j, f).catch((e) => failFile(j, f, String((e && e.message) || e)))
      )
    );
    recompute(j);
    scheduleBroadcast(j);
    schedulePersist(j);
  }

  const queue = j.files.filter((f) => f.status === 'pending');
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(settings.concurrency, queue.length || 1));

  const workers = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(
      (async () => {
        while (!j.cancelRequested) {
          const f = queue[cursor++];
          if (!f) break;
          await downloadOne(j, f);
          if (j.cancelRequested) break;
          recompute(j);
          scheduleBroadcast(j);
          schedulePersist(j);
        }
      })()
    );
  }

  await Promise.all(workers);
  runnerActive = false;
  stopTicker();
  finalizeJob(j);
}

/* ------------------------------------------------------------
 * ZIP 任务（页面上下文执行，后台汇总进度）
 * ---------------------------------------------------------- */
async function startZipJob(j) {
  const payload = {
    id: j.id,
    taskId: j.taskId,
    taskName: j.taskName,
    base: j.base,
    token: j.token,
    dirName: j.dirName,
    totalBytes: j.totalBytes,
    files: j.files.map((f) => ({
      index: f.index,
      path: f.path,
      rel: f.rel,
      size: f.size,
    })),
  };

  jobLog(j, 'info', `任务开始：ZIP 打包，共 ${j.totalFiles} 个文件，总计 ${fmtBytes(j.totalBytes)}`);
  jobLog(j, 'info', `输出文件：${j.dirName}.zip`);
  ensureAlarm();
  startTicker(j);
  recompute(j);
  scheduleBroadcast(j);
  schedulePersist(j, true);

  await ensureMimeRule();
  await setDownloadUiDisabled(true);

  const resp = await withTimeout(
    chrome.tabs.sendMessage(j.tabId, { type: 'WBDA2_ZIP_JOB', job: payload }),
    10000,
    '页面接受 ZIP 任务'
  );
  if (!resp || !resp.ok) {
    throw new Error((resp && resp.error) || 'WorkBuddy 页面没有接受 ZIP 任务');
  }
  jobLog(j, 'info', 'ZIP 任务已交给页面执行，进度会实时上报…');
}

function handleZipEvent(msg) {
  if (!job || job._finalized || !msg || msg.jobId !== job.id || job.mode !== 'zip') return;
  const j = job;
  const ev = msg.event || {};
  j.lastEventAt = now();
  const f = Number.isInteger(ev.index) ? j.files.find((item) => item.index === ev.index) : null;

  switch (ev.type) {
    case 'file-start':
      if (f) {
        f.status = 'downloading';
        f.bytes = 0;
        f.error = null;
        f.attempts = (f.attempts || 0) + 1;
      }
      jobLog(
        j,
        'info',
        `[${f ? f.index + 1 : '?'}/${j.totalFiles}] 开始读取 ${ev.rel || (f && f.rel) || ''}` +
          (Number.isFinite(ev.size) ? ` (${fmtBytes(ev.size)})` : '')
      );
      break;
    case 'file-progress':
      if (f) {
        f.bytes = Math.max(f.bytes || 0, ev.bytes || 0);
        if (ev.total > 0) f.size = f.size || ev.total;
      }
      break;
    case 'file-done':
      if (f) {
        f.status = 'done';
        f.bytes = ev.bytes || f.size || 0;
        if (ev.size > 0) f.size = ev.size;
      }
      jobLog(j, 'info', `[${f ? f.index + 1 : '?'}/${j.totalFiles}] 读取完成 ${ev.rel || (f && f.rel) || ''}`);
      break;
    case 'file-failed':
      if (f) {
        f.status = 'failed';
        f.error = ev.error || '下载失败';
      }
      jobLog(
        j,
        'error',
        `[${f ? f.index + 1 : '?'}/${j.totalFiles}] 读取失败 ${ev.rel || (f && f.rel) || ''}：${ev.error || ''}`
      );
      break;
    case 'phase':
      j.phase = ev.phase || j.phase;
      if (ev.total) j.packingTotal = ev.total;
      if (ev.message) jobLog(j, 'info', ev.message);
      break;
    case 'zip-progress':
      j.phase = 'packing';
      j.packingDone = ev.done || 0;
      j.packingTotal = ev.total || j.totalFiles;
      if (ev.done === 1 || ev.done === j.packingTotal || ev.packing) {
        jobLog(j, 'info', `ZIP 打包进度 ${j.packingDone}/${j.packingTotal}`);
      }
      break;
    case 'log':
      jobLog(j, ev.level || 'info', ev.message || '');
      break;
    case 'done':
      finishZipJob(j, ev);
      return;
    case 'error':
      j.status = 'error';
      j.phase = 'error';
      jobLog(j, 'error', ev.error || 'ZIP 任务失败');
      finalizeJob(j);
      return;
    case 'cancelled':
      j.cancelRequested = true;
      finalizeJob(j);
      return;
    default:
      break;
  }

  recompute(j);
  scheduleBroadcast(j);
  schedulePersist(j);
}

function finishZipJob(j, ev) {
  if (j._finalized) return;
  j._finalized = true;
  stopTicker();

  const failed = Array.isArray(ev.failed) ? ev.failed : [];
  for (const x of failed) {
    const f = j.files.find((item) => item.rel === x.rel);
    if (f) {
      f.status = 'failed';
      f.error = x.error || '下载失败';
    }
  }
  recompute(j);

  j.finishedAt = now();
  j.speed = 0;
  j.speedBytes = 0;
  j.speedFiles = 0;
  j.etaSeconds = null;
  j.etaBytes = null;
  j.etaFiles = null;
  j.currentFile = '';
  j.downloadedBytes = j.totalBytes;
  j.percent = ev.ok ? 100 : j.percent;
  j.status = ev.ok ? 'done' : 'error';
  j.phase = ev.ok ? 'done' : 'error';
  j.result = {
    ok: !!ev.ok,
    status: j.status,
    filename: ev.filename || j.dirName + '.zip',
    count: ev.count || j.files.filter((f) => f.status === 'done').length,
    failed,
    totalSize: ev.totalSize || 0,
    durationMs: j.finishedAt - j.startedAt,
  };

  if (ev.ok) {
    jobLog(
      j,
      'info',
      `ZIP 已生成：${j.result.filename}（${j.result.count} 个文件，${fmtBytes(j.result.totalSize)}）`
    );
    if (failed.length > 0) {
      jobLog(j, 'warn', `ZIP 中有 ${failed.length} 个文件读取失败，已跳过：` + failed.map((x) => x.rel).join('、'));
    }
  } else {
    jobLog(j, 'error', `ZIP 任务失败：${ev.error || '未知错误'}`);
  }

  // ZIP 是通过页面 <a download> 保存的，这里把它产生的下载记录也清掉
  if (ev.url) eraseByUrl(ev.url);

  schedulePersist(j, true);
  scheduleBroadcast(j);
  clearAlarm();
  setDownloadUiDisabled(false);
}

/* ------------------------------------------------------------
 * 任务收尾
 * ---------------------------------------------------------- */
function finalizeJob(j) {
  if (!j || j._finalized) return;
  j._finalized = true;
  stopTicker();

  recompute(j);
  j.finishedAt = now();
  j.speed = 0;
  j.speedBytes = 0;
  j.speedFiles = 0;
  j.etaSeconds = null;
  j.etaBytes = null;
  j.etaFiles = null;
  j.currentFile = '';

  const done = j.files.filter((f) => f.status === 'done');
  const failed = j.files.filter((f) => f.status === 'failed');
  const pending = j.files.filter((f) => f.status === 'pending' || f.status === 'downloading');

  if (j.cancelRequested) {
    j.status = 'cancelled';
    j.phase = 'cancelled';
    jobLog(j, 'warn', `任务已取消：成功 ${done.length}，失败 ${failed.length}，未完成 ${pending.length}`);
  } else if (done.length === 0) {
    j.status = 'error';
    j.phase = 'error';
    jobLog(j, 'error', `任务失败：所有 ${j.totalFiles} 个文件都未能下载`);
  } else {
    j.status = 'done';
    j.phase = 'done';
    jobLog(
      j,
      'info',
      `任务完成：成功 ${done.length}/${j.totalFiles}，失败 ${failed.length}，用时 ${fmtDuration(
        j.finishedAt - j.startedAt
      )}`
    );
  }

  j.percent = j.status === 'done' ? 100 : j.percent;
  j.percentBytes = j.status === 'done' ? 100 : j.percentBytes;
  j.percentFiles = j.status === 'done' ? 100 : j.percentFiles;
  j.result = {
    ok: j.status === 'done',
    status: j.status,
    filename: j.dirName,
    count: done.length,
    failed: failed.map((f) => ({ rel: f.rel, error: f.error || '下载失败' })),
    cancelled: pending.length,
    durationMs: j.finishedAt - j.startedAt,
  };

  schedulePersist(j, true);
  scheduleBroadcast(j);
  clearAlarm();
  setDownloadUiDisabled(false);
}

/* ------------------------------------------------------------
 * 任务启动 / 取消 / 清理
 * ---------------------------------------------------------- */
function normalizeFiles(list) {
  return list
    .filter((f) => f && f.path && (f.rel || f.name))
    .map((f, i) => ({
      index: i,
      path: String(f.path || ''),
      rel: String(f.rel || f.name || '').replace(/^\/+/, ''),
      name: f.name || '',
      size: f.size == null || f.size === '' || !Number.isFinite(Number(f.size)) ? null : Number(f.size),
      mimeType: f.mimeType || '',
      status: 'pending',
      bytes: 0,
      error: null,
      downloadId: null,
      savedAs: null,
      attempts: 0,
      usedFlat: false,
      authRetried: false,
    }))
    .filter((f) => f.path && f.rel)
    .map((f, i) => Object.assign(f, { index: i }));
}

async function startJob(payload) {
  if (!payload || !Array.isArray(payload.files) || payload.files.length === 0) {
    return { ok: false, error: '产物清单为空，请刷新后重试。' };
  }
  if (!payload.base || !payload.token || !payload.tabId) {
    return { ok: false, error: '缺少 WorkBuddy 会话凭证，请关闭弹窗后重新打开并刷新。' };
  }
  if (job && job.status === 'running') {
    return { ok: false, error: '已有下载任务正在运行，请等待完成或先取消。' };
  }

  await ensureSettings();

  const files = normalizeFiles(payload.files);
  if (files.length === 0) {
    return { ok: false, error: '产物路径无效。' };
  }

  const single = !!payload.single;
  const dirName = single
    ? buildSingleDirName(payload.taskName)
    : buildDirName(payload.taskName, payload.taskId);

  job = {
    id: 'wbda-' + now() + '-' + Math.random().toString(36).slice(2, 8),
    mode: payload.mode === 'zip' ? 'zip' : 'each',
    single,
    taskId: String(payload.taskId || ''),
    taskName: String(payload.taskName || ''),
    base: String(payload.base).replace(/\/+$/, ''),
    token: String(payload.token),
    tabId: payload.tabId,
    dirName,
    concurrency: settings.concurrency,
    status: 'running',
    phase: 'starting',
    startedAt: now(),
    finishedAt: null,
    totalFiles: files.length,
    completedFiles: 0,
    failedFiles: 0,
    totalBytes: files.reduce((s, f) => s + (f.size || 0), 0),
    downloadedBytes: 0,
    percent: 0,
    percentBytes: 0,
    percentFiles: 0,
    speed: 0,
    speedBytes: 0,
    speedFiles: 0,
    etaSeconds: null,
    etaBytes: null,
    etaFiles: null,
    currentFile: '',
    currentFileBytes: 0,
    currentFileTotal: 0,
    packingDone: 0,
    packingTotal: 0,
    files,
    logs: [],
    result: null,
    cancelRequested: false,
    tokenRefreshed: false,
    refreshFailed: false,
    lastEventAt: now(),
    _finalized: false,
  };

  jobLog(
    job,
    'info',
    `任务已创建：${job.mode === 'zip' ? 'ZIP 打包' : single ? '单文件下载' : '逐个下载'} · ${files.length} 个文件`
  );
  schedulePersist(job, true);
  scheduleBroadcast(job);

  if (job.mode === 'each') {
    runEachJob(job, false).catch((e) => {
      jobLog(job, 'error', '任务异常：' + String((e && e.message) || e));
      job.status = 'error';
      finalizeJob(job);
    });
  } else {
    startZipJob(job).catch((e) => {
      jobLog(job, 'error', 'ZIP 任务启动失败：' + String((e && e.message) || e));
      job.status = 'error';
      finalizeJob(job);
    });
  }

  return { ok: true, job: publicJob(job) };
}

async function cancelJob() {
  if (!job || job.status !== 'running') {
    return { ok: false, error: '当前没有正在运行的任务。' };
  }
  const j = job;
  j.cancelRequested = true;
  jobLog(j, 'warn', '收到取消请求，正在停止…');
  schedulePersist(j, true);
  scheduleBroadcast(j);

  if (j.mode === 'each') {
    const canceledIds = [];
    for (const f of j.files) {
      if (f.status === 'downloading' && f.downloadId) {
        canceledIds.push(f.downloadId);
        try {
          await chrome.downloads.cancel(f.downloadId);
        } catch (e) {
          /* ignore */
        }
      }
    }
    // 取消是异步生效的，稍后再抹掉下载记录
    if (canceledIds.length) {
      setTimeout(() => {
        canceledIds.forEach((id) => eraseDownloadRecord(id));
      }, 2000);
    }
  } else {
    try {
      await withTimeout(
        chrome.tabs.sendMessage(j.tabId, { type: 'WBDA2_ZIP_CANCEL', jobId: j.id }),
        3000,
        '取消 ZIP 任务'
      );
    } catch (e) {
      /* ignore */
    }
  }

  setTimeout(() => {
    if (job === j && j.status === 'running' && !runnerActive) finalizeJob(j);
  }, 1500);
  return { ok: true };
}

async function clearJob() {
  if (job && job.status === 'running') {
    return { ok: false, error: '任务正在运行，无法清除记录。' };
  }
  job = null;
  try {
    await chrome.storage.session.remove(JOB_KEY);
  } catch (e) {
    /* ignore */
  }
  return { ok: true };
}

/* ------------------------------------------------------------
 * 保活 / 启动恢复
 * ---------------------------------------------------------- */
function ensureAlarm() {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  } catch (e) {
    /* ignore */
  }
}

function clearAlarm() {
  try {
    chrome.alarms.clear(KEEPALIVE_ALARM);
  } catch (e) {
    /* ignore */
  }
}

async function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      await ensureSettings();
      await resetDownloadUi();

      const stored = await chrome.storage.session.get(JOB_KEY);
      const j = stored && stored[JOB_KEY];
      if (!j) return;
      job = j;
      if (j.status === 'running') {
        jobLog(j, 'warn', '后台服务重新启动，检测到未完成任务');
        if (j.mode === 'each') {
          runEachJob(j, true).catch((e) => {
            jobLog(j, 'error', '恢复任务失败：' + String((e && e.message) || e));
            j.status = 'error';
            finalizeJob(j);
          });
        } else {
          j.lastEventAt = now();
          ensureAlarm();
          startTicker(j);
          scheduleBroadcast(j);
        }
      } else {
        scheduleBroadcast(j);
      }
    } catch (e) {
      console.warn('[WBDA] init failed:', e);
    }
  })();
  return initPromise;
}

/* ------------------------------------------------------------
 * Chrome 事件
 * ---------------------------------------------------------- */
if (chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    try {
      const key = item && (item.url || item.finalUrl);
      const rec = key ? pendingNames.get(key) : null;
      const ours = !item || !item.byExtensionId || item.byExtensionId === chrome.runtime.id;
      if (rec && ours) {
        pendingNames.delete(key);
        suggest({ filename: rec.filename, conflictAction: 'uniquify' });
        return;
      }
    } catch (e) {
      /* ignore */
    }
    try {
      suggest();
    } catch (e) {
      /* ignore */
    }
  });
}

chrome.downloads.onChanged.addListener((delta) => {
  const w = waiters.get(delta.id);
  if (!w) return;
  if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
    chrome.downloads
      .search({ id: delta.id })
      .then((items) => {
        const it = items && items[0];
        if (!it) {
          w.finish({ state: 'interrupted', error: 'DOWNLOAD_NOT_FOUND', item: null });
          return;
        }
        if (it.state === 'complete') w.finish({ state: 'complete', item: it });
        else w.finish({ state: 'interrupted', error: it.error || 'INTERRUPTED', item: it });
      })
      .catch(() => {});
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (!job || job.status !== 'running' || job._finalized) {
    clearAlarm();
    return;
  }
  if (job.mode === 'each' && !runnerActive) {
    jobLog(job, 'warn', '后台保活检查：恢复未完成的下载任务');
    runEachJob(job, true).catch((e) => {
      jobLog(job, 'error', '保活恢复失败：' + String((e && e.message) || e));
      job.status = 'error';
      finalizeJob(job);
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (job && job.status === 'running' && job.mode === 'zip' && job.tabId === tabId) {
    jobLog(job, 'error', 'WorkBuddy 页面已关闭，ZIP 任务终止。');
    job.status = 'error';
    finalizeJob(job);
  }
});

chrome.runtime.onStartup.addListener(() => init());
chrome.runtime.onInstalled.addListener(() => init());

try {
  chrome.runtime.onSuspend.addListener(() => {
    try {
      chrome.downloads.setUiOptions({ enabled: true });
    } catch (e) {
      /* ignore */
    }
  });
} catch (e) {
  /* ignore */
}

init();

/* ------------------------------------------------------------
 * 消息接口
 * ---------------------------------------------------------- */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'WBDA2_START_JOB') {
    startJob(msg.payload)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === 'WBDA2_DOWNLOAD_ONE') {
    const p = msg.payload || {};
    startJob({
      mode: 'each',
      single: true,
      tabId: p.tabId,
      taskId: p.taskId,
      taskName: p.taskName,
      base: p.base,
      token: p.token,
      files: p.file ? [p.file] : [],
    })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === 'WBDA2_CANCEL_JOB') {
    cancelJob()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === 'WBDA2_GET_JOB') {
    sendResponse({ ok: true, job: publicJob(job) });
    return false;
  }

  if (msg.type === 'WBDA2_CLEAR_JOB') {
    clearJob()
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === 'WBDA2_JOB_EVENT') {
    try {
      handleZipEvent(msg);
    } catch (e) {
      console.warn('[WBDA] ZIP event failed:', e);
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
