/* ============================================================
 * WorkBuddy 产物下载器 — offscreen Blob 中继 (offscreen.js) v2.2
 *
 * 为什么需要它：
 *   Chrome 的下载目标判定会按响应 Content-Type 强制改写扩展名。
 *   服务器把 .apkg 当 application/zip 返回时，chrome.downloads 会把
 *   x.apkg 存成 x.zip。唯一可靠做法是自己读取字节，包成
 *   application/octet-stream 的 Blob，再交给 chrome.downloads 下载。
 *
 * MV3 service worker 没有 URL.createObjectURL；offscreen 文档有 DOM，
 * 但只支持 runtime API，所以这里只负责 fetch + createObjectURL，
 * 真正的 chrome.downloads.download 由 background 调用（可带子目录）。
 * ============================================================ */
(() => {
  const BLOB_TTL_MS = 30 * 60 * 1000;
  const INACTIVITY_MS = 5 * 60 * 1000;
  /** blobUrl -> revoke timer */
  const blobs = new Map();

  function sendProgress(requestId, received, total) {
    try {
      chrome.runtime.sendMessage(
        { type: 'WBDA2_BLOB_PROGRESS', requestId, received, total },
        () => void chrome.runtime.lastError
      );
    } catch (e) {
      /* background 可能正在重启 */
    }
  }

  function rememberUrl(url) {
    const timer = setTimeout(() => {
      blobs.delete(url);
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
        /* ignore */
      }
    }, BLOB_TTL_MS);
    blobs.set(url, timer);
  }

  function revokeUrl(url) {
    if (!url) return;
    const timer = blobs.get(url);
    if (timer) clearTimeout(timer);
    blobs.delete(url);
    try {
      URL.revokeObjectURL(url);
    } catch (e) {
      /* ignore */
    }
  }

  async function fetchBlob(msg) {
    const controller = new AbortController();
    let idleTimer = null;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try {
          controller.abort(new Error('读取超时：5 分钟没有收到新数据'));
        } catch (e) {
          controller.abort();
        }
      }, INACTIVITY_MS);
    };
    resetIdle();

    try {
      const base = String(msg.base || '').replace(/\/+$/, '');
      const url = base + '/files?path=' + encodeURIComponent(msg.path);
      const resp = await fetch(url, {
        headers: { 'X-Access-Token': msg.token },
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);

      const headerTotal = Number(resp.headers.get('content-length') || 0);
      const chunks = [];
      let received = 0;
      let lastReport = 0;

      if (!resp.body) {
        const buf = new Uint8Array(await resp.arrayBuffer());
        chunks.push(buf);
        received = buf.byteLength;
      } else {
        const reader = resp.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.length === 0) continue;
          chunks.push(value);
          received += value.length;
          resetIdle();
          const t = Date.now();
          if (t - lastReport >= 200 || (headerTotal > 0 && received >= headerTotal)) {
            lastReport = t;
            sendProgress(msg.requestId, received, headerTotal || 0);
          }
        }
      }

      sendProgress(msg.requestId, received, headerTotal || received);
      const blob = new Blob(chunks, { type: 'application/octet-stream' });
      const blobUrl = URL.createObjectURL(blob);
      rememberUrl(blobUrl);
      return { ok: true, url: blobUrl, size: blob.size };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== 'offscreen') return false;

    if (msg.type === 'WBDA2_FETCH_BLOB') {
      fetchBlob(msg)
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
      return true;
    }

    if (msg.type === 'WBDA2_REVOKE_BLOB') {
      revokeUrl(msg.url);
      sendResponse({ ok: true });
      return false;
    }

    if (msg.type === 'WBDA2_BLOB_PING') {
      sendResponse({ ok: true, blobs: blobs.size });
      return false;
    }

    return false;
  });
})();
