/* ============================================================
 * WorkBuddy 产物下载器 — 设置页 (options.js) v2.2
 * 修改即保存（chrome.storage.local），所有页面实时生效。
 * ============================================================ */
const $ = (id) => document.getElementById(id);

let savedTimer = null;

const DEMO = {
  percentBytes: 62,
  percentFiles: 48,
  speedBytes: 3.2 * 1024 * 1024,
  speedFiles: 1.25,
  etaBytes: 95,
  etaFiles: 310,
};

function flashSaved(text) {
  const el = $('saved');
  el.textContent = text || '已保存';
  el.classList.add('show');
  if (savedTimer) clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

function applyToForm(s) {
  $('concurrency').value = s.concurrency;
  $('hideDownloadUi').checked = s.hideDownloadUi;
  $('clearDownloadHistory').checked = s.clearDownloadHistory;
  $('fixFileExtension').checked = s.fixFileExtension;
  $('progressMetric').value = s.progressMetric;
  $('speedMetric').value = s.speedMetric;
  $('etaMetric').value = s.etaMetric;
  $('logDefaultOpen').checked = s.logDefaultOpen;
  renderPreview(s);
  highlightChips(s.concurrency);
}

function renderPreview(s) {
  $('preview-progress').textContent =
    '已完成 12/25 · ' + WBDA.percentValue(s.progressMetric, DEMO.percentBytes, DEMO.percentFiles) + '%';
  $('preview-speed').textContent = WBDA.speedText(s.speedMetric, DEMO.speedBytes, DEMO.speedFiles);
  $('preview-eta').textContent = WBDA.etaText(s.etaMetric, DEMO.etaBytes, DEMO.etaFiles);
}

function highlightChips(value) {
  document.querySelectorAll('.chip').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.conc) === Number(value));
  });
}

async function update(patch, message) {
  const s = await WBDA.save(patch);
  applyToForm(s);
  flashSaved(message);
  return s;
}

async function updateConcurrency(raw) {
  const before = await WBDA.load();
  const n = WBDA.clampConcurrency(raw);
  $('concurrency').value = n;
  if (n !== before.concurrency) await update({ concurrency: n }, '并发数已保存：' + n);
  else {
    highlightChips(n);
    if (String(raw) !== String(n)) flashSaved('已调整为 ' + n);
  }
}

function bind() {
  const conc = $('concurrency');

  conc.addEventListener('change', () => updateConcurrency(conc.value));
  conc.addEventListener('blur', () => updateConcurrency(conc.value));
  conc.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      conc.blur();
    }
  });

  document.querySelectorAll('.chip').forEach((btn) => {
    btn.addEventListener('click', () => updateConcurrency(btn.dataset.conc));
  });

  $('hideDownloadUi').addEventListener('change', (e) => update({ hideDownloadUi: e.target.checked }));
  $('clearDownloadHistory').addEventListener('change', (e) =>
    update({ clearDownloadHistory: e.target.checked })
  );
  $('fixFileExtension').addEventListener('change', (e) => update({ fixFileExtension: e.target.checked }));
  $('progressMetric').addEventListener('change', (e) => update({ progressMetric: e.target.value }));
  $('speedMetric').addEventListener('change', (e) => update({ speedMetric: e.target.value }));
  $('etaMetric').addEventListener('change', (e) => update({ etaMetric: e.target.value }));
  $('logDefaultOpen').addEventListener('change', (e) => update({ logDefaultOpen: e.target.checked }));

  $('reset').addEventListener('click', async () => {
    const s = await WBDA.save(WBDA.DEFAULTS);
    applyToForm(s);
    flashSaved('已恢复默认设置');
  });

  WBDA.onChange((s) => {
    if (document.activeElement !== $('concurrency')) applyToForm(s);
  });
}

async function init() {
  const s = await WBDA.load();
  applyToForm(s);
  bind();
}

init();
