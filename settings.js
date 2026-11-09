/* ============================================================
 * WorkBuddy 产物下载器 — 共享设置与格式化 (settings.js) v2.2
 *
 * 被 background（importScripts）、popup、options、logs 共同使用。
 * 设置存在 chrome.storage.local，改动后所有页面实时生效。
 * ============================================================ */
(() => {
  const KEY = 'wbda.settings.v1';
  const METRICS = ['bytes', 'files'];

  const DEFAULTS = Object.freeze({
    concurrency: 3, // 同时下载的文件数
    logDefaultOpen: true, // 日志面板默认展开
    progressMetric: 'bytes', // 进度条 / 百分比口径：bytes | files
    speedMetric: 'bytes', // 速度单位：bytes | files
    etaMetric: 'bytes', // 剩余时间估算口径：bytes | files
    hideDownloadUi: true, // 隐藏下载气泡与下载动画
    clearDownloadHistory: true, // 下载完成后清除本扩展产生的下载记录
    fixFileExtension: true, // 其他类型被 Chrome 按 MIME 改写时自动用 Blob 中继修正
  });

  function clampConcurrency(v) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return DEFAULTS.concurrency;
    return Math.max(1, Math.min(64, n));
  }

  function pickMetric(v, fallback) {
    return METRICS.indexOf(v) >= 0 ? v : fallback;
  }

  function normalize(raw) {
    const s = Object.assign({}, DEFAULTS, raw && typeof raw === 'object' ? raw : {});
    return {
      concurrency: clampConcurrency(s.concurrency),
      logDefaultOpen: s.logDefaultOpen !== false,
      progressMetric: pickMetric(s.progressMetric, DEFAULTS.progressMetric),
      speedMetric: pickMetric(s.speedMetric, DEFAULTS.speedMetric),
      etaMetric: pickMetric(s.etaMetric, DEFAULTS.etaMetric),
      hideDownloadUi: s.hideDownloadUi !== false,
      clearDownloadHistory: s.clearDownloadHistory !== false,
      fixFileExtension: s.fixFileExtension !== false,
    };
  }

  async function load() {
    try {
      const r = await chrome.storage.local.get(KEY);
      return normalize(r && r[KEY]);
    } catch (e) {
      return normalize(null);
    }
  }

  async function save(patch) {
    const cur = await load();
    const next = normalize(Object.assign({}, cur, patch));
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  }

  function onChange(cb) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[KEY]) return;
        cb(normalize(changes[KEY].newValue));
      });
    } catch (e) {
      /* ignore */
    }
  }

  /* ---------------- 格式化 ---------------- */
  const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

  function fmtBytes(n) {
    if (n == null || !Number.isFinite(n) || n < 0) return '—';
    if (n === 0) return '0 B';
    let v = n;
    let i = 0;
    while (v >= 1024 && i < BYTE_UNITS.length - 1) {
      v /= 1024;
      i++;
    }
    const digits = i === 0 ? 0 : v >= 100 ? 0 : v >= 10 ? 1 : 2;
    return v.toFixed(digits) + ' ' + BYTE_UNITS[i];
  }

  function fmtBytesSpeed(n) {
    if (!Number.isFinite(n) || n <= 0) return '—';
    return fmtBytes(n) + '/s';
  }

  function fmtFileSpeed(n) {
    if (!Number.isFinite(n) || n <= 0) return '—';
    const v = n >= 10 ? n.toFixed(1) : n.toFixed(2);
    return v + ' 个/s';
  }

  function fmtDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return h + 'h' + m + 'm';
    if (m > 0) return m + 'm' + s + 's';
    return s + 's';
  }

  function fmtEta(sec) {
    if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
    if (sec < 60) return Math.max(1, Math.round(sec)) + 's';
    if (sec < 3600) {
      const m = Math.floor(sec / 60);
      const s = Math.round(sec % 60);
      return m + 'm' + String(s).padStart(2, '0') + 's';
    }
    return fmtDuration(sec * 1000);
  }

  /** 按设置取速度文案 */
  function speedText(metric, speedBytes, speedFiles) {
    return metric === 'files' ? fmtFileSpeed(speedFiles) : fmtBytesSpeed(speedBytes);
  }

  /** 按设置取剩余时间文案 */
  function etaText(metric, etaBytes, etaFiles) {
    return fmtEta(metric === 'files' ? etaFiles : etaBytes);
  }

  /** 按设置取进度百分比（0-100） */
  function percentValue(metric, percentBytes, percentFiles) {
    const v = metric === 'files' ? percentFiles : percentBytes;
    return Math.max(0, Math.min(100, Math.floor(Number(v) || 0)));
  }

  globalThis.WBDA = {
    KEY,
    METRICS,
    DEFAULTS,
    normalize,
    load,
    save,
    onChange,
    clampConcurrency,
    fmtBytes,
    fmtBytesSpeed,
    fmtFileSpeed,
    fmtDuration,
    fmtEta,
    speedText,
    etaText,
    percentValue,
  };
})();
