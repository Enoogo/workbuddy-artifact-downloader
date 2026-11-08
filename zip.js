/* ============================================================
 * 极简 ZIP 打包器 (zip.js) v2
 *
 * 仅使用 STORE（不压缩），适合已压缩的二进制产物（png/pdf/apk…）。
 * v2 改进：
 *   - CRC32 可在下载流中增量计算，避免打包时再完整扫一遍 100MB+ 文件；
 *   - 提供生成器 wbZipSteps / 异步 wbBuildZipAsync，可逐文件上报打包进度；
 *   - 校验 ZIP32 上限（4GB / 65535 个文件），超限时给出明确错误。
 *
 * 整个文件包在 IIFE 里，避免 content_scripts 重复注入（或页面里残留
 * v1 脚本）时出现 `const WB_CRC_TABLE` 重复声明导致 v2 内容脚本无法加载。
 * ============================================================ */
(() => {
  if (
    globalThis.wbCrc32Init &&
    globalThis.wbCrc32Update &&
    globalThis.wbCrc32Final &&
    globalThis.wbBuildZip &&
    globalThis.wbBuildZipAsync
  ) {
    return;
  }

const WB_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function wbCrc32Init() {
  return 0xffffffff;
}

function wbCrc32Update(crc, data) {
  let c = crc >>> 0;
  for (let i = 0; i < data.length; i++) {
    c = WB_CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return c >>> 0;
}

function wbCrc32Final(crc) {
  return (crc ^ 0xffffffff) >>> 0;
}

function wbCrc32(data) {
  return wbCrc32Final(wbCrc32Update(wbCrc32Init(), data));
}

function wbDosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const dosTime =
    (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate =
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { dosTime, dosDate };
}

function* wbZipSteps(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('ZIP 内容为空');
  }
  if (files.length > 0xffff) {
    throw new Error('ZIP 文件数超过 65535，请改用「逐个下载」');
  }
  let totalSize = 0;
  for (const f of files) {
    const len = f && f.data ? f.data.byteLength : 0;
    totalSize += len;
  }
  if (totalSize > 0xfffffff0) {
    throw new Error('ZIP 总大小超过 4GB（ZIP32 上限），请改用「逐个下载」');
  }

  const enc = new TextEncoder();
  const { dosTime, dosDate } = wbDosDateTime(new Date());
  const chunks = [];
  const centralChunks = [];
  let offset = 0;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const data = f && f.data;
    if (!(data instanceof Uint8Array)) {
      throw new Error('文件数据无效：' + (f && f.name ? f.name : '(unknown)'));
    }
    const nameBytes = enc.encode(
      String(f.name || 'file')
        .replace(/\\/g, '/')
        .split('/')
        .map((seg) => (seg === '..' || seg === '.' ? '_' : seg))
        .join('/') || 'file'
    );
    const crc = f.crc != null ? f.crc >>> 0 : wbCrc32(data);
    const size = data.byteLength;

    // ---- 本地文件头 (30 字节 + 文件名) ----
    const lh = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true); // UTF-8 文件名
    dv.setUint16(8, 0, true); // STORE
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, size, true);
    dv.setUint32(22, size, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    lh.set(nameBytes, 30);

    // ---- 中央目录项 (46 字节 + 文件名) ----
    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    ch.set(nameBytes, 46);

    chunks.push(lh, data);
    centralChunks.push(ch);
    offset += lh.length + size;

    if ((i + 1) % 16 === 0 || i === files.length - 1) {
      yield { done: i + 1, total: files.length, bytes: size, offset, totalBytes: totalSize };
    }
  }

  const cdSize = centralChunks.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length & 0xffff, true);
  ev.setUint16(10, files.length & 0xffff, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  yield {
    done: files.length,
    total: files.length,
    bytes: totalSize,
    offset,
    totalBytes: totalSize,
    packing: true,
  };

  return new Blob([...chunks, ...centralChunks, eocd], { type: 'application/zip' });
}

/** 同步打包（保留旧接口；不提供进度） */
function wbBuildZip(files) {
  const it = wbZipSteps(files);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/** 异步打包：逐文件回调进度，并定期让出主线程，避免页面看起来卡死 */
async function wbBuildZipAsync(files, onProgress) {
  const it = wbZipSteps(files);
  let lastYield = 0;
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    try {
      if (onProgress) onProgress(r.value);
    } catch (e) {
      console.warn('[WBDA] zip progress callback failed:', e);
    }
    const now = Date.now();
    if (now - lastYield >= 30) {
      lastYield = now;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
}

// 导出到全局（content.js 使用）
globalThis.wbCrc32Init = wbCrc32Init;
globalThis.wbCrc32Update = wbCrc32Update;
globalThis.wbCrc32Final = wbCrc32Final;
globalThis.wbCrc32 = wbCrc32;
globalThis.wbBuildZip = wbBuildZip;
globalThis.wbBuildZipAsync = wbBuildZipAsync;
})();
