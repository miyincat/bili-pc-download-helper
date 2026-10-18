'use strict';
/**
 * bili.js —— B 站视频下载核心
 *
 * 关键事实（实测得出）：
 *   1. 视频流 CDN 有防盗链，必须带 Referer: https://www.bilibili.com/
 *   2. 720P 可以拿到"单文件 MP4"（自带音轨），不需要合并
 *   3. 1080P+ 只能拿到 DASH（画面、声音两条流），必须用 ffmpeg 合并
 *   4. 客户端自带的 ffmpeg.exe 可以直接复用，无需下载
 *   5. ★ B站 CDN 会限制"单条连接"的速率（实测约 8Mbps），
 *      开多连接分片（Range）能跑到 3~4 倍，所以默认走多连接下载
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'bilibili/1.19.0 Chrome/108.0.5359.215 Electron/22.3.27 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

/** 文件名里不能出现的字符，统一替换掉 */
function safeName(s) {
  return String(s || '视频')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || '视频';
}

// ------------------------------------------------------------------ 取消支持
/**
 * 创建一个"可取消"的令牌。
 * job 侧调用 abort() 即可打断所有在途请求。
 */
function createAbort() {
  const token = {
    aborted: false,
    reqs: new Set(),
    children: new Set(),
    onAbort: [],
    abort() {
      if (token.aborted) return;
      token.aborted = true;
      for (const r of token.reqs) {
        try { r.destroy(new Error('已取消')); } catch (_) {}
      }
      token.reqs.clear();
      for (const c of token.children) {
        try { c.kill(); } catch (_) {}
      }
      token.children.clear();
      for (const fn of token.onAbort) {
        try { fn(); } catch (_) {}
      }
    },
    track(req) {
      if (token.aborted) {
        try { req.destroy(new Error('已取消')); } catch (_) {}
        return;
      }
      token.reqs.add(req);
      req.on('close', () => token.reqs.delete(req));
    },
  };
  return token;
}

function abortedError() {
  const e = new Error('已取消');
  e.aborted = true;
  return e;
}

/**
 * 发起 GET 请求，自动跟随重定向，返回响应流
 * @returns {Promise<{res: http.IncomingMessage, req: http.ClientRequest, url: string}>}
 */
function getStream(url, extraHeaders, abort, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (abort && abort.aborted) return reject(abortedError());
    if (redirects > 5) return reject(new Error('重定向次数过多'));

    const client = url.startsWith('http:') ? http : https;
    const req = client.get(
      url,
      { headers: Object.assign({}, HEADERS, extraHeaders || {}) },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          resolve(getStream(next, extraHeaders, abort, redirects + 1));
          return;
        }
        if (code !== 200 && code !== 206) {
          res.resume();
          reject(new Error('HTTP ' + code + '：' + url.slice(0, 120)));
          return;
        }
        resolve({ res, req, url });
      }
    );

    if (abort) abort.track(req);
    req.on('error', (e) => reject(abort && abort.aborted ? abortedError() : e));
    req.setTimeout(30000, () => req.destroy(new Error('连接超时')));
  });
}

/** 取 JSON 接口 */
function getJSON(url) {
  return new Promise(async (resolve, reject) => {
    try {
      const { res } = await getStream(url);
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(new Error('接口返回不是 JSON')); }
      });
      res.on('error', reject);
    } catch (e) { reject(e); }
  });
}

// ------------------------------------------------------------------ 单连接下载
/**
 * 单连接下载（也作为多连接不可用时的回退）
 */
async function downloadSingle(url, dest, onProgress, abort) {
  const { res } = await getStream(url, null, abort);
  const total = parseInt(res.headers['content-length'] || '0', 10);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);

  let received = 0;
  let lastTick = 0;

  await new Promise((resolve, reject) => {
    res.on('data', (chunk) => {
      received += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastTick > 150) {
        lastTick = now;
        onProgress({ received, total, percent: total ? Math.min(100, (received / total) * 100) : 0 });
      }
    });
    res.on('error', (e) => reject(abort && abort.aborted ? abortedError() : e));
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });

  if (abort && abort.aborted) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw abortedError();
  }
  if (total && received !== total) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw new Error('下载不完整：' + received + '/' + total + ' 字节');
  }

  fs.renameSync(tmp, dest);
  if (onProgress) onProgress({ received, total, percent: 100 });
  return { bytes: received };
}

// ------------------------------------------------------------------ 多连接下载
/** 探测文件总大小 & 是否支持 Range */
async function probeSize(url, abort) {
  try {
    const { res } = await getStream(url, { Range: 'bytes=0-0' }, abort);
    const cr = res.headers['content-range'] || '';
    const len = parseInt(res.headers['content-length'] || '0', 10);
    res.resume();
    const m = /\/(\d+)\s*$/.exec(cr);
    if (m) return { size: Number(m[1]), ranged: res.statusCode === 206 };
    return { size: len, ranged: false };
  } catch (_) {
    return { size: 0, ranged: false };
  }
}

/**
 * 多连接分片下载：把文件按字节切成 N 段并行拉，最后按顺序拼接。
 * 对 B站 CDN 这种"单连接限速"的场景提升非常明显。
 */
async function downloadParallel(url, dest, onProgress, abort, concurrency) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const { size, ranged } = await probeSize(url, abort);
  const N = Math.max(1, Math.min(16, concurrency || 8));

  // 太小、不支持 Range、或探测失败 → 走单连接
  if (!ranged || !size || size < 2 * 1024 * 1024) {
    return downloadSingle(url, dest, onProgress, abort);
  }

  const chunk = Math.ceil(size / N);
  const parts = [];
  for (let i = 0; i < N; i++) {
    const from = i * chunk;
    const to = Math.min(size - 1, from + chunk - 1);
    if (from > to) break;
    parts.push({ index: i, from, to, file: dest + '.part' + i, got: 0 });
  }

  let received = 0;
  let lastTick = 0;
  const report = () => {
    const now = Date.now();
    if (!onProgress || now - lastTick < 150) return;
    lastTick = now;
    onProgress({ received, total: size, percent: Math.min(100, (received / size) * 100) });
  };

  // 单个分片
  const fetchPart = (p) =>
    new Promise(async (resolve, reject) => {
      try {
        const { res } = await getStream(url, { Range: 'bytes=' + p.from + '-' + p.to }, abort);
        const out = fs.createWriteStream(p.file);
        res.on('data', (c) => {
          p.got += c.length;
          received += c.length;
          report();
        });
        res.on('error', (e) => {
          out.destroy();
          reject(abort && abort.aborted ? abortedError() : e);
        });
        out.on('error', reject);
        out.on('finish', () => {
          if (p.got !== p.to - p.from + 1) {
            reject(new Error('分片 ' + p.index + ' 不完整'));
            return;
          }
          resolve();
        });
        res.pipe(out);
      } catch (e) {
        reject(e);
      }
    });

  try {
    await Promise.all(parts.map(fetchPart));
  } catch (e) {
    // 失败/取消：清掉所有分片
    for (const p of parts) {
      try { fs.unlinkSync(p.file); } catch (_) {}
    }
    throw abort && abort.aborted ? abortedError() : e;
  }

  if (abort && abort.aborted) {
    for (const p of parts) { try { fs.unlinkSync(p.file); } catch (_) {} }
    throw abortedError();
  }

  // 按顺序拼成一个文件（流式，不占内存）
  const tmp = dest + '.part';
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    out.on('error', reject);
    out.on('finish', resolve);
    (async () => {
      try {
        for (const p of parts) {
          await new Promise((ok, bad) => {
            const rs = fs.createReadStream(p.file);
            rs.on('error', bad);
            rs.on('end', ok);
            rs.pipe(out, { end: false });
          });
        }
        out.end();
      } catch (e) {
        reject(e);
      }
    })();
  });

  for (const p of parts) { try { fs.unlinkSync(p.file); } catch (_) {} }
  fs.renameSync(tmp, dest);
  if (onProgress) onProgress({ received: size, total: size, percent: 100 });
  return { bytes: size, connections: parts.length };
}

/** 统一入口：优先多连接，不行就单连接 */
function download(url, dest, onProgress, abort, concurrency) {
  return downloadParallel(url, dest, onProgress, abort, concurrency);
}

/** 用 ffmpeg 把画面流和声音流合并成一个 mp4（可取消） */
function mergeWithFfmpeg(ffmpegPath, videoFile, audioFile, outFile, abort) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', videoFile,
      '-i', audioFile,
      '-c', 'copy',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-movflags', '+faststart',
      outFile,
    ];
    const child = execFile(
      ffmpegPath,
      args,
      { windowsHide: true, timeout: 10 * 60 * 1000 },
      (err, stdout, stderr) => {
        if (abort && abort.aborted) return reject(abortedError());
        if (err) {
          reject(new Error('ffmpeg 合并失败: ' + String(stderr || err.message).split('\n').slice(-3).join(' ')));
          return;
        }
        resolve();
      }
    );
    if (abort) abort.children.add(child);
    child.on('exit', () => { if (abort) abort.children.delete(child); });
  });
}

/** 查询视频标题（不需要登录） */
async function fetchTitle(bvid) {
  try {
    const j = await getJSON('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid));
    if (j && j.code === 0 && j.data) return j.data.title || '';
  } catch (_) {}
  return '';
}

/** 把可读的清晰度 ID 换成中文标签 */
function qualityLabel(qn) {
  const map = {
    120: '8K',
    116: '4K HDR',
    112: '4K',
    80: '1080P 高码率',
    74: '1080P 60帧',
    64: '720P',
    32: '480P',
    16: '360P',
  };
  return map[qn] || (qn ? qn + 'P' : '未知画质');
}

module.exports = {
  UA,
  HEADERS,
  safeName,
  getJSON,
  createAbort,
  download,
  downloadSingle,
  downloadParallel,
  mergeWithFfmpeg,
  fetchTitle,
  qualityLabel,
};
