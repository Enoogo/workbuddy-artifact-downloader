/* ============================================================
 * WorkBuddy 产物下载器 — 内容脚本 (content.js) v2
 *
 * 职责：
 *   1. 分层扫描当前对话的产物清单（React 内部数据 → DOM → 自动展开 → 工作区兜底）；
 *   2. 执行「打包 ZIP」任务：带字节级进度读取文件、增量计算 CRC32、
 *      逐文件上报打包进度，最后用页面上下文的 <a download> 落盘；
 *   3. 为后台提供会话刷新（Token 过期时重取）。
 *
 * 注意：v2 使用 WBDA2_* 消息前缀，避免页面里可能残留的 v1 内容脚本
 * 抢答消息；两者可以安全共存。
 * ============================================================ */
(() => {
  if (window.__wbArtifactDownloaderV3) return;
  window.__wbArtifactDownloaderV3 = true;

  const WORKSPACE = '/workspace/';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Date.now();

  /** ZIP 任务：jobId -> { controller, canceled } */
  const zipJobs = new Map();

  function decodeSafe(s) {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  }

  function sanitizeName(s) {
    const out = String(s || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/^_+|_+$/g, '');
    return out || 'task';
  }

  function getTaskIdFromUrl() {
    const m = location.pathname.match(/\/app\/conversation\/(\d+)/);
    return m ? m[1] : null;
  }

  /* ============================================================
   * L1 底层数据：React fiber 树里的 allArtifacts / artifacts
   * ========================================================== */
  function collectFiberRoots() {
    const roots = [];
    const rootEl = document.getElementById('root') || document.body;
    const candidates = [rootEl, rootEl.firstElementChild].filter(Boolean);
    for (const el of candidates) {
      for (const k of Object.keys(el)) {
        if (k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$')) {
          roots.push(el[k]);
        }
      }
    }
    return roots;
  }

  function normalizeArtifactPath(a) {
    let p = a && (a.filePath || a.uri);
    if (!p) return null;
    p = decodeSafe(String(p));
    if (p.startsWith('agent://files/')) p = p.slice('agent://files'.length);
    else if (p.startsWith('agent://')) p = p.slice('agent://'.length);
    if (p.startsWith('file://')) {
      try {
        p = decodeURIComponent(new URL(p).pathname);
      } catch (e) {
        p = p.replace(/^file:\/\//, '');
      }
    }
    if (!p.startsWith('/')) p = '/' + p;
    return p;
  }

  /** 把产物条目归一化为文件记录（严格按当前对话过滤，避免跨对话串数据） */
  function artifactToRecord(a, taskId) {
    if (!a || typeof a !== 'object') return null;
    if (a.conversationId != null && String(a.conversationId) !== String(taskId)) return null;

    const p = normalizeArtifactPath(a);
    if (!p || !p.startsWith(WORKSPACE)) return null;

    const rel = p.slice(WORKSPACE.length);
    if (!rel) return null;

    const sizeNum = a.size == null || a.size === '' ? null : Number(a.size);
    return {
      path: p,
      rel,
      name: a.title || rel.split('/').pop(),
      size: Number.isFinite(sizeNum) ? sizeNum : null,
      mimeType: a.mimeType || null,
      isMedia: a.type === 'media-artifact' || a.category === 'media',
    };
  }

  function mergeRecord(map, rec) {
    if (!rec) return;
    const old = map.get(rec.path);
    if (!old) {
      map.set(rec.path, rec);
      return;
    }
    if (old.size == null && rec.size != null) old.size = rec.size;
    if (!old.mimeType && rec.mimeType) old.mimeType = rec.mimeType;
    if (rec.isMedia) old.isMedia = true;
  }

  function deepScanArtifacts(taskId) {
    const map = new Map();
    const queue = collectFiberRoots();
    const seen = new Set();
    let visited = 0;
    let arrays = 0;
    let cursor = 0;

    while (cursor < queue.length && visited < 200000) {
      const f = queue[cursor++];
      if (!f || seen.has(f)) continue;
      seen.add(f);
      visited++;

      const p = f.memoizedProps;
      if (p && typeof p === 'object') {
        for (const key of ['allArtifacts', 'artifacts']) {
          const arr = p[key];
          if (Array.isArray(arr)) {
            arrays++;
            for (const a of arr) mergeRecord(map, artifactToRecord(a, taskId));
          }
        }
      }
      if (f.child) queue.push(f.child);
      if (f.sibling) queue.push(f.sibling);
    }
    return { map, visited, arrays };
  }

  /* ============================================================
   * L2 页面 DOM
   * ========================================================== */
  function domScanArtifacts(map, taskId) {
    document.querySelectorAll('.cb-overview-artifact-item[data-dir]').forEach((el) => {
      mergeRecord(
        map,
        artifactToRecord({ filePath: el.getAttribute('data-dir'), title: el.getAttribute('title') }, taskId)
      );
    });
    document.querySelectorAll('.artifact-slot-panel__card').forEach((el) => {
      const share = el.getAttribute('data-share');
      const m = share && share.match(/^agent:\/\/\/(.+)$/);
      const path = m ? decodeSafe(m[1]) : el.getAttribute('data-dir');
      if (path) mergeRecord(map, artifactToRecord({ filePath: path }, taskId));
    });
  }

  /* ============================================================
   * L3 自动激活「查看所有产物 (N)」
   * ========================================================== */
  function expectedCountFromUi() {
    let btn = document.querySelector('.artifact-slot-panel__action-btn');
    if (!btn) {
      btn = [...document.querySelectorAll('button')].find((b) =>
        /查看所有产物|全部产物/.test((b.textContent || '').trim())
      );
    }
    const label = (btn && btn.textContent) || '';
    const m = label.match(/\((\d+)\)/);
    return m ? Number(m[1]) : null;
  }

  async function activateAndRescan(map, taskId) {
    let btn = document.querySelector('.artifact-slot-panel__action-btn');
    if (!btn) {
      btn = [...document.querySelectorAll('button')].find((b) =>
        /查看所有产物|全部产物/.test((b.textContent || '').trim())
      );
    }
    if (!btn) return false;
    btn.click();
    await sleep(700);
    domScanArtifacts(map, taskId);
    return true;
  }

  /* ============================================================
   * L4 工作区兜底：ListDir
   * ========================================================== */
  async function listWorkspaceFiles(base, token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const r = await fetch(base + '/filesystem.Filesystem/ListDir', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'X-Access-Token': token,
        },
        body: JSON.stringify({ path: '/workspace', depth: 10 }),
        signal: controller.signal,
      });
      if (!r.ok) throw new Error('ListDir HTTP ' + r.status);
      const j = await r.json();
      return (j.entries || [])
        .filter((e) => e && e.type === 'FILE_TYPE_FILE' && e.path)
        .map((e) => {
          const p = String(e.path);
          const rel = p.startsWith(WORKSPACE) ? p.slice(WORKSPACE.length) : p;
          const sizeNum = e.size == null ? null : Number(e.size);
          return {
            path: p,
            rel,
            name: rel.split('/').pop(),
            size: Number.isFinite(sizeNum) ? sizeNum : null,
            mimeType: null,
            isMedia: false,
          };
        })
        .filter((f) => f.rel && !f.rel.split('/').some((seg) => seg.startsWith('.')));
    } finally {
      clearTimeout(timer);
    }
  }

  /* ============================================================
   * 会话凭证
   * ========================================================== */
  async function fetchSession(taskId) {
    const id = taskId || getTaskIdFromUrl();
    if (!id) throw new Error('当前页面不是 WorkBuddy 对话页');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const r = await fetch('/console/as/conversations/' + encodeURIComponent(id) + '/session', {
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!r.ok) {
        throw new Error('获取会话信息失败 (HTTP ' + r.status + ')，请确认已登录 WorkBuddy');
      }
      const j = await r.json();
      const d = j && j.data;
      if (!d || !d.e2bDataEndpoint || !d.token) {
        throw new Error('会话接口未返回文件服务地址或令牌');
      }
      let base = String(d.e2bDataEndpoint);
      if (!/^https?:\/\//i.test(base)) {
        base = new URL(base, location.origin).toString();
      }
      return {
        base: base.replace(/\/+$/, ''),
        token: d.token,
        taskName: d.name || (d.sessions && d.sessions[0] && d.sessions[0].sessionName) || '',
      };
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error('获取会话信息超时（15 秒），请刷新页面后重试');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ============================================================
   * 扫描主流程
   * ========================================================== */
  async function listArtifacts() {
    const taskId = getTaskIdFromUrl();
    if (!taskId) {
      return {
        ok: false,
        error: '当前页面不是 WorkBuddy 对话页。请先打开一个对话（网址形如 /app/conversation/…）。',
      };
    }

    const startedAt = now();
    const map = new Map();
    let source = 'react';

    const deep = deepScanArtifacts(taskId);
    deep.map.forEach((v) => mergeRecord(map, v));
    const expected = expectedCountFromUi();

    if (map.size === 0) {
      domScanArtifacts(map, taskId);
      source = 'dom';
    }
    if (map.size === 0 || (expected != null && map.size < expected)) {
      const activated = await activateAndRescan(map, taskId);
      if (activated) source = source === 'dom' ? 'dom-activated' : 'react-activated';
    }

    const session = await fetchSession(taskId);

    let records = [...map.values()];
    const mediaOnly = records.filter((r) => r.isMedia);
    if (
      mediaOnly.length > 0 &&
      (expected == null ? mediaOnly.length === records.length : mediaOnly.length >= expected)
    ) {
      records = mediaOnly;
    }

    if (records.length === 0) {
      try {
        records = await listWorkspaceFiles(session.base, session.token);
        source = 'workspace';
      } catch (e) {
        /* 保持空 */
      }
    }

    if (records.length === 0) {
      return {
        ok: false,
        error: '未能扫描到产物。请确认该对话已生成产物，然后点弹窗里的「刷新」重试。',
      };
    }

    if (records.some((r) => r.size == null)) {
      try {
        const ws = await listWorkspaceFiles(session.base, session.token);
        const sizeMap = new Map(ws.map((f) => [f.path, f.size]));
        records.forEach((r) => {
          if (r.size == null && sizeMap.has(r.path)) r.size = sizeMap.get(r.path);
        });
      } catch (e) {
        /* 大小仅用于展示 */
      }
    }

    records.sort((a, b) => a.rel.localeCompare(b.rel));
    const totalSize = records.reduce((s, r) => s + (r.size || 0), 0);
    const unknownSize = records.filter((r) => r.size == null).length;

    return {
      ok: true,
      taskId,
      taskName: session.taskName,
      base: session.base,
      token: session.token,
      files: records.map((r) => ({
        path: r.path,
        rel: r.rel,
        name: r.name,
        size: r.size,
        mimeType: r.mimeType,
      })),
      source,
      expected,
      visited: deep.visited,
      mediaCount: mediaOnly.length,
      totalSize,
      unknownSize,
      scanMs: now() - startedAt,
    };
  }

  /* ============================================================
   * 文件读取（带字节进度 + 增量 CRC32）
   * ========================================================== */
  async function fetchFileStream(base, token, path, opts) {
    const options = opts || {};
    const signal = options.signal;
    const inactivityMs = options.inactivityMs || 120000;
    const onBytes = options.onBytes;

    const controller = new AbortController();
    let timer = null;
    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          controller.abort(new Error('下载超时：' + Math.round(inactivityMs / 1000) + ' 秒没有收到新数据'));
        } catch (e) {
          controller.abort();
        }
      }, inactivityMs);
    };
    const onAbort = () => {
      try {
        controller.abort(new Error('已取消'));
      } catch (e) {
        controller.abort();
      }
    };

    if (signal) {
      if (signal.aborted) throw new Error('已取消');
      signal.addEventListener('abort', onAbort, { once: true });
    }
    resetTimer();

    try {
      const r = await fetch(base + '/files?path=' + encodeURIComponent(path), {
        headers: { 'X-Access-Token': token },
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);

      const headerTotal = Number(r.headers.get('content-length') || 0);
      let buffer = headerTotal > 0 ? new Uint8Array(headerTotal) : null;
      let chunks = buffer ? null : [];
      let received = 0;
      let crc = wbCrc32Init();

      if (!r.body) {
        const buf = new Uint8Array(await r.arrayBuffer());
        received = buf.byteLength;
        crc = wbCrc32Update(crc, buf);
        if (onBytes) onBytes(received, received);
        return { data: buf, size: received, crc: wbCrc32Final(crc) };
      }

      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;

        if (buffer && received + value.length <= buffer.length) {
          buffer.set(value, received);
        } else {
          if (buffer) {
            chunks = [buffer.subarray(0, received)];
            buffer = null;
          }
          chunks.push(value);
        }
        received += value.length;
        crc = wbCrc32Update(crc, value);
        resetTimer();
        if (onBytes) onBytes(received, headerTotal > 0 ? headerTotal : null);
      }

      let data;
      if (buffer && received === buffer.length) {
        data = buffer;
      } else if (buffer) {
        data = buffer.subarray(0, received);
      } else {
        data = new Uint8Array(received);
        let off = 0;
        for (const c of chunks) {
          data.set(c, off);
          off += c.length;
        }
      }
      return { data, size: received, crc: wbCrc32Final(crc) };
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /* ============================================================
   * ZIP 任务
   * ========================================================== */
  function sendJobEvent(jobId, event) {
    try {
      chrome.runtime.sendMessage({ type: 'WBDA2_JOB_EVENT', jobId, event }, () => {
        void chrome.runtime.lastError;
      });
    } catch (e) {
      /* ignore */
    }
  }

  function sendJobEventReliable(jobId, event) {
    sendJobEvent(jobId, event);
    setTimeout(() => sendJobEvent(jobId, event), 400);
    setTimeout(() => sendJobEvent(jobId, event), 1200);
  }

  function triggerAnchorDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return url;
  }

  /* ============================================================
   * 扩展名兜底：用页面直存保存单个文件
   *
   * Chrome 的 chrome.downloads 会按服务器 Content-Type 强制改写扩展名
   * （例：.apkg 返回 application/zip → 落盘变成 .zip）。
   * 这里用 fetch 自己取回字节、包成 application/octet-stream 的 Blob，
   * 再用 <a download> 保存，文件名与扩展名完全由我们决定。
   * ========================================================== */
  function sanitizeDownloadName(name) {
    return (
      String(name || 'file')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .replace(/^\.+/, '_')
        .slice(0, 150) || 'file'
    );
  }

  async function saveBlobDirect(msg) {
    const name = sanitizeDownloadName(msg.filename);
    const res = await fetchFileStream(msg.base, msg.token, msg.path, { inactivityMs: 300000 });
    const blob = new Blob([res.data], { type: 'application/octet-stream' });
    let url = '';
    try {
      url = triggerAnchorDownload(blob, name);
    } finally {
      // 尽早释放页面侧的大缓冲
      res.data = null;
    }
    return { ok: true, filename: name, size: res.size, url };
  }

  async function runZipJob(job, state) {
    const files = job.files || [];
    const results = [];
    const failed = [];
    const zipName = sanitizeName(job.dirName || 'WorkBuddy产物_' + job.taskId) + '.zip';
    const startedAt = now();

    sendJobEvent(job.id, {
      type: 'phase',
      phase: 'downloading',
      message: `开始读取 ${files.length} 个文件…`,
      total: files.length,
    });

    let cursor = 0;
    const worker = async () => {
      while (!state.canceled) {
        const f = files[cursor++];
        if (!f) break;

        sendJobEvent(job.id, { type: 'file-start', index: f.index, rel: f.rel, size: f.size });
        let attempt = 0;
        let ok = false;
        let lastErr = '';

        while (attempt < 2 && !state.canceled) {
          attempt++;
          let lastReport = 0;
          try {
            const res = await fetchFileStream(job.base, job.token, f.path, {
              signal: state.controller.signal,
              inactivityMs: 120000,
              onBytes: (received, totalBytes) => {
                const t = now();
                if (t - lastReport >= 150 || (totalBytes && received >= totalBytes)) {
                  lastReport = t;
                  sendJobEvent(job.id, {
                    type: 'file-progress',
                    index: f.index,
                    bytes: received,
                    total: totalBytes || f.size || 0,
                  });
                }
              },
            });
            if (state.canceled) break;
            results.push({
              index: f.index,
              name: f.rel,
              data: res.data,
              size: res.size,
              crc: res.crc,
            });
            ok = true;
            sendJobEvent(job.id, {
              type: 'file-done',
              index: f.index,
              rel: f.rel,
              bytes: res.size,
              size: res.size,
            });
            break;
          } catch (e) {
            lastErr = String((e && e.message) || e);
            if (state.canceled || /已取消/.test(lastErr)) break;
            if (attempt < 2) {
              sendJobEvent(job.id, {
                type: 'log',
                level: 'warn',
                message: `读取 ${f.rel} 失败（${lastErr}），正在重试…`,
              });
              await sleep(700);
            }
          }
        }

        if (state.canceled) break;
        if (!ok) {
          failed.push({ rel: f.rel, error: lastErr || '读取失败' });
          sendJobEvent(job.id, {
            type: 'file-failed',
            index: f.index,
            rel: f.rel,
            error: lastErr || '读取失败',
          });
        }
      }
    };

    await Promise.all([worker(), worker()]);

    if (state.canceled) {
      sendJobEventReliable(job.id, { type: 'cancelled' });
      return;
    }
    if (results.length === 0) {
      sendJobEventReliable(job.id, {
        type: 'error',
        error:
          '所有文件读取失败：' +
          failed
            .slice(0, 8)
            .map((x) => x.rel + '：' + x.error)
            .join('；'),
      });
      return;
    }

    results.sort((a, b) => a.index - b.index);
    sendJobEvent(job.id, {
      type: 'phase',
      phase: 'packing',
      message: `正在打包 ZIP（${results.length} 个文件，${failed.length} 个失败）…`,
      total: results.length,
    });

    let blob;
    try {
      blob = await wbBuildZipAsync(results, (p) => {
        sendJobEvent(job.id, {
          type: 'zip-progress',
          done: p.done,
          total: p.total,
          bytes: p.bytes,
          totalBytes: p.totalBytes,
          packing: !!p.packing,
        });
      });
    } catch (e) {
      sendJobEventReliable(job.id, {
        type: 'error',
        error: 'ZIP 打包失败：' + String((e && e.message) || e),
      });
      return;
    }

    if (state.canceled) {
      sendJobEventReliable(job.id, { type: 'cancelled' });
      return;
    }

    sendJobEvent(job.id, { type: 'phase', phase: 'saving', message: '正在保存 ZIP 文件…' });
    let zipUrl = '';
    try {
      zipUrl = triggerAnchorDownload(blob, zipName);
    } catch (e) {
      sendJobEventReliable(job.id, {
        type: 'error',
        error: '保存 ZIP 失败：' + String((e && e.message) || e),
      });
      return;
    }

    const totalSize = blob.size;
    results.length = 0;
    sendJobEventReliable(job.id, {
      type: 'done',
      ok: true,
      filename: zipName,
      count: files.length - failed.length,
      failed,
      totalSize,
      url: zipUrl,
      durationMs: now() - startedAt,
    });
  }

  function startZipJob(job) {
    if (!job || !job.id || !Array.isArray(job.files)) {
      return { ok: false, error: '无效的 ZIP 任务' };
    }
    if (zipJobs.has(job.id)) return { ok: true };

    const state = { controller: new AbortController(), canceled: false };
    zipJobs.set(job.id, state);

    runZipJob(job, state)
      .catch((e) => {
        sendJobEventReliable(job.id, {
          type: 'error',
          error: String((e && e.message) || e),
        });
      })
      .finally(() => {
        zipJobs.delete(job.id);
      });

    return { ok: true };
  }

  /* ============================================================
   * 消息接口（WBDA2_*）
   * ========================================================== */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'WBDA2_PING':
        sendResponse({ ok: true, version: 3, caps: ['saveBlob', 'zip', 'scan'] });
        return;

      case 'WBDA2_PING3':
        sendResponse({ ok: true, version: 3, caps: ['saveBlob', 'zip', 'scan'] });
        return;

      case 'WBDA2_LIST':
        listArtifacts()
          .then(sendResponse)
          .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
        return true;

      case 'WBDA2_REFRESH_SESSION':
        fetchSession(msg.taskId)
          .then((s) => sendResponse({ ok: true, ...s }))
          .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
        return true;

      case 'WBDA2_ZIP_JOB':
        sendResponse(startZipJob(msg.job));
        return;

      case 'WBDA2_ZIP_CANCEL': {
        const state = zipJobs.get(msg.jobId);
        if (state) {
          state.canceled = true;
          try {
            state.controller.abort();
          } catch (e) {
            /* ignore */
          }
        }
        sendResponse({ ok: true });
        return;
      }

      case 'WBDA2_SAVE_BLOB':
        saveBlobDirect(msg)
          .then(sendResponse)
          .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
        return true;

      default:
        return;
    }
  });

  console.info('[WBDA] WorkBuddy 产物下载器 v2.1 内容脚本已就绪');
})();
