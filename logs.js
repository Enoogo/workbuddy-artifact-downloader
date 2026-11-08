/* ============================================================
 * WorkBuddy 产物下载器 — 独立日志窗口 (logs.js) v2.1
 * 读取 chrome.storage.session 中持久化的任务，实时展示日志与进度。
 * 进度 / 速度 / 剩余时间口径跟随设置页。
 * ============================================================ */

const JOB_KEY = 'wbda.job.v2';
const $ = (id) => document.getElementById(id);

let job = null;
let settings = WBDA.normalize(null);

function humanBytes(n) {
  return WBDA.fmtBytes(n);
}

function humanDuration(ms) {
  return WBDA.fmtDuration(ms);
}

function logTime(t) {
  const d = new Date(t);
  return (
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0') +
    ':' +
    String(d.getSeconds()).padStart(2, '0')
  );
}

function filteredLogs() {
  if (!job || !Array.isArray(job.logs)) return [];
  const filter = $('filter').value;
  return job.logs.filter((l) => filter === 'all' || l.level === filter);
}

function renderSummary() {
  const el = $('summary');
  if (!job) {
    el.hidden = true;
    $('subtitle').textContent = '当前没有任务记录。';
    return;
  }

  el.hidden = false;
  const mode = job.mode === 'zip' ? 'ZIP 打包' : job.single ? '单文件下载' : '逐个下载';
  const statusMap = {
    running: '运行中',
    done: '已完成',
    error: '失败',
    cancelled: '已取消',
  };
  const status = statusMap[job.status] || job.status || '—';
  const percent =
    job.status === 'done'
      ? 100
      : WBDA.percentValue(settings.progressMetric, job.percentBytes, job.percentFiles);
  const lines = [];

  lines.push(
    '<div class="summary-title">' +
      escapeHtml(job.taskName || '任务 ' + job.taskId) +
      ' · ' +
      mode +
      '</div>'
  );
  lines.push(
    '<div class="summary-meta">任务 ID：' +
      escapeHtml(job.id || '') +
      ' · 状态：' +
      escapeHtml(status) +
      ' · 开始：' +
      escapeHtml(new Date(job.startedAt || Date.now()).toLocaleString()) +
      (job.finishedAt ? ' · 结束：' + escapeHtml(new Date(job.finishedAt).toLocaleString()) : '') +
      '</div>'
  );
  lines.push(
    '<div class="summary-progress ' +
      (job.status === 'done' ? 'ok' : job.status === 'error' ? 'err' : '') +
      '">已完成 ' +
      (job.completedFiles || 0) +
      '/' +
      (job.totalFiles || 0) +
      ' 个文件 · ' +
      humanBytes(job.downloadedBytes || 0) +
      (job.totalBytes ? ' / ' + humanBytes(job.totalBytes) : '') +
      ' · ' +
      percent +
      '%' +
      (job.failedFiles ? ' · 失败 ' + job.failedFiles : '') +
      (job.status === 'running'
        ? ' · ' + WBDA.speedText(settings.speedMetric, job.speedBytes, job.speedFiles)
        : '') +
      (job.finishedAt ? ' · 用时 ' + humanDuration(job.finishedAt - job.startedAt) : '') +
      '</div>'
  );
  if (job.result && job.result.failed && job.result.failed.length) {
    lines.push(
      '<div class="summary-meta">失败文件：' +
        job.result.failed
          .slice(0, 10)
          .map((x) => escapeHtml(x.rel))
          .join('、') +
        (job.result.failed.length > 10 ? ' 等 ' + job.result.failed.length + ' 个' : '') +
        '</div>'
    );
  }
  el.innerHTML = lines.join('');
}

function renderLogs(forceScroll) {
  const el = $('log-list');
  const logs = filteredLogs();
  if (logs.length === 0) {
    el.innerHTML = '<div class="log-empty">暂无日志</div>';
    return;
  }

  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  const frag = document.createDocumentFragment();
  for (const l of logs.slice(-1500)) {
    const line = document.createElement('div');
    line.className = 'log-line';

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = '[' + logTime(l.t) + ']';

    const level = document.createElement('span');
    level.className = 'log-level level-' + (l.level || 'info');
    level.textContent = (l.level || 'info').toUpperCase();

    const msg = document.createElement('span');
    msg.className = 'log-msg';
    msg.textContent = l.msg || '';

    line.append(time, level, msg);
    frag.appendChild(line);
  }
  el.replaceChildren(frag);
  if (forceScroll || nearBottom) el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

async function load() {
  try {
    const stored = await chrome.storage.session.get(JOB_KEY);
    job = (stored && stored[JOB_KEY]) || null;
  } catch (e) {
    job = null;
  }
  renderSummary();
  renderLogs(false);
  $('subtitle').textContent = job
    ? '日志会随任务实时更新；最多保留 1000 条。'
    : '当前没有任务记录。先在 WorkBuddy 页面打开扩展并开始下载。';
}

async function copyLogs() {
  const text = filteredLogs()
    .map((l) => '[' + logTime(l.t) + '] [' + (l.level || 'info') + '] ' + (l.msg || ''))
    .join('\n');
  if (!text) {
    $('subtitle').textContent = '暂无日志可复制。';
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    $('subtitle').textContent = '已复制 ' + filteredLogs().length + ' 条日志到剪贴板。';
  } catch (e) {
    $('subtitle').textContent = '复制失败：' + String((e && e.message) || e);
  }
}

$('copy').addEventListener('click', copyLogs);
$('refresh').addEventListener('click', load);
$('filter').addEventListener('change', () => renderLogs(true));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes[JOB_KEY]) return;
  job = changes[JOB_KEY].newValue || null;
  renderSummary();
  renderLogs(false);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'WBDA2_JOB_UPDATE' && msg.job) {
    job = msg.job;
    renderSummary();
    renderLogs(false);
  }
});

WBDA.onChange((s) => {
  settings = s;
  renderSummary();
});

setInterval(() => {
  if (job && job.status === 'running') load();
}, 1500);

(async () => {
  settings = await WBDA.load();
  await load();
})();
