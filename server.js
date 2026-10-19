#!/usr/bin/env node
'use strict';
/**
 * B站下载助手 —— 主程序
 *
 * 作用：让 B站 PC 客户端"右键视频 → 下载/保存"变成可能。
 *
 * 工作原理（不改你的 B站 安装目录、不要管理员权限）：
 *   1. 用一个调试端口参数启动 B站客户端（客户端本身完全不动）
 *   2. 通过 CDP 往"播放器窗口"里注入一小段脚本（右键菜单 + 进度面板）
 *   3. 注入脚本借用客户端的登录态调 playurl 接口，拿到真实视频流地址
 *   4. 本程序负责把流下载下来，必要时用客户端自带的 ffmpeg 合并音视频
 *
 * 用法：
 *   node server.js                 正常启动（客户端没开就自动带调试端口打开）
 *   node server.js --restart       先关掉正在运行的客户端再启动
 *   node server.js --status        只检查环境，不常驻
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');

const bili = require('./lib/bili');
const { CDP } = require('./lib/cdp');

// ------------------------------------------------------------------ 常量
const PORT = Number(process.env.BDL_PORT || 8765);
const CDP_PORT = Number(process.env.BDL_CDP_PORT || 9333);

const CLIENT_EXE = process.env.BDL_CLIENT_EXE || 'C:\\Program Files\\bilibili\\哔哩哔哩.exe';
const USER_DATA = path.join(process.env.APPDATA || '', 'bilibili');
const FFMPEG = path.join(USER_DATA, 'ffmpeg', 'ffmpeg.exe');
const LOG_FILE = path.join(USER_DATA, 'logs', 'main.log');
const DEFAULT_OUT_DIR =
  process.env.BDL_OUT_DIR || path.join(process.env.USERPROFILE || '.', 'Videos', 'bilibili', '下载助手');

const INJECT_FILE = path.join(__dirname, 'lib', 'inject.js');
const INJECT_BODY = fs.readFileSync(INJECT_FILE, 'utf8');
// 给注入脚本打上版本号：页面里跑的是哪个版本一目了然，
// 脚本更新后也能据此判断"这个页面需要重新注入"。
const INJECT_VERSION = require('crypto')
  .createHash('sha1')
  .update(INJECT_BODY)
  .digest('hex')
  .slice(0, 12);
const INJECT_SRC = INJECT_BODY + '\n;window.__BDL_VERSION__ = ' + JSON.stringify(INJECT_VERSION) + ';\n';

// ------------------------------------------------------------------ 配置（下载位置等）
const CONFIG_FILE = path.join(__dirname, 'config.json');
const LOG_PATH = path.join(__dirname, '日志.txt');
const config = {
  downloadDir: DEFAULT_OUT_DIR,
  // 下载完直接弹资源管理器会"切窗口"，默认关闭；完成提示在客户端里显示（小卡片）
  autoOpenFolder: false,
  autoRestoreClient: true, // 客户端被别的方式重启（没有下载端口）时，自动重启它恢复右键菜单
  concurrency: 8, // 每条流的并发连接数（B站 CDN 单连接限速，多连接能快好几倍）
};

/** 当前生效的下载目录 */
function outDir() {
  return config.downloadDir || DEFAULT_OUT_DIR;
}

function loadConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (j && typeof j.downloadDir === 'string' && j.downloadDir.trim()) {
      config.downloadDir = j.downloadDir.trim();
    }
    if (j && typeof j.autoOpenFolder === 'boolean') {
      config.autoOpenFolder = j.autoOpenFolder;
    }
    if (j && typeof j.autoRestoreClient === 'boolean') {
      config.autoRestoreClient = j.autoRestoreClient;
    }
    if (j && typeof j.concurrency === 'number' && j.concurrency >= 1) {
      config.concurrency = Math.max(1, Math.min(16, Math.round(j.concurrency)));
    }
  } catch (_) {
    // 没有配置文件就用默认值
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(
      CONFIG_FILE,
      JSON.stringify(
        {
          downloadDir: config.downloadDir,
          autoOpenFolder: config.autoOpenFolder,
          autoRestoreClient: config.autoRestoreClient,
          concurrency: config.concurrency,
        },
        null,
        2
      ),
      'utf8'
    );
    return true;
  } catch (e) {
    log('保存配置失败:', e.message);
    return false;
  }
}

/** 校验并规范化用户填的目录；不合法就抛出中文错误 */
function normalizeDir(input) {
  let p = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!p) throw new Error('路径不能为空');

  // 支持 %USERPROFILE% 这类环境变量
  p = p.replace(/%([^%]+)%/g, (m, name) => process.env[name] || m);

  const isAbs = /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p);
  if (!isAbs) throw new Error('请填完整路径，例如 D:\\B站视频');

  p = path.normalize(p).replace(/[\\/]+$/, '');
  if (!/[a-zA-Z]:\\/.test(p) && !/^\\\\/.test(p)) throw new Error('路径格式不对');

  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (e) {
    throw new Error('无法创建这个目录（' + (e.code || '未知错误') + '）：' + p);
  }

  // 真写一个文件试试，避免选了只读目录
  const probe = path.join(p, '.bdl_write_test');
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (e) {
    throw new Error('这个目录不可写：' + p);
  }

  return p;
}

/** 弹出 Windows 原生"选择文件夹"对话框，返回选中的路径（取消返回 null） */
function pickFolderDialog() {
  return new Promise((resolve) => {
    const script = path.join(__dirname, 'tools', 'pickfolder.ps1');
    if (!fs.existsSync(script)) return resolve(null);
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '选择 B 站视频的保存位置',
        'B站下载助手',
      ],
      { windowsHide: true, timeout: 5 * 60 * 1000 },
      (err, stdout) => {
        if (err) return resolve(null);
        const p = String(stdout || '').trim();
        resolve(p || null);
      }
    );
  });
}

// ------------------------------------------------------------------ 状态
const jobs = new Map(); // id -> job
const attached = new Map(); // targetId -> CDP 连接
let seq = 1;
let clientError = null;
const logState = { bvid: null, cid: null, title: '', at: 0 };

const log = (...a) => {
  const line =
    '[' + new Date().toLocaleString('zh-CN') + '] ' + a.map((x) => String(x)).join(' ');
  console.log(line);
  try {
    // 超过 512KB 就重开，避免日志无限增长
    let size = 0;
    try { size = fs.statSync(LOG_PATH).size; } catch (_) {}
    if (size > 512 * 1024) fs.writeFileSync(LOG_PATH, '');
    fs.appendFileSync(LOG_PATH, line + '\r\n');
  } catch (_) {}
};

// ------------------------------------------------------------------ 工具函数
function jsonBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 4 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try { resolve(d ? JSON.parse(d) : {}); } catch (_) { resolve({}); }
    });
  });
}

function cdpHTTP(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: CDP_PORT, path: pathname }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('CDP 无响应')));
  });
}

async function cdpAlive() {
  try {
    await cdpHTTP('/json/version');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 正在被其他任务占用的文件名。
 * 只检查"文件是否已存在"是不够的：两个任务同时下同一个标题时，文件都还不存在，
 * 会拿到同一个名字，然后互相覆盖/互删分片（实测报 ENOENT: .part0）。
 */
const reservedPaths = new Set();

/** 用于唯一文件名，避免覆盖已有文件或与其他进行中的任务撞名 */
function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  let i = 2;
  while (fs.existsSync(p) || reservedPaths.has(p.toLowerCase())) {
    p = path.join(dir, base + ' (' + i + ')' + ext);
    i++;
  }
  reservedPaths.add(p.toLowerCase());
  return p;
}

/** 任务结束时释放它占用的文件名 */
function releasePaths(paths) {
  for (const p of paths || []) {
    try { reservedPaths.delete(String(p).toLowerCase()); } catch (_) {}
  }
}

/**
 * 打开下载文件夹（可选：选中某个文件并把它所在窗口带到最前面）
 *
 * 注意两个坑（都实测过）：
 *   1. 不能用 spawn 直接 CreateProcess 调 explorer.exe —— 窗口会创建但永远在后面，
 *      用户看着就是"没反应"。
 *   2. 给 powershell 加 windowsHide:true 也会导致抢不到前台。
 * 所以统一走 tools/reveal.ps1：它负责打开窗口并强行置前。
 */
function openInExplorer(file) {
  const script = path.join(__dirname, 'tools', 'reveal.ps1');
  const hasFile = !!(file && fs.existsSync(file));
  const target = hasFile ? file : outDir();

  if (!hasFile) {
    try { fs.mkdirSync(target, { recursive: true }); } catch (_) {}
  }

  // 兜底：reveal.ps1 丢了就退回系统 shell
  if (!fs.existsSync(script)) {
    try {
      spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
      log('已打开文件夹（兜底方式）:', target);
    } catch (_) {}
    return;
  }

  const args = [
    '-NoProfile',
    '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-Path', target,
  ];
  if (hasFile) args.push('-Select');

  // 不能加 windowsHide:true，否则资源管理器窗口抢不到前台
  execFile('powershell.exe', args, { timeout: 30000 }, (err, stdout) => {
    if (err) {
      log('打开文件夹失败:', err.message);
      return;
    }
    const focused = String(stdout || '').includes('FOCUSED');
    if (hasFile) {
      log('已打开并选中:', path.basename(file), focused ? '' : '(窗口未置前)');
    } else {
      log('已打开下载文件夹:', target, focused ? '' : '(窗口未置前)');
    }
  });
}

// ------------------------------------------------------------------ 下载任务
function createJob(title) {
  const id = 'job' + seq++;
  const job = {
    id,
    title: title || '视频',
    status: 'downloading',
    received: 0,
    total: 0,
    percent: 0,
    speed: 0,
    file: null,
    error: null,
    cancelRequested: false,
    abort: bili.createAbort(), // 取消令牌：会打断所有在途请求和 ffmpeg
    temps: [], // 需要清理的临时文件
    _lastReceived: 0,
    _lastTick: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

/** 取消/失败时，把半成品和临时文件全部删掉 */
function removeJobArtifacts(job) {
  const targets = new Set();

  for (const t of job.temps || []) {
    targets.add(t);
    targets.add(t + '.part');
    for (let i = 0; i < 16; i++) targets.add(t + '.part' + i);
  }
  if (job.file) targets.add(job.file);

  let removed = 0;
  for (const f of targets) {
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        removed++;
      }
    } catch (_) {}
  }
  try {
    const tmpDir = path.join(outDir(), '.tmp');
    if (fs.existsSync(tmpDir) && fs.readdirSync(tmpDir).length === 0) fs.rmdirSync(tmpDir);
  } catch (_) {}

  return removed;
}

/** 全局速度计算 */
setInterval(() => {
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.status !== 'downloading') continue;
    const dt = (now - job._lastTick) / 1000;
    if (dt <= 0) continue;
    const delta = job.received - job._lastReceived;
    job.speed = Math.max(0, Math.round(delta / dt));
    job._lastReceived = job.received;
    job._lastTick = now;
    job.percent = job.total ? Math.min(100, (job.received / job.total) * 100) : 0;
    job.updatedAt = now;
  }
  // 清理 1 小时前的任务
  for (const [id, job] of jobs) {
    if (now - job.createdAt > 3600 * 1000) jobs.delete(id);
  }
}, 500).unref();

async function runJob(job, payload) {
  const { bvid, streams, mode } = payload;
  try {
    // 在任务开始时锁定目标目录，避免下载中途改设置导致文件散落
    const targetDir = outDir();
    job.dir = targetDir;
    fs.mkdirSync(targetDir, { recursive: true });

    const title = bili.safeName(payload.title || (await bili.fetchTitle(bvid)) || bvid);
    job.title = title;

    const video = streams.find((s) => s.kind === 'video');
    const audio = streams.find((s) => s.kind === 'audio');

    // ---- 仅音频
    if (mode === 'audio') {
      const out = uniquePath(targetDir, title, '.m4a');
      job.file = out;
      job.temps.push(out);
      await bili.download(
        audio.url,
        out,
        (p) => {
          job.received = p.received;
          job.total = p.total;
        },
        job.abort,
        config.concurrency
      );
      job.status = 'done';
      job.percent = 100;
      job.temps = [];
      log('完成（音频）:', out);
      return;
    }

    // ---- 单文件（720P 快速）
    if (mode === 'fast' && streams.length === 1) {
      const out = uniquePath(targetDir, title, '.mp4');
      job.file = out;
      job.temps.push(out);
      await bili.download(
        video.url,
        out,
        (p) => {
          job.received = p.received;
          job.total = p.total;
        },
        job.abort,
        config.concurrency
      );
      job.status = 'done';
      job.percent = 100;
      job.temps = [];
      log('完成（单文件）:', out);
      return;
    }

    // ---- DASH：两条流 + 合并
    const tmpDir = path.join(targetDir, '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const vTmp = path.join(tmpDir, job.id + '_v.m4s');
    const aTmp = path.join(tmpDir, job.id + '_a.m4s');

    // 两条流并行下载，进度按"已下字节 / 总字节"汇总
    let vBytes = 0;
    let aBytes = 0;
    let vTotal = 0;
    let aTotal = 0;
    const syncProgress = () => {
      job.received = vBytes + aBytes;
      job.total = vTotal + aTotal;
    };

    const dlVideo = bili.download(
      video.url,
      vTmp,
      (p) => {
        vBytes = p.received;
        if (p.total) vTotal = p.total;
        syncProgress();
      },
      job.abort,
      config.concurrency
    );

    const dlAudio =
      audio && audio.url
        ? bili.download(
            audio.url,
            aTmp,
            (p) => {
              aBytes = p.received;
              if (p.total) aTotal = p.total;
              syncProgress();
            },
            job.abort,
            config.concurrency
          )
        : Promise.resolve();

    job.temps.push(vTmp, aTmp);
    await Promise.all([dlVideo, dlAudio]);

    const out = uniquePath(targetDir, title, '.mp4');
    job.file = out;

    if (!audio || !audio.url) {
      // 没有音轨，直接改名
      fs.renameSync(vTmp, out);
      job.status = 'done';
      job.percent = 100;
      log('完成（无音轨）:', out);
      return;
    }

    job.status = 'merging';
    job.percent = 99;
    job.updatedAt = Date.now();

    const hasFfmpeg = fs.existsSync(FFMPEG);
    if (!hasFfmpeg) {
      // 没有 ffmpeg：保留两个文件，并给出说明
      const vOut = uniquePath(targetDir, title + '.视频', '.mp4');
      const aOut = uniquePath(targetDir, title + '.音频', '.m4a');
      fs.renameSync(vTmp, vOut);
      fs.renameSync(aTmp, aOut);
      job.status = 'error';
      job.error = '未找到客户端自带的 ffmpeg，已分别保存画面和声音两个文件';
      job.file = vOut;
      log('未找到 ffmpeg，已分别保存:', vOut, aOut);
      return;
    }

    await bili.mergeWithFfmpeg(FFMPEG, vTmp, aTmp, out, job.abort);
    try { fs.unlinkSync(vTmp); } catch (_) {}
    try { fs.unlinkSync(aTmp); } catch (_) {}
    try { fs.rmdirSync(tmpDir); } catch (_) {}

    job.status = 'done';
    job.percent = 100;
    job.temps = [];
    log('完成（已合并）:', out);
  } catch (e) {
    const cancelled = (e && e.aborted) || job.cancelRequested || (job.abort && job.abort.aborted);

    if (cancelled) {
      job.status = 'cancelled';
      job.error = null;
      const n = removeJobArtifacts(job);
      log('任务已取消，已清理 ' + n + ' 个临时文件');
    } else {
      job.status = 'error';
      job.error = String((e && e.message) || e);
      // 失败也把半成品删掉，别在下载目录里留垃圾
      try { removeJobArtifacts(job); } catch (_) {}
      log('任务失败:', job.error);
    }
  } finally {
    job.updatedAt = Date.now();

    // 任务结束，释放它占用的文件名，避免后续同名下载一直被迫加 (2)
    releasePaths([job.file].concat(job.temps || []));

    // 只有用户明确勾选了"完成后直接打开文件夹"才弹资源管理器；
    // 默认只在客户端里显示小卡片提示，避免突然切窗口打断观看。
    if (job.status === 'done' && job.file && config.autoOpenFolder) {
      setTimeout(() => openInExplorer(job.file), 400);
    }
  }
}

// ------------------------------------------------------------------ 日志兜底（读客户端日志拿当前 BV）
function tailLogOnce() {
  try {
    const st = fs.statSync(LOG_FILE);
    const size = st.size;
    const readLen = Math.min(size, 96 * 1024);
    const fd = fs.openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, size - readLen);
    fs.closeSync(fd);

    const text = buf.toString('utf8');
    const re = /Open player window:\s*(\{.*?\})\s*$/gm;
    let last = null;
    let m;
    while ((m = re.exec(text)) !== null) last = m[1];
    if (last) {
      const obj = JSON.parse(last);
      if (obj.bvid && obj.bvid !== logState.bvid) {
        logState.bvid = obj.bvid;
        logState.cid = null;
        logState.at = Date.now();
        log('从客户端日志识别到视频:', obj.bvid);
      }
    }
  } catch (_) {}
}

// 补齐 cid / 标题
async function enrichLogState() {
  if (!logState.bvid || logState.cid) return;
  try {
    const j = await bili.getJSON('https://api.bilibili.com/x/web-interface/view?bvid=' + logState.bvid);
    if (j && j.code === 0 && j.data) {
      logState.cid = String(j.data.cid);
      logState.title = j.data.title || '';
    }
  } catch (_) {}
}

// ------------------------------------------------------------------ CDP 注入
async function attachTarget(target) {
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // 之后每次页面加载都自动注入（记住 identifier，更新脚本时要先摘掉旧的，
  // 否则重载后会同时跑新旧两个脚本）
  const reg = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT_SRC });
  cdp.scriptId = reg && reg.identifier;
  // 当前已经加载好的页面，立刻注入一次
  await cdp.evaluate(INJECT_SRC).catch(() => {});
  attached.set(target.id, cdp);
  log('已注入页面:', target.url.slice(0, 60));
  return cdp;
}

async function watchTargets() {
  if (!(await cdpAlive())) return;
  let list;
  try {
    list = await cdpHTTP('/json/list');
  } catch (_) {
    return;
  }
  // 注入范围：客户端所有页面。
  // 早期版本只注入 player.html，但客户端改版后部分视频会在
  // index.html#/page/ugc-season?cid=…&bvid=… 这类页面里播放，只认 player.html 会漏掉。
  // 注入脚本自己会判断"页面里有没有 <video>"，没有就不接管右键。
  const players = list.filter(
    (t) =>
      t.type === 'page' &&
      typeof t.url === 'string' &&
      /^https?:\/\/bilipc\.bilibili\.com\//.test(t.url) &&
      t.webSocketDebuggerUrl
  );

  for (const t of players) {
    const old = attached.get(t.id);
    if (old && !old.closed) {
      // 健康检查：① 注入是否还活着；② 版本是不是最新的。
      // 只看 "已注入" 不够——脚本更新后旧实例还活着，会出现"修好了但页面还在报旧错"。
      try {
        const alive = await old.evaluate('!!window.__BDL_INSTALLED__', 4000);
        if (!alive) {
          await old.evaluate(INJECT_SRC).catch(() => {});
        } else {
          const ver = await old.evaluate('window.__BDL_VERSION__ || ""', 4000);
          if (ver !== INJECT_VERSION) {
            // 先把"下次加载要跑的脚本"换成新版（旧的要摘掉，否则会同时注入两份）
            try {
              if (old.scriptId) {
                await old
                  .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: old.scriptId })
                  .catch(() => {});
              }
              const reg = await old.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT_SRC });
              old.scriptId = reg && reg.identifier;
            } catch (_) {}

            // 新脚本开头会调 __BDL_TEARDOWN__ 把旧实例拆掉；
            // 但如果页面里是"还没有自毁入口"的老版本，只能靠重载页面清理。
            const canTeardown = await old
              .evaluate('typeof window.__BDL_TEARDOWN__ === "function"', 3000)
              .catch(() => false);

            if (canTeardown) {
              await old.evaluate(INJECT_SRC).catch(() => {});
            } else {
              log('页面里是旧版注入（无自毁入口），重载页面以清理：' + t.url.slice(0, 50));
              await old.send('Page.reload', {}).catch(() => {});
            }
            log('注入脚本已更新到 ' + INJECT_VERSION + '：' + t.url.slice(0, 50));
          }
        }
      } catch (_) {
        attached.delete(t.id);
      }
      continue;
    }
    try {
      await attachTarget(t);
    } catch (_) {
      attached.delete(t.id);
    }
  }

  // 清理已消失的 target
  const ids = new Set(players.map((p) => p.id));
  for (const [id, cdp] of attached) {
    if (!ids.has(id)) {
      cdp.close();
      attached.delete(id);
    }
  }
}

// ------------------------------------------------------------------ 启动/重启客户端
function spawnClientWithCDP() {
  const env = Object.assign({}, process.env);
  // ★ 关键：这两个变量会让 Electron 退化成 Node 解释器，必须去掉
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;

  const child = spawn(CLIENT_EXE, ['--remote-debugging-port=' + CDP_PORT], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env,
  });
  child.unref();
  return child.pid;
}

function killClient() {
  return new Promise((resolve) => {
    execFile('taskkill', ['/IM', '哔哩哔哩.exe', '/F'], { windowsHide: true }, () => resolve());
  });
}

async function ensureClient(opts = {}) {
  if (await cdpAlive()) {
    log('客户端已在运行（下载功能可用）');
    return true;
  }

  if (opts.restart) {
    log('正在关闭正在运行的 B站客户端…');
    await killClient();
    await new Promise((r) => setTimeout(r, 2500));
  }

  log('正在启动 B站客户端（带下载功能）…');
  try {
    spawnClientWithCDP();
  } catch (e) {
    clientError = '启动客户端失败：' + e.message;
    return false;
  }

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 700));
    if (await cdpAlive()) {
      log('客户端已就绪，下载功能已启用');
      return true;
    }
  }

  clientError =
    '客户端没有以"可下载模式"启动。\n' +
    '原因通常是：B站客户端已经在运行（它只允许一个实例）。\n' +
    '解决：先完全退出 B站客户端，再用本工具启动；或运行 启动下载助手.bat 并选择"重启客户端"。';
  return false;
}

// ------------------------------------------------------------------ 看门狗：保证右键菜单一直有效
const CLIENT_PORT = 22331; // 客户端自身的内置服务端口，用来判断"它是否在跑"
const dog = { hadCdp: false, lastTry: 0, tries: 0, warned: false, graceUntil: 0 };

/** 探测本机端口是否在监听 */
function portOpen(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    s.connect(port, '127.0.0.1');
  });
}

async function watchdog() {
  const cdp = await cdpAlive();

  if (cdp) {
    if (!dog.hadCdp) log('看门狗：下载端口正常，右键菜单可用');
    dog.hadCdp = true;
    dog.tries = 0;
    dog.warned = false;
    return;
  }

  // 端口没了 —— 先看客户端还在不在
  const running = await portOpen(CLIENT_PORT);
  if (!running) {
    if (dog.hadCdp) log('看门狗：客户端已退出（下次打开客户端时会自动接管）');
    dog.hadCdp = false;
    return;
  }

  // 客户端在跑，但没有下载端口 → 它不是我们启动的（比如点了原来的桌面图标）
  if (!config.autoRestoreClient) {
    if (!dog.warned) {
      log('看门狗：客户端在运行但缺少下载端口，右键菜单不可用（"自动恢复"已关闭）');
      dog.warned = true;
    }
    return;
  }

  const now = Date.now();
  // 从没成功过的话先给一点宽限，避免刚启动就去关用户的客户端
  if (!dog.hadCdp && now < dog.graceUntil) return;
  if (now - dog.lastTry < 6000) return;
  if (dog.tries >= 5) {
    if (!dog.warned) {
      log('看门狗：连续 5 次自动恢复失败，已停止尝试。请手动退出 B站 客户端后重新双击 启动下载助手.bat');
      dog.warned = true;
    }
    return;
  }

  dog.lastTry = now;
  dog.tries++;
  dog.hadCdp = false;
  log('看门狗：客户端缺少下载端口，正在自动重启它以恢复右键菜单（第 ' + dog.tries + ' 次）…');

  await killClient();
  await new Promise((r) => setTimeout(r, 2500));
  try {
    spawnClientWithCDP();
  } catch (e) {
    log('看门狗：重启客户端失败 ' + e.message);
  }
}

// ------------------------------------------------------------------ HTTP 服务
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;

  const sendJSON = (obj, code = 200) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  };

  try {
    if (p === '/api/health') {
      return sendJSON({
        ok: true,
        port: PORT,
        cdp: await cdpAlive(),
        ffmpeg: fs.existsSync(FFMPEG),
        outDir: outDir(),
        defaultDir: DEFAULT_OUT_DIR,
        autoRestoreClient: config.autoRestoreClient,
        clientError,
        attached: attached.size,
        watchdog: { hadCdp: dog.hadCdp, tries: dog.tries },
      });
    }

    // ---- 读取当前配置
    if (p === '/api/config' && req.method === 'GET') {
      return sendJSON({
        downloadDir: outDir(),
        defaultDir: DEFAULT_OUT_DIR,
        autoOpenFolder: config.autoOpenFolder,
        autoRestoreClient: config.autoRestoreClient,
        concurrency: config.concurrency,
        exists: fs.existsSync(outDir()),
      });
    }

    // ---- 修改配置（下载位置 / 自动打开文件夹 / 自动恢复客户端）
    if (p === '/api/config' && req.method === 'POST') {
      const body = await jsonBody(req);

      if (typeof body.autoOpenFolder === 'boolean') {
        config.autoOpenFolder = body.autoOpenFolder;
      }
      if (typeof body.autoRestoreClient === 'boolean') {
        config.autoRestoreClient = body.autoRestoreClient;
        if (config.autoRestoreClient) dog.tries = 0, dog.warned = false;
      }

      // 允许只改开关、不改路径
      if (body.downloadDir !== undefined) {
        try {
          config.downloadDir = normalizeDir(body.downloadDir);
        } catch (e) {
          return sendJSON(
            {
              ok: false,
              error: String(e.message || e),
              downloadDir: outDir(),
              autoOpenFolder: config.autoOpenFolder,
              autoRestoreClient: config.autoRestoreClient,
            },
            400
          );
        }
      }

      saveConfig();
      log('配置已保存：目录=' + outDir() + '，完成自动打开=' + config.autoOpenFolder);
      return sendJSON({
        ok: true,
        downloadDir: outDir(),
        autoOpenFolder: config.autoOpenFolder,
      autoRestoreClient: config.autoRestoreClient,
      });
    }

    // ---- 弹原生"选择文件夹"对话框
    if (p === '/api/pick-folder' && req.method === 'POST') {
      const chosen = await pickFolderDialog();
      if (!chosen) return sendJSON({ ok: false, cancelled: true, downloadDir: outDir() });
      try {
        config.downloadDir = normalizeDir(chosen);
        saveConfig();
        log('下载位置已改为:', config.downloadDir);
        return sendJSON({
          ok: true,
          downloadDir: config.downloadDir,
          autoOpenFolder: config.autoOpenFolder,
        autoRestoreClient: config.autoRestoreClient,
        });
      } catch (e) {
        return sendJSON({ ok: false, error: String(e.message || e) }, 400);
      }
    }

    // ---- 恢复默认下载位置
    if (p === '/api/config/reset' && req.method === 'POST') {
      config.downloadDir = DEFAULT_OUT_DIR;
      saveConfig();
      log('下载位置已恢复默认:', DEFAULT_OUT_DIR);
      return sendJSON({
        ok: true,
        downloadDir: DEFAULT_OUT_DIR,
        autoOpenFolder: config.autoOpenFolder,
      autoRestoreClient: config.autoRestoreClient,
      });
    }

    if (p === '/api/state') {
      await enrichLogState();
      return sendJSON({
        bvid: logState.bvid,
        cid: logState.cid,
        title: logState.title,
      });
    }

    if (p === '/api/download' && req.method === 'POST') {
      const body = await jsonBody(req);
      if (!body.bvid || !Array.isArray(body.streams) || !body.streams.length) {
        return sendJSON({ error: '参数不完整：缺少 bvid 或 streams' }, 400);
      }
      const job = createJob(body.title);
      job.cid = body.cid;
      job.mode = body.mode;
      runJob(job, body); // 不 await，后台跑
      return sendJSON({ id: job.id });
    }

    if (p === '/api/cancel' && req.method === 'POST') {
      const body = await jsonBody(req);
      const job = jobs.get(body.id);
      if (!job) return sendJSON({ ok: false, error: '任务不存在' }, 404);
      if (job.status === 'done' || job.status === 'cancelled') {
        return sendJSON({ ok: false, error: '任务已经结束了' });
      }
      job.cancelRequested = true;
      job.status = 'cancelling';
      job.updatedAt = Date.now();
      try { job.abort.abort(); } catch (_) {}
      log('收到取消请求:', job.id);
      return sendJSON({ ok: true });
    }

    if (p === '/api/progress') {
      const id = u.searchParams.get('id');
      const job = jobs.get(id);
      if (!job) return sendJSON({ error: '任务不存在' }, 404);
      return sendJSON({
        id: job.id,
        status: job.status,
        percent: job.percent,
        received: job.received,
        total: job.total,
        speed: job.speed,
        file: job.file,
        error: job.error,
        title: job.title,
      });
    }

    if (p === '/api/openfolder' && req.method === 'POST') {
      const body = await jsonBody(req);
      openInExplorer(body.file || null);
      return sendJSON({ ok: true });
    }

    if (p === '/api/jobs') {
      return sendJSON([...jobs.values()].map((j) => ({
        id: j.id, title: j.title, status: j.status, percent: j.percent, file: j.file,
      })));
    }

    // 首页给个简单的状态页，方便排查
    if (p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<meta charset="utf-8"><body style="font:14px/1.8 sans-serif;padding:24px">' +
        '<h2>B站下载助手 正在运行</h2>' +
        '<p>下载目录：<code>' + outDir() + '</code></p>' +
        '<p>接口：<a href="/api/health">/api/health</a> · <a href="/api/state">/api/state</a> · <a href="/api/config">/api/config</a></p>' +
        '</body>'
      );
      return;
    }

    sendJSON({ error: 'not found' }, 404);
  } catch (e) {
    sendJSON({ error: String(e.message || e) }, 500);
  }
});

// ------------------------------------------------------------------ 主流程
async function main() {
  const args = process.argv.slice(2);
  const wantRestart = args.includes('--restart');
  const statusOnly = args.includes('--status');
  const noLaunch = args.includes('--no-launch');

  log('B站下载助手启动中…' + (noLaunch ? '（后台模式）' : ''));
  loadConfig();
  log('下载目录:', outDir());

  let ok = true;
  if (noLaunch) {
    // 后台常驻模式：不去主动打开 B站 客户端，只等它出现后接管
    log('后台模式：不会自动打开 B站 客户端，只在它启动时接管');
    ok = await cdpAlive();
  } else {
    ok = await ensureClient({ restart: wantRestart });
  }

  if (statusOnly) {
    console.log('\n---- 环境检查 ----');
    console.log('客户端 CDP 端口 :', (await cdpAlive()) ? '正常 (' + CDP_PORT + ')' : '不可用');
    console.log('自带 ffmpeg    :', fs.existsSync(FFMPEG) ? '已找到' : '未找到');
    console.log('下载目录        :', outDir());
    if (clientError) console.log('问题            :', clientError);
    process.exit(ok ? 0 : 1);
  }

  if (!ok && !noLaunch) {
    console.error('\n' + clientError + '\n');
    log('下载服务仍会启动，但右键菜单要等客户端以"可下载模式"启动后才生效。');
  }

  server.listen(PORT, '127.0.0.1', () => {
    log('本地服务已就绪: http://127.0.0.1:' + PORT);
    log('现在到 B站客户端里播放视频，右键试试 ←');
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error('\n端口 ' + PORT + ' 已被占用，可能本工具已经在运行了。');
      console.error('可以在托盘/任务管理器里结束 node.exe，或设置 BDL_PORT 换端口。\n');
      process.exit(1);
    }
    console.error('服务启动失败:', e.message);
    process.exit(1);
  });

  // 定时任务：注入守护 + 日志兜底 + 看门狗
  dog.graceUntil = Date.now() + 10000;
  setInterval(() => watchTargets().catch(() => {}), 2000).unref();
  setInterval(() => tailLogOnce(), 3000).unref();
  setInterval(() => watchdog().catch(() => {}), 2000).unref();
  watchTargets().catch(() => {});
  tailLogOnce();
  watchdog().catch(() => {});
}

process.on('SIGINT', () => {
  log('已退出');
  process.exit(0);
});

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
