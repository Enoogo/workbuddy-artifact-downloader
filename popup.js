/* ============================================================
 * WorkBuddy 产物下载器 — 弹窗逻辑 (popup.js) v2.1
 *
 * v2.1：
 *   - 文件列表带勾选框（默认全选），只下载勾选的文件；
 *   - 双击文件行单独下载该文件；
 *   - 活跃下载显示全部并发文件；
 *   - 进度 / 速度 / 剩余时间按设置切换「文件体积」或「文件个数」口径；
 *   - 日志默认展开状态可在设置里调整；
 *   - 一键打开设置页。
 * ============================================================ */

const $ = (id) => document.getElementById(id);

let payload = null;
let currentJob = null;
let settings = WBDA.normalize(null);
let logOpen = false;
let logRenderTimer = null;
let lastRunning = null;
const selected = new Set();
const liByRel = new Map();

const SOURCE_LABEL = {
  react: '底层数据直读',
  'react-activated': '底层数据 + 自动展开产物面板',
  dom: '页面 DOM',
  'dom-activated': '已自动展开产物面板',
  workspace: '工作区文件（兜底，可能含非产物）',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function truncate(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, Math.max(0, n - 1)) + '…' : t;
}

const humanBytes = (n) => WBDA.fmtBytes(n);
const humanDuration = (ms) => WBDA.fmtDuration(ms);
const humanEta = (sec) => WBDA.fmtEta(sec);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function setStatus(text, isError) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', !!isError);
  el.hidden = false;
}

function hideStatus() {
  $('status').hidden = true;
}

function showResult(html, cls) {
  const el = $('result');
  el.innerHTML = html;
  el.className = 'result ' + cls;
  el.hidden = false;
}

function hideResult() {
  $('result').hidden = true;
}

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp);
        }
      });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

async function pingContent(tabId) {
  return await Promise.race([
    chrome.tabs.sendMessage(tabId, { type: 'WBDA2_PING3' }).catch(() => null),
    sleep(800).then(() => null),
  ]);
}

async function ensureContentScript(tabId) {
  for (let i = 0; i < 3; i++) {
    const r = await pingContent(tabId);
    if (r && r.ok && r.version >= 3) return;
    await sleep(100);
  }

  await chrome.scripting.executeScript({ target: { tabId }, files: ['zip.js', 'content.js'] });

  for (let i = 0; i < 10; i++) {
    await sleep(120);
    const r = await pingContent(tabId);
    if (r && r.ok && r.version >= 3) return;
  }
  throw new Error(
    '页面里运行的还是旧版内容脚本。请按 Ctrl+R 刷新 WorkBuddy 页面，然后再打开下载器。'
  );
}

/* ------------------------------------------------------------
 * 扫描与清单渲染
 * ---------------------------------------------------------- */
async function scan() {
  if (!currentJob || currentJob.status !== 'running') hideResult();
  $('summary').hidden = true;
  $('file-area').hidden = true;
  $('actions').hidden = true;
  setStatus('正在扫描产物…');

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (e) {
    setStatus('无法获取当前标签页：' + String(e), true);
    return;
  }

  if (!tab || !tab.url || !/^https:\/\/www\.workbuddy\.cn\//.test(tab.url)) {
    setStatus(
      '请先在当前标签页打开 WorkBuddy 对话（https://www.workbuddy.cn/app/conversation/…）',
      true
    );
    return;
  }

  try {
    await ensureContentScript(tab.id);
  } catch (e) {
    setStatus(String((e && e.message) || e), true);
    return;
  }

  let resp;
  try {
    resp = await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type: 'WBDA2_LIST' }),
      sleep(15000).then(() => ({ ok: false, error: '扫描超时（15 秒），请刷新 WorkBuddy 页面后重试。' })),
    ]);
  } catch (e) {
    setStatus('与页面通信失败：' + String(e) + '\n请刷新 WorkBuddy 页面后重试。', true);
    return;
  }

  if (!resp || !resp.ok) {
    setStatus((resp && resp.error) || '扫描失败，请重试。', true);
    return;
  }

  payload = resp;
  payload._tabId = tab.id;

  // 每次扫描后默认全选
  selected.clear();
  for (const f of payload.files || []) selected.add(f.rel);

  renderSummary();
  renderFileList(payload.files);
  updateSelectionUi();
  updateModeHint();

  if (currentJob) {
    renderJob(currentJob, currentJob.taskId === payload.taskId);
  } else {
    updateButtons();
  }
}

function renderSummary() {
  if (!payload) return;
  const files = payload.files || [];
  $('task-name').textContent = payload.taskName || '任务 ' + payload.taskId;

  const source = SOURCE_LABEL[payload.source] || payload.source;
  let countText = files.length + ' 个文件（' + source + '）';
  if (payload.expected != null && payload.expected !== files.length) {
    countText += '，页面显示 ' + payload.expected + ' 个，可点「刷新」重试';
  }
  if (payload.scanMs != null) countText += ' · 扫描 ' + payload.scanMs + 'ms';
  $('file-count').textContent = countText;

  const known = files.filter((f) => f.size != null);
  const total = known.reduce((s, f) => s + f.size, 0);
  if (known.length === files.length) {
    $('total-size').textContent = '共 ' + humanBytes(payload.totalSize || total);
  } else {
    $('total-size').textContent =
      '已知 ' + humanBytes(total) + '，' + (files.length - known.length) + ' 个大小未知';
  }

  $('summary').hidden = false;
  hideStatus();
}

function statusText(f, mode) {
  if (!f) return '—';
  if (f.status === 'done') return '✓';
  if (f.status === 'failed') return '失败';
  if (f.status === 'downloading') {
    if (mode === 'zip') return f.size ? Math.min(100, Math.floor(((f.bytes || 0) / f.size) * 100)) + '%' : '读取中';
    if (f.size) return Math.min(100, Math.floor(((f.bytes || 0) / f.size) * 100)) + '%';
    return '下载中';
  }
  if (f.status === 'pending') return '—';
  return f.status || '—';
}

function renderFileList(files) {
  const ul = $('file-list');
  const frag = document.createDocumentFragment();
  const running = !!(currentJob && currentJob.status === 'running');

  (files || []).forEach((f, i) => {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.dataset.rel = f.rel || '';
    li.dataset.index = String(f.index == null ? i : f.index);
    li.title = '双击单独下载此文件';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'file-check';
    cb.dataset.rel = f.rel || '';
    cb.checked = selected.has(f.rel);
    cb.disabled = running;
    cb.title = '勾选后才会被下载';

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = f.rel || f.name || '';
    name.title = f.rel || f.name || '';

    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = humanBytes(f.size);

    const st = document.createElement('span');
    st.className = 'file-status';
    st.textContent = statusText(f, currentJob && currentJob.mode);

    li.append(cb, name, size, st);
    frag.appendChild(li);
    liByRel.set(li.dataset.rel, li);
  });
  ul.replaceChildren(frag);
  $('file-area').hidden = !files || files.length === 0;
}

function updateFileStatuses(jobFiles) {
  if (!jobFiles || jobFiles.length === 0) return;
  for (const f of jobFiles) {
    const li = liByRel.get(f.rel);
    if (!li) continue;
    li.className = 'file-item status-' + f.status;
    const el = li.querySelector('.file-status');
    if (el) {
      el.textContent = statusText(f, currentJob && currentJob.mode);
      el.title = f.error || '';
    }
  }
}

function updateModeHint() {
  if (!payload) return;
  const total = payload.totalSize || 0;
  let hint = '逐个下载会保留真实子目录，支持任意大小文件；ZIP 会打包成一个压缩包。';
  if (total > 200 * 1024 * 1024) {
    hint =
      '共 ' +
      humanBytes(total) +
      '，文件较大/较多：建议使用「逐个下载」；ZIP 需要把所有文件读入内存，耗时更长。';
  }
  if (payload.unknownSize) {
    hint += ' 其中 ' + payload.unknownSize + ' 个文件大小未知。';
  }
  hint += ' 下载并发数与单位显示可在「设置」里调整。';
  hint += ' 若每个文件都弹「另存为」，请在 chrome://settings/downloads 关闭「下载前询问每个文件的保存位置」。';
  $('mode-hint').textContent = hint;
}

/* ------------------------------------------------------------
 * 勾选
 * ---------------------------------------------------------- */
function totalFileCount() {
  if (payload) return (payload.files || []).length;
  return $('file-list').children.length;
}

function updateSelectionUi() {
  const total = totalFileCount();
  const n = selected.size;
  $('selected-count').textContent = '已选 ' + n + ' / ' + total;

  const all = $('check-all');
  all.checked = total > 0 && n === total;
  all.indeterminate = n > 0 && n < total;

  const running = !!(currentJob && currentJob.status === 'running');
  all.disabled = total === 0 || running;

  for (const [rel, li] of liByRel) {
    const cb = li.querySelector('input.file-check');
    if (!cb) continue;
    cb.checked = selected.has(rel);
    cb.disabled = running;
  }

  updateButtons();
}

function syncRunningState() {
  const running = !!(currentJob && currentJob.status === 'running');
  if (running === lastRunning) return false;
  lastRunning = running;
  updateSelectionUi();
  return true;
}

function setRelSelected(rel, on) {
  if (!rel) return;
  if (on) selected.add(rel);
  else selected.delete(rel);
  updateSelectionUi();
}

function setAllSelected(on) {
  selected.clear();
  const files = payload ? payload.files || [] : [];
  if (on) for (const f of files) selected.add(f.rel);
  updateSelectionUi();
}

/* ------------------------------------------------------------
 * 任务渲染
 * ---------------------------------------------------------- */
function phaseLabel(job) {
  const map = {
    starting: '准备中',
    downloading: job.mode === 'zip' ? '读取文件' : '下载中',
    packing: '打包 ZIP',
    saving: '保存 ZIP',
    done: '已完成',
    cancelled: '已取消',
    error: '失败',
  };
  return map[job.phase] || map[job.status] || job.status || '—';
}

function progressPercent(job) {
  if (job.status === 'done') return 100;
  return WBDA.percentValue(settings.progressMetric, job.percentBytes, job.percentFiles);
}

function speedLabel(job) {
  return WBDA.speedText(settings.speedMetric, job.speedBytes, job.speedFiles);
}

function etaLabel(job) {
  return WBDA.etaText(settings.etaMetric, job.etaBytes, job.etaFiles);
}

function jobMainText(job) {
  if (job.phase === 'packing') {
    return '打包 ' + (job.packingDone || 0) + '/' + (job.packingTotal || job.totalFiles || 0) + ' 个文件';
  }
  const failed = job.failedFiles ? ' · 失败 ' + job.failedFiles : '';
  if (settings.progressMetric === 'files') {
    const total = job.totalFiles || 0;
    const done = job.completedFiles || 0;
    return '已完成 ' + done + '/' + total + ' · ' + progressPercent(job) + '% · 剩余 ' + Math.max(0, total - done) + ' 个' + failed;
  }
  let s = '已完成 ' + (job.completedFiles || 0) + '/' + (job.totalFiles || 0);
  if (job.totalBytes > 0) {
    s += ' · ' + humanBytes(job.downloadedBytes || 0) + ' / ' + humanBytes(job.totalBytes);
  } else {
    s += ' · ' + humanBytes(job.downloadedBytes || 0);
  }
  return s + failed;
}

function jobSubText(job) {
  if (job.status === 'running') {
    if (job.phase === 'packing') return '正在压缩并写入 ZIP…';
    if (job.phase === 'saving') return '正在触发浏览器保存…';
    const parts = [];
    const sp = speedLabel(job);
    if (sp !== '—') parts.push('速度 ' + sp);
    const eta = etaLabel(job);
    if (eta !== '—') parts.push('剩余 ' + eta);
    parts.push('并发 ' + (job.concurrency || settings.concurrency));
    const active = job.activeFiles || [];
    if (active.length) parts.push('活跃 ' + active.length + ' 个');
    if (!parts.length) parts.push('正在准备…');
    return parts.join(' · ');
  }
  if (job.status === 'done') {
    return '用时 ' + humanDuration(job.elapsedMs) + (job.failedFiles ? ' · 失败 ' + job.failedFiles : '');
  }
  if (job.status === 'cancelled') {
    return '已取消 · 成功 ' + (job.completedFiles || 0) + ' · 用时 ' + humanDuration(job.elapsedMs);
  }
  return '用时 ' + humanDuration(job.elapsedMs);
}

function jobCurrentText(job) {
  if (job.status !== 'running') {
    if (job.status === 'done') {
      let s = '输出：' + (job.result && job.result.filename ? job.result.filename : job.dirName);
      if (job.result && job.result.totalSize) s += '（' + humanBytes(job.result.totalSize) + '）';
      return s;
    }
    if (job.status === 'error') return '任务失败，展开日志可查看具体原因。';
    if (job.status === 'cancelled') return '任务已取消，已完成的文件会保留。';
    return '';
  }
  if (job.phase === 'packing') {
    return '正在打包 ZIP… ' + (job.packingDone || 0) + '/' + (job.packingTotal || job.totalFiles);
  }
  if (job.phase === 'saving') return '正在保存 ZIP 文件…';
  if ((job.activeFiles || []).length) return '';
  return '正在准备下载…';
}

function renderActive(job) {
  const el = $('job-active');
  const list = job.status === 'running' ? job.activeFiles || [] : [];
  if (!list.length || job.phase === 'packing' || job.phase === 'saving') {
    el.hidden = true;
    el.replaceChildren();
    return;
  }

  const frag = document.createDocumentFragment();
  const title = document.createElement('div');
  title.className = 'active-title';
  title.textContent = '正在下载 ' + list.length + ' 个文件';
  frag.appendChild(title);

  for (const a of list) {
    const row = document.createElement('div');
    row.className = 'active-item';

    const head = document.createElement('div');
    head.className = 'active-head';

    const nm = document.createElement('span');
    nm.className = 'active-name';
    nm.textContent = a.rel;
    nm.title = a.rel;

    const pct = document.createElement('span');
    pct.className = 'active-pct';
    pct.textContent = a.percent == null ? humanBytes(a.bytes) : a.percent + '%';

    head.append(nm, pct);

    const bar = document.createElement('div');
    bar.className = 'active-bar';
    const fill = document.createElement('div');
    fill.className = 'active-fill';
    fill.style.width = (a.percent == null ? 0 : a.percent) + '%';
    bar.appendChild(fill);

    row.append(head, bar);
    frag.appendChild(row);
  }

  el.replaceChildren(frag);
  el.hidden = false;
}

function renderResult(job) {
  const r = job.result;
  if (!r) {
    hideResult();
    return;
  }

  if (job.status === 'done') {
    let html = '✅ 完成：成功 ' + (r.count || 0) + '/' + job.totalFiles + ' 个文件';
    if (job.mode === 'zip') {
      html +=
        '<div class="result-sub">ZIP：' +
        escapeHtml(r.filename || '') +
        (r.totalSize ? ' · ' + humanBytes(r.totalSize) : '') +
        '</div>';
    } else {
      html += '<div class="result-sub">目录：' + escapeHtml(r.filename || job.dirName) + '</div>';
    }
    if (r.failed && r.failed.length) {
      html +=
        '<div class="result-sub">失败 ' +
        r.failed.length +
        ' 个：</div><ul>' +
        r.failed
          .slice(0, 8)
          .map((x) => '<li>' + escapeHtml(x.rel) + '：' + escapeHtml(x.error) + '</li>')
          .join('') +
        '</ul>';
      if (r.failed.length > 8) {
        html += '<div class="result-sub">还有 ' + (r.failed.length - 8) + ' 个，详见日志。</div>';
      }
    }
    showResult(html, 'ok');
    return;
  }

  if (job.status === 'cancelled') {
    showResult('⚠️ 已取消：成功 ' + (r.count || 0) + '/' + job.totalFiles + ' 个文件。', 'warn');
    return;
  }

  let html = '❌ 任务失败';
  if (r.failed && r.failed.length) {
    html +=
      '<ul>' +
      r.failed
        .slice(0, 8)
        .map((x) => '<li>' + escapeHtml(x.rel) + '：' + escapeHtml(x.error) + '</li>')
        .join('') +
      '</ul>';
  }
  showResult(html, 'err');
}

function updateButtons() {
  const running = !!(currentJob && currentJob.status === 'running');
  const n = selected.size;
  $('btn-each').disabled = !payload || running || n === 0;
  $('btn-zip').disabled = !payload || running || n === 0;
  $('actions').hidden = !payload || running;
  $('btn-cancel').hidden = !running;
  $('btn-open-folder').hidden = running || !currentJob;
  $('btn-clear-job').hidden = running || !currentJob;
  $('btn-cancel').disabled = false;
  $('btn-cancel').textContent = '取消任务';
  $('btn-each').textContent = n > 0 ? '逐个下载（已选 ' + n + ' 个）' : '逐个下载';
  $('btn-zip').textContent = n > 0 ? '打包 ZIP（已选 ' + n + ' 个）' : '打包为 ZIP';
}

function renderJob(job, applyStatuses) {
  currentJob = job || null;
  if (!job) {
    $('job-card').hidden = true;
    updateButtons();
    syncRunningState();
    return;
  }

  $('job-card').hidden = false;
  $('job-phase').textContent = phaseLabel(job) + (job.single ? '（单文件）' : '');
  const percent = progressPercent(job);
  $('job-percent').textContent = percent + '%';
  $('job-fill').style.width = percent + '%';
  $('job-main').textContent = jobMainText(job);
  $('job-sub').textContent = jobSubText(job);
  $('job-current').textContent = jobCurrentText(job);
  renderActive(job);
  renderResult(job);
  if (applyStatuses !== false) updateFileStatuses(job.files);
  if (!syncRunningState()) updateButtons();
  scheduleLogRender();
}

function applyJob(job) {
  if (!job) return;
  currentJob = job;
  // 列表始终以扫描结果为准（未勾选的文件也要留在列表里）
  if (!payload) renderFileList(job.files || []);
  renderJob(job);
}

/* ------------------------------------------------------------
 * 动作
 * ---------------------------------------------------------- */
function setDownloadBusy(v) {
  $('btn-each').disabled = v;
  $('btn-zip').disabled = v;
  $('refresh').disabled = v;
}

function selectedFiles() {
  if (!payload) return [];
  return (payload.files || []).filter((f) => selected.has(f.rel));
}

async function startDownload(mode) {
  if (!payload || (currentJob && currentJob.status === 'running')) return;

  const files = selectedFiles();
  if (files.length === 0) {
    setStatus('请先勾选要下载的文件（列表前的勾选框）。', true);
    return;
  }

  hideResult();
  setDownloadBusy(true);
  setStatus('正在启动任务…');

  const resp = await send({
    type: 'WBDA2_START_JOB',
    payload: {
      mode,
      tabId: payload._tabId,
      taskId: payload.taskId,
      taskName: payload.taskName,
      base: payload.base,
      token: payload.token,
      files,
    },
  });

  setDownloadBusy(false);

  if (!resp || !resp.ok) {
    setStatus((resp && resp.error) || '启动下载失败', true);
    updateButtons();
    return;
  }

  hideStatus();
  currentJob = resp.job;
  renderJob(currentJob);
}

async function downloadSingle(rel) {
  if (!payload) return;
  if (currentJob && currentJob.status === 'running') {
    setStatus('已有任务正在运行，请等待完成后再单独下载。', true);
    return;
  }
  const f = (payload.files || []).find((x) => x.rel === rel);
  if (!f) return;

  setStatus('正在单独下载：' + rel);
  const resp = await send({
    type: 'WBDA2_DOWNLOAD_ONE',
    payload: {
      tabId: payload._tabId,
      taskId: payload.taskId,
      taskName: payload.taskName,
      base: payload.base,
      token: payload.token,
      file: f,
    },
  });

  if (!resp || !resp.ok) {
    setStatus((resp && resp.error) || '单独下载失败', true);
    return;
  }
  hideStatus();
  currentJob = resp.job;
  renderJob(currentJob);
}

async function cancelJob() {
  if (!currentJob || currentJob.status !== 'running') return;
  $('btn-cancel').disabled = true;
  $('btn-cancel').textContent = '取消中…';
  const resp = await send({ type: 'WBDA2_CANCEL_JOB' });
  if (!resp || !resp.ok) {
    setStatus((resp && resp.error) || '取消失败', true);
    $('btn-cancel').disabled = false;
    $('btn-cancel').textContent = '取消任务';
  }
}

async function clearJob() {
  const resp = await send({ type: 'WBDA2_CLEAR_JOB' });
  if (!resp || !resp.ok) {
    setStatus((resp && resp.error) || '清除失败', true);
    return;
  }
  currentJob = null;
  $('job-card').hidden = true;
  hideResult();
  if (payload) renderFileList(payload.files);
  updateSelectionUi();
}

function openDownloadFolder() {
  try {
    chrome.downloads.showDefaultFolder();
  } catch (e) {
    setStatus('无法打开下载文件夹：' + String((e && e.message) || e), true);
  }
}

function openSettings() {
  try {
    chrome.runtime.openOptionsPage();
    window.close();
  } catch (e) {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
}

/* ------------------------------------------------------------
 * 日志
 * ---------------------------------------------------------- */
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

function currentLogs() {
  if (!currentJob || !Array.isArray(currentJob.logs)) return [];
  const filter = $('log-filter').value;
  return currentJob.logs.filter((l) => filter === 'all' || l.level === filter);
}

function renderLogs(forceScroll) {
  const el = $('log-list');
  if (!currentJob) {
    el.innerHTML = '<div class="log-empty">暂无日志</div>';
    return;
  }

  const logs = currentLogs();
  if (logs.length === 0) {
    el.innerHTML = '<div class="log-empty">暂无日志</div>';
    return;
  }

  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  const frag = document.createDocumentFragment();
  for (const l of logs.slice(-800)) {
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

function scheduleLogRender() {
  if (!logOpen) return;
  if (logRenderTimer) return;
  logRenderTimer = setTimeout(() => {
    logRenderTimer = null;
    renderLogs(false);
  }, 500);
}

function toggleLog(force) {
  logOpen = typeof force === 'boolean' ? force : !logOpen;
  $('log-panel').hidden = !logOpen;
  $('toggle-log').textContent = logOpen ? '收起日志' : '日志';
  if (logOpen) renderLogs(true);
}

async function copyLogs() {
  const text = currentLogs()
    .map((l) => '[' + logTime(l.t) + '] [' + (l.level || 'info') + '] ' + (l.msg || ''))
    .join('\n');
  if (!text) {
    setStatus('暂无日志可复制');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setStatus('日志已复制到剪贴板');
  } catch (e) {
    setStatus('复制失败：' + String((e && e.message) || e), true);
  }
}

function openLogWindow() {
  chrome.tabs.create({ url: chrome.runtime.getURL('logs.html') });
}

/* ------------------------------------------------------------
 * 初始化
 * ---------------------------------------------------------- */
async function loadJob() {
  const resp = await send({ type: 'WBDA2_GET_JOB' });
  if (resp && resp.ok && resp.job) {
    currentJob = resp.job;
    if (!payload) renderFileList(resp.job.files || []);
    renderJob(resp.job);
  }
}

function bindEvents() {
  $('btn-each').addEventListener('click', () => startDownload('each'));
  $('btn-zip').addEventListener('click', () => startDownload('zip'));
  $('refresh').addEventListener('click', () => scan());
  $('btn-cancel').addEventListener('click', () => cancelJob());
  $('btn-open-folder').addEventListener('click', () => openDownloadFolder());
  $('btn-clear-job').addEventListener('click', () => clearJob());
  $('btn-settings').addEventListener('click', () => openSettings());
  $('toggle-log').addEventListener('click', () => toggleLog());
  $('log-close').addEventListener('click', () => toggleLog(false));
  $('log-copy').addEventListener('click', () => copyLogs());
  $('log-window').addEventListener('click', () => openLogWindow());
  $('log-filter').addEventListener('change', () => renderLogs(true));

  $('check-all').addEventListener('change', (e) => setAllSelected(!!e.target.checked));
  $('btn-select-none').addEventListener('click', () => setAllSelected(false));

  $('file-list').addEventListener('click', (e) => {
    const li = e.target.closest('li.file-item');
    if (!li) return;
    if (currentJob && currentJob.status === 'running') return;

    const cb = e.target.closest('input.file-check');
    if (cb) {
      setRelSelected(cb.dataset.rel, cb.checked);
      return;
    }
    const input = li.querySelector('input.file-check');
    if (!input) return;
    input.checked = !input.checked;
    setRelSelected(li.dataset.rel, input.checked);
  });

  $('file-list').addEventListener('dblclick', (e) => {
    if (e.target.closest('input.file-check')) return;
    const li = e.target.closest('li.file-item');
    if (!li) return;
    e.preventDefault();
    downloadSingle(li.dataset.rel);
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'WBDA2_JOB_UPDATE' && msg.job) {
    applyJob(msg.job);
  }
});

WBDA.onChange((s) => {
  settings = s;
  if (currentJob) renderJob(currentJob, false);
  else updateButtons();
});

setInterval(async () => {
  if (!currentJob || currentJob.status !== 'running') return;
  const resp = await send({ type: 'WBDA2_GET_JOB' });
  if (resp && resp.ok && resp.job) applyJob(resp.job);
}, 3000);

async function init() {
  settings = await WBDA.load();
  bindEvents();
  toggleLog(!!settings.logDefaultOpen);
  await loadJob();
  await scan();
}

init();
