/* eslint-disable */
/**
 * inject.js —— 注入到 B 站客户端"播放器窗口"里的脚本
 *
 * 职责：
 *   1. 判断"此刻正在播放的是哪个视频"（靠 m4s 实际请求投票，而不是"最后一次接口调用"，避免预加载干扰）
 *   2. 接管右键，弹出下载菜单
 *   3. 借用客户端登录态调用 playurl 接口，拿到真实可下载的流地址
 *   4. 把流地址交给本地下载服务，并显示进度
 *
 * 本文件会被 server.js 原样注入，必须自执行、无外部依赖、可重复注入安全。
 * 注意：不劫持 window.fetch / XHR（那会干扰客户端自身的代码），
 *      只读 performance 资源条目，零副作用。
 */
(function () {
  'use strict';

  // 重新注入时（脚本更新了），先把上一个实例彻底拆掉。
  // 否则旧脚本的右键监听器还活着，会和新版本同时响应，
  // 表现为"明明修好了，页面里还是报旧错误"。
  try {
    if (typeof window.__BDL_TEARDOWN__ === 'function') window.__BDL_TEARDOWN__();
  } catch (e) {}

  var API = 'http://127.0.0.1:8765';

  // 需要随实例一起销毁的监听器
  var disposers = [];
  function on(target, type, fn, opts) {
    if (!target) return;
    target.addEventListener(type, fn, opts);
    disposers.push(function () {
      try { target.removeEventListener(type, fn, opts); } catch (e) {}
    });
  }

  window.__BDL_INSTALLED__ = true;

  var st = {
    bvid: null,
    cid: null,
    menuEl: null,
    menuXY: null,
    panelEl: null,
    polling: null,
    hydrated: false,
    downloadDir: '',
    currentJobId: null,
    voteBvid: null,
    voteCid: null,
    recentPairs: [],
  };

  // 资源条目缓存太小会把早期请求丢掉，先调大
  try {
    if (performance.setResourceTimingBufferSize) performance.setResourceTimingBufferSize(2000);
  } catch (e) {}

  // ---------------------------------------------------------------- 实时记录
  // 信息流页面（index.html#/page/selected）的 URL 里没有 bvid/cid，DOM 里也没有链接，
  // 而 playurl 记录很快就会被成百上千条分片请求挤出性能缓冲区。
  // 所以从脚本一启动就用 PerformanceObserver 把 bvid↔cid 的对应关系自己记下来。
  var livePairs = []; // [{ bvid, cid, at }] 新的在前
  var liveSeg = {};   // cid -> { n, at }
  var liveAids = [];  // [{ aid, cid, at }] 信息流页面只有 avid（没有 bvid）

  function noteResource(name, startTime) {
    if (!name) return;
    var ts = startTime || 0;

    if (name.indexOf('playurl') >= 0) {
      var mb = /[?&]bvid=(BV[0-9A-Za-z]{10})/.exec(name);
      var mc = /[?&]cid=(\d+)/.exec(name);
      // 信息流页面用的是 playurl?avid=…&cid=…（没有 bvid），也要记下来
      var ma = /[?&]avid=(\d+)/.exec(name);
      if (ma && mc) {
        for (var ai = liveAids.length - 1; ai >= 0; ai--) {
          if (liveAids[ai].cid === mc[1]) liveAids.splice(ai, 1);
        }
        liveAids.unshift({ aid: ma[1], cid: mc[1], at: ts });
        if (liveAids.length > 10) liveAids.length = 10;
      }
      if (mb && mc) {
        // 同一个 cid 只保留最新一条
        for (var i = livePairs.length - 1; i >= 0; i--) {
          if (livePairs[i].cid === mc[1]) livePairs.splice(i, 1);
        }
        livePairs.unshift({ bvid: mb[1], cid: mc[1], at: ts });
        if (livePairs.length > 12) livePairs.length = 12;
      }
    }

    var seg = /upgcxcode\/[^?]*?\/(\d+)\//.exec(name);
    if (seg) {
      var c = seg[1];
      if (!liveSeg[c]) liveSeg[c] = { n: 0, at: 0 };
      liveSeg[c].n++;
      if (ts > liveSeg[c].at) liveSeg[c].at = ts;
    }
  }

  try {
    if (window.PerformanceObserver) {
      var po = new PerformanceObserver(function (list) {
        var items = list.getEntries();
        for (var i = 0; i < items.length; i++) noteResource(items[i].name, items[i].startTime);
      });
      po.observe({ type: 'resource', buffered: true });
      if (typeof po.takeRecords === 'function') {
        var buffered = po.takeRecords();
        for (var bi = 0; bi < buffered.length; bi++) noteResource(buffered[bi].name, buffered[bi].startTime);
      }
    }
  } catch (e) {}

  // ---------------------------------------------------------------- 判定当前视频
  var pairs = {};        // cid -> bvid（只能来自同一条 playurl 请求，避免拼错）
  var lastPlayurlTs = -1;

  /**
   * 从当前页面 URL 里直接读 bvid / cid。
   *
   * 这是"这个页面在放哪个视频"最权威的来源：
   *   player.html?type=ugc&aid=…&cid=…&bvid=BV…
   *   index.html#/page/ugc-season?cid=…&bvid=BV…
   * 比"猜网络请求"可靠得多，尤其是在快速切换视频的时候。
   */
  function pagePair() {
    function pick(qs) {
      if (!qs) return null;
      var b = qs.get('bvid');
      var c = qs.get('cid');
      if (b && /^BV[0-9A-Za-z]{10}$/.test(b) && c && /^\d+$/.test(c)) {
        return { bvid: b, cid: c };
      }
      return null;
    }
    try {
      var a = pick(new URLSearchParams(location.search || ''));
      if (a) return a;
      var hash = location.hash || '';
      var qi = hash.indexOf('?');
      if (qi >= 0) {
        var b2 = pick(new URLSearchParams(hash.slice(qi + 1)));
        if (b2) return b2;
      }
    } catch (e) {}
    return null;
  }

  /**
   * 页面上真正在播的那个 video。
   *
   * 信息流页面会同时挂好几个 <video>（后面的视频已预加载），
   * 所以"可见面积"不够，必须让**正在播放（未暂停）**的元素占绝对权重，
   * 否则会拿到一个预加载的、时长完全不同的视频。
   */
  function mainVideo() {
    var vs = document.querySelectorAll('video');
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < vs.length; i++) {
      var v = vs[i];
      var r = v.getBoundingClientRect();
      var visW = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
      var visH = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
      var area = visW * visH;
      if (area <= 0) continue;
      var score = area * (v.paused ? 1 : 10);
      if (isFinite(v.duration) && v.duration > 0) score *= 1.1;
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best || vs[0] || null;
  }

  function scanEntries() {
    var entries;
    try {
      entries = performance.getEntriesByType('resource') || [];
    } catch (e) {
      return [];
    }
    return entries;
  }

  /**
   * 刷新"当前播放"判定。返回是否拿到了 bvid+cid。
   * 思路：
   *   a) 从 playurl 请求里收集 cid -> bvid 的对应关系（两者来自同一个 URL，天然成对）
   *   b) 统计最近的 m4s 分片请求，出现次数最多的 cid 就是"正在播的那个"
   *      （预加载别的视频顶多一两次，正在播放的会持续拉分片）
   */
  function refreshCurrent() {
    var entries = scanEntries();
    if (!entries.length) return !!(st.bvid && st.cid);

    // a) 收集对应关系
    for (var i = 0; i < entries.length; i++) {
      var n = entries[i].name || '';
      if (n.indexOf('playurl') < 0) continue;
      var mb = /[?&]bvid=(BV[0-9A-Za-z]{10})/.exec(n);
      var mc = /[?&]cid=(\d+)/.exec(n);
      if (!mb || !mc) continue;
      pairs[mc[1]] = mb[1];
      var ts = entries[i].startTime || 0;
      if (ts >= lastPlayurlTs) {
        lastPlayurlTs = ts;
        // 先记成"最近一次"，后面会被投票结果覆盖
        st.lastBvid = mb[1];
        st.lastCid = mc[1];
      }
    }

    // b) 投票：只看"最近 15 秒内"的分片请求。
    //    用时间窗而不是"最近 N 条"，否则刚切换视频时，上一个视频残留的大量分片
    //    请求会盖过新视频（实测会下错视频）。
    var nowTs = (typeof performance.now === 'function') ? performance.now() : 0;
    var recent = entries.filter(function (e) {
      return nowTs && (e.startTime || 0) >= nowTs - 15000;
    });
    if (!recent.length) recent = entries.slice(-40);

    var votes = {};
    var bestCid = null;
    var bestN = 0;
    for (var k = 0; k < recent.length; k++) {
      var nm = recent[k].name || '';
      if (nm.indexOf('upgcxcode') < 0) continue;
      var m2 = /upgcxcode\/\d+\/\d+\/(\d+)\//.exec(nm);
      if (!m2) continue;
      var cid = m2[1];
      votes[cid] = (votes[cid] || 0) + 1;
      if (votes[cid] > bestN) {
        bestN = votes[cid];
        bestCid = cid;
      }
    }

    // 实时分片统计（PerformanceObserver 记的，比翻缓冲区可靠）覆盖上面的投票
    var nowLive = (typeof performance.now === 'function') ? performance.now() : 0;
    var bestLiveN = 0;
    for (var ck in liveSeg) {
      if (!Object.prototype.hasOwnProperty.call(liveSeg, ck)) continue;
      var sN = liveSeg[ck];
      if (nowLive && sN.at && nowLive - sN.at > 15000) continue;
      if (sN.n > bestLiveN) {
        bestLiveN = sN.n;
        bestCid = ck;
      }
    }

    var own = pagePair();

    // 优先级：页面 URL 最可靠（它就是"这个播放页在放哪个视频"）。
    // 分片投票只作兜底——客户端会预加载推荐视频的分片，实测投票会被带偏，
    // 之前就出现过 URL 是 A、却按投票去下了 B 的情况。
    // 记下最近若干条 playurl 请求：信息流页面（#/page/selected）URL 里没有 bvid/cid，
    // DOM 里也没有链接，只能靠这些请求当候选，再用播放器时长挑出正确的那个。
    if (livePairs.length) {
      st.recentPairs = livePairs.slice(0, 10).map(function (p) { return { bvid: p.bvid, cid: p.cid }; });
      for (var lp = 0; lp < livePairs.length; lp++) pairs[livePairs[lp].cid] = livePairs[lp].bvid;
    }
    try {
      var byTs = entries.slice().sort(function (a, b) {
        return (b.startTime || 0) - (a.startTime || 0);
      });
      var seenCid = {};
      var recentPairs = [];
      for (var q = 0; q < byTs.length && recentPairs.length < 10; q++) {
        var nq = byTs[q].name || '';
        if (nq.indexOf('playurl') < 0) continue;
        var mbq = /[?&]bvid=(BV[0-9A-Za-z]{10})/.exec(nq);
        var mcq = /[?&]cid=(\d+)/.exec(nq);
        if (!mbq || !mcq) continue;
        if (seenCid[mcq[1]]) continue;
        seenCid[mcq[1]] = 1;
        recentPairs.push({ bvid: mbq[1], cid: mcq[1] });
      }
      if (recentPairs.length) st.recentPairs = recentPairs;
    } catch (e) {}

    // 顺带记下投票结果，下载时作为"另一个独立来源"参与候选
    if (bestCid && pairs[bestCid]) {
      st.voteBvid = pairs[bestCid];
      st.voteCid = bestCid;
    }

    if (own) {
      st.bvid = own.bvid;
      st.cid = own.cid;
    } else if (bestCid && pairs[bestCid]) {
      st.bvid = pairs[bestCid];
      st.cid = bestCid;
    } else if (st.lastBvid && st.lastCid) {
      st.bvid = st.lastBvid;
      st.cid = st.lastCid;
    }

    return !!(st.bvid && st.cid);
  }

  /** 页面里实在判断不出来时，问本地服务（它读客户端日志 + 补查 cid） */
  function hydrateFromServer() {
    if (st.hydrated) return Promise.resolve();
    st.hydrated = true;
    return fetch(API + '/api/state')
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s && s.bvid && s.cid && !st.bvid) {
          st.bvid = s.bvid;
          st.cid = s.cid;
          if (st.menuEl) {
            closeMenu();
            if (st.menuXY) openMenu(st.menuXY[0], st.menuXY[1]);
          }
        }
      })
      .catch(function () {});
  }

  // ---------------------------------------------------------------- 样式
  var CSS = [
    '.bdl-menu{position:fixed;z-index:2147483000;min-width:212px;padding:6px;border-radius:10px;',
    'background:#1b1c1f;border:1px solid rgba(255,255,255,.10);',
    'box-shadow:0 12px 32px rgba(0,0,0,.55);',
    'font:13px/1.5 -apple-system,"Microsoft YaHei",sans-serif;color:#e8e9ea;user-select:none;',
    'animation:bdl-in .12s ease-out;}',
    '@keyframes bdl-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}',
    '.bdl-hd{display:flex;align-items:center;gap:6px;padding:4px 10px 8px;color:#8b8d92;font-size:11px;',
    'letter-spacing:.4px;border-bottom:1px solid rgba(255,255,255,.07);margin-bottom:4px;}',
    '.bdl-dot{width:6px;height:6px;border-radius:50%;background:#fb7299;box-shadow:0 0 6px #fb7299;flex:none;}',
    '.bdl-hd b{color:#fb7299;font-weight:600;letter-spacing:0;}',
    '.bdl-bv{cursor:pointer;}',
    '.bdl-bv:hover{color:#fff;text-decoration:underline;}',
    '.bdl-copy{cursor:pointer;color:#7d7f85;font-size:10px;border:1px solid rgba(255,255,255,.18);',
    'border-radius:4px;padding:0 4px;line-height:14px;flex:none;}',
    '.bdl-copy:hover{color:#fff;border-color:rgba(255,255,255,.4);}',
    '.bdl-spec{padding:0 10px 9px;color:#7d7f85;font-size:11px;line-height:1.55;}',
    '.bdl-spec b{color:#c8cad0;font-weight:600;}',
    '.bdl-sub{display:none;}',
    '.bdl-sub .bdl-item{padding-left:24px;font-size:12px;color:#b9bbc1;}',
    '.bdl-arrow{color:#6d6f75;font-size:10px;flex:none;}',
    '.bdl-item{display:flex;align-items:center;justify-content:space-between;gap:12px;',
    'padding:8px 10px;border-radius:6px;cursor:pointer;transition:background .12s;}',
    '.bdl-item:hover{background:rgba(251,114,153,.16);}',
    '.bdl-item em{font-style:normal;color:#7d7f85;font-size:11px;flex:none;}',
    '.bdl-item.bdl-off{color:#5b5d62;cursor:not-allowed;}',
    '.bdl-item.bdl-off:hover{background:none;}',
    '.bdl-sep{height:1px;background:rgba(255,255,255,.07);margin:4px 6px;}',
    '.bdl-minor{color:#a9abb0;}',
    '.bdl-tip{padding:6px 10px 4px;color:#e6a23c;font-size:11px;}',

    '.bdl-panel{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:292px;padding:12px 14px;',
    'border-radius:10px;background:#1b1c1f;border:1px solid rgba(255,255,255,.10);',
    'box-shadow:0 12px 32px rgba(0,0,0,.55);',
    'font:12px/1.6 -apple-system,"Microsoft YaHei",sans-serif;color:#e8e9ea;user-select:none;}',
    '.bdl-p-head{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;}',
    '.bdl-p-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f1f2f3;}',
    '.bdl-p-x{cursor:pointer;color:#7d7f85;padding:0 2px;}',
    '.bdl-p-x:hover{color:#fff;}',
    '.bdl-p-cancel{display:none;cursor:pointer;color:#f0a5b6;font-size:11px;margin-left:6px;}',
    '.bdl-p-cancel:hover{color:#fff;text-decoration:underline;}',
    '.bdl-p-cancel[data-busy="1"]{color:#7d7f85;cursor:default;text-decoration:none;}',
    '.bdl-bar{height:5px;border-radius:3px;background:rgba(255,255,255,.10);overflow:hidden;}',
    '.bdl-bar i{display:block;height:100%;width:0;border-radius:3px;background:linear-gradient(90deg,#fb7299,#ff9db4);',
    'transition:width .25s ease;}',
    '.bdl-meta{margin-top:6px;color:#8b8d92;font-size:11px;display:flex;justify-content:space-between;}',
    '.bdl-meta b{color:#fb7299;font-weight:600;}',
    '.bdl-done{color:#4ade80;}',
    '.bdl-err{color:#f87171;}',
    '.bdl-open{color:#48a6ff;cursor:pointer;text-decoration:underline;}',
    '.bdl-path{display:block;margin-top:3px;color:#7d7f85;font-size:10.5px;',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',

    // ---------- 设置下载位置弹窗 ----------
    '.bdl-mask{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.5);',
    'display:flex;align-items:center;justify-content:center;}',
    '.bdl-card{width:470px;max-width:92vw;border-radius:12px;background:#1c1d20;',
    'border:1px solid rgba(255,255,255,.10);box-shadow:0 24px 60px rgba(0,0,0,.6);overflow:hidden;',
    'font:13px/1.6 -apple-system,"Microsoft YaHei",sans-serif;color:#e8e9ea;}',
    '.bdl-card-hd{display:flex;align-items:center;gap:6px;padding:14px 16px;font-size:14px;',
    'font-weight:600;border-bottom:1px solid rgba(255,255,255,.08);}',
    '.bdl-card-bd{padding:16px;}',
    '.bdl-label{color:#9a9ca1;font-size:12px;margin-bottom:8px;}',
    '.bdl-input{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:7px;',
    'border:1px solid rgba(255,255,255,.14);background:#131417;color:#f1f2f3;outline:none;',
    'font:13px/1.5 Consolas,"Microsoft YaHei",monospace;}',
    '.bdl-input:focus{border-color:#fb7299;}',
    '.bdl-row{display:flex;gap:8px;margin-top:10px;}',
    '.bdl-btn{padding:7px 14px;border-radius:7px;border:1px solid rgba(255,255,255,.14);',
    'background:rgba(255,255,255,.06);color:#e8e9ea;font-size:12px;line-height:1.4;',
    'cursor:pointer;transition:background .12s;}',
    '.bdl-btn:hover{background:rgba(255,255,255,.12);}',
    '.bdl-btn:disabled{opacity:.45;cursor:not-allowed;}',
    '.bdl-btn.primary{background:#fb7299;border-color:#fb7299;color:#fff;}',
    '.bdl-btn.primary:hover{background:#ff85a8;}',
    '.bdl-card-ft{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;',
    'border-top:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.02);}',
    '.bdl-err-line{margin-top:10px;font-size:12px;color:#f87171;min-height:18px;}',
    '.bdl-toast{position:fixed;left:50%;top:34px;transform:translateX(-50%);z-index:2147483002;',
    'padding:10px 18px;border-radius:8px;background:#1b1c1f;',
    'border:1px solid rgba(255,255,255,.12);color:#e8e9ea;font-size:13px;',
    'box-shadow:0 10px 30px rgba(0,0,0,.5);animation:bdl-in .15s ease-out;}',
    '.bdl-toast.err{border-color:rgba(248,113,113,.5);color:#fca5a5;}',
    '.bdl-check{display:flex;align-items:center;gap:8px;margin-top:14px;color:#c9cbcf;',
    'font-size:12px;cursor:pointer;user-select:none;}',
    '.bdl-check input{width:14px;height:14px;accent-color:#fb7299;cursor:pointer;margin:0;}',
  ].join('');

  function ensureStyle() {
    if (document.getElementById('bdl-style')) return;
    var s = document.createElement('style');
    s.id = 'bdl-style';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  // ---------------------------------------------------------------- 小工具
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function post(path, body) {
    return fetch(API + path, {
      method: 'POST',
      // text/plain 属于 CORS 安全类型，可省掉预检；服务端照样按 JSON 解析
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }

  function get(path) {
    return fetch(API + path).then(function (r) { return r.json(); });
  }

  /**
   * 复制文本到剪贴板。
   * 优先用 Clipboard API；全屏/无焦点时可能被拒，退回 execCommand 兜底。
   */
  function copyText(text) {
    return new Promise(function (resolve) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
          .writeText(text)
          .then(function () { resolve(true); })
          .catch(function () { resolve(fallbackCopy(text)); });
        return;
      }
      resolve(fallbackCopy(text));
    });
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      overlayRoot().appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  function fmtSize(n) {
    if (!n) return '0 B';
    if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
    if (n > 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }

  /** 只取路径最后一段，菜单里显示不下完整路径 */
  function baseName(p) {
    if (!p) return '';
    var parts = String(p).split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  /**
   * 浮层应该挂到哪个节点下。
   *
   * 关键：客户端全屏用的是 Fullscreen API（document.fullscreenElement = .app_player--wrap）。
   * 按规范，全屏时浏览器只渲染全屏元素及其子树，挂在 <body> 下的菜单会被完全隐藏
   * （实测 elementFromPoint 都点不到）。所以全屏时要把浮层挂进全屏元素内部。
   */
  function overlayRoot() {
    var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    return fsEl || document.body;
  }

  // 进出全屏时：关掉菜单，并把已打开的面板搬到新的容器里
  function onFullscreenChange() {
    closeMenu();
    if (st.panelEl) {
      try {
        overlayRoot().appendChild(st.panelEl);
      } catch (e) {}
    }
  }
  on(document, 'fullscreenchange', onFullscreenChange);
  on(document, 'webkitfullscreenchange', onFullscreenChange);

  function toast(msg, isErr) {
    ensureStyle();
    var t = el('div', 'bdl-toast' + (isErr ? ' err' : ''), msg);
    overlayRoot().appendChild(t);
    setTimeout(function () { t.remove(); }, 2600);
  }

  /** 读一次当前下载位置，用于菜单里显示"保存到 xxx" */
  function loadConfigOnce() {
    return get('/api/config')
      .then(function (c) {
        if (c && c.downloadDir) st.downloadDir = c.downloadDir;
      })
      .catch(function () {});
  }

  // ---------------------------------------------------------------- 设置下载位置
  function openSettings() {
    ensureStyle();
    closeMenu();
    if (document.querySelector('.bdl-mask')) return;

    var mask = el('div', 'bdl-mask');
    var card = el('div', 'bdl-card');
    card.innerHTML =
      '<div class="bdl-card-hd"><span class="bdl-dot"></span>下载位置</div>' +
      '<div class="bdl-card-bd">' +
        '<div class="bdl-label">视频保存到（可以点"浏览…"直接选文件夹）</div>' +
        '<input class="bdl-input" spellcheck="false" autocomplete="off" />' +
        '<div class="bdl-row">' +
          '<button class="bdl-btn" data-act="browse">浏览…</button>' +
          '<button class="bdl-btn" data-act="reset">恢复默认</button>' +
        '</div>' +
        '<label class="bdl-check"><input type="checkbox" class="bdl-auto" />下载完成后直接用资源管理器打开（会切换窗口）</label>' +
        '<label class="bdl-check"><input type="checkbox" class="bdl-restore" />客户端被重启后，自动恢复右键菜单</label>' +
        '<div class="bdl-err-line"></div>' +
      '</div>' +
      '<div class="bdl-card-ft">' +
        '<button class="bdl-btn" data-act="cancel">取消</button>' +
        '<button class="bdl-btn primary" data-act="save">保存</button>' +
      '</div>';

    mask.appendChild(card);
    overlayRoot().appendChild(mask);

    var input = card.querySelector('.bdl-input');
    var errLine = card.querySelector('.bdl-err-line');
    var autoChk = card.querySelector('.bdl-auto');
    var restoreChk = card.querySelector('.bdl-restore');
    var btns = card.querySelectorAll('.bdl-btn');

    input.value = st.downloadDir || '';
    autoChk.checked = st.autoOpenFolder !== false;
    restoreChk.checked = st.autoRestoreClient !== false;
    setTimeout(function () { input.focus(); input.select(); }, 30);

    // 拉一次最新配置，保证显示的是真实生效值
    get('/api/config')
      .then(function (c) {
        if (!c) return;
        if (c.downloadDir && !input.value) input.value = c.downloadDir;
        if (c.downloadDir) st.downloadDir = c.downloadDir;
        if (typeof c.autoOpenFolder === 'boolean') {
          st.autoOpenFolder = c.autoOpenFolder;
          autoChk.checked = c.autoOpenFolder;
        }
        if (typeof c.autoRestoreClient === 'boolean') {
          st.autoRestoreClient = c.autoRestoreClient;
          restoreChk.checked = c.autoRestoreClient;
        }
      })
      .catch(function () {});

    function setBusy(on) {
      for (var i = 0; i < btns.length; i++) btns[i].disabled = !!on;
    }
    function showErr(msg) { errLine.textContent = msg || ''; }
    function close() { mask.remove(); }

    mask.addEventListener('mousedown', function (e) {
      if (e.target === mask) close();
    });

    mask.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      if (e.key === 'Enter') { e.stopPropagation(); card.querySelector('[data-act="save"]').click(); }
    });

    card.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.bdl-btn') : null;
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      showErr('');

      if (act === 'cancel') { close(); return; }

      if (act === 'browse') {
        setBusy(true);
        post('/api/pick-folder', {})
          .then(function (r) {
            setBusy(false);
            if (r && r.ok) {
              st.downloadDir = r.downloadDir;
              input.value = r.downloadDir;
              if (typeof r.autoOpenFolder === 'boolean') {
                st.autoOpenFolder = r.autoOpenFolder;
                autoChk.checked = r.autoOpenFolder;
              }
              toast('已切换下载位置');
            } else if (r && r.cancelled) {
              // 用户取消，什么都不做
            } else {
              showErr((r && r.error) || '打开选择窗口失败，可以直接手动输入路径');
            }
          })
          .catch(function () {
            setBusy(false);
            showErr('连不上本地服务，请确认下载助手还在运行');
          });
        return;
      }

      if (act === 'reset') {
        setBusy(true);
        post('/api/config/reset', {})
          .then(function (r) {
            setBusy(false);
            if (r && r.ok) {
              st.downloadDir = r.downloadDir;
              input.value = r.downloadDir;
              if (typeof r.autoOpenFolder === 'boolean') {
                st.autoOpenFolder = r.autoOpenFolder;
                autoChk.checked = r.autoOpenFolder;
              }
              toast('已恢复默认位置');
            } else {
              showErr((r && r.error) || '恢复失败');
            }
          })
          .catch(function () { setBusy(false); showErr('连不上本地服务'); });
        return;
      }

      if (act === 'save') {
        var v = input.value.trim();
        if (!v) { showErr('路径不能为空'); return; }
        setBusy(true);
        post('/api/config', {
          downloadDir: v,
          autoOpenFolder: autoChk.checked,
          autoRestoreClient: restoreChk.checked,
        })
          .then(function (r) {
            setBusy(false);
            if (r && r.ok) {
              st.downloadDir = r.downloadDir;
              st.autoOpenFolder = r.autoOpenFolder;
              st.autoRestoreClient = r.autoRestoreClient;
              input.value = r.downloadDir;
              autoChk.checked = r.autoOpenFolder !== false;
              restoreChk.checked = r.autoRestoreClient !== false;
              toast('设置已保存');
              close();
            } else {
              showErr((r && r.error) || '保存失败');
            }
          })
          .catch(function () { setBusy(false); showErr('连不上本地服务'); });
      }
    });
  }

  // ---------------------------------------------------------------- 右键菜单
  function closeMenu() {
    if (st.menuEl) {
      st.menuEl.remove();
      st.menuEl = null;
    }
  }

  /**
   * 选流优先级：清晰度 > 帧率 > 码率 > 编码兼容性。
   * 同一档位往往同时有 avc1 / hev1 / av01 三条流，帧率和码率都不一样，
   * 先挑帧率最高（"最高帧率优先"），再挑码率最高，最后照顾 avc1 兼容性。
   */
  function pickBest(a, b) {
    if ((b.id || 0) !== (a.id || 0)) return (b.id || 0) - (a.id || 0);
    var af = parseFloat(a.frameRate) || 0;
    var bf = parseFloat(b.frameRate) || 0;
    if (bf !== af) return bf - af;
    var ab = a.bandwidth || 0;
    var bb = b.bandwidth || 0;
    if (bb !== ab) return bb - ab;
    var aH = /^avc1/.test(a.codecs || '') ? 1 : 0;
    var bH = /^avc1/.test(b.codecs || '') ? 1 : 0;
    return bH - aH;
  }

  var specCache = {}; // cid -> { at, spec }

  function shortSpec(s) {
    if (!s) return '';
    var h = s.height >= 2000 ? '4K' : s.height >= 1400 ? '2K' : s.height + 'p';
    return h + ' ' + Math.round(s.fps) + 'fps';
  }

  function fullSpec(s) {
    if (!s) return '';
    return (
      (s.quality ? s.quality + ' · ' : '') +
      s.width + '×' + s.height +
      ' · ' + Math.round(s.fps) + 'fps' +
      ' · ' + s.mbps + 'Mbps'
    );
  }

  /** 读取当前视频的真实规格（顺手缓存，菜单反复打开不会重复请求） */
  function fetchSpec(bvid, cid) {
    var hit = specCache[cid];
    if (hit && Date.now() - hit.at < 60000) return Promise.resolve(hit.spec);

    var url =
      'https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid) +
      '&cid=' + encodeURIComponent(cid) + '&qn=120&fnval=4048&fourk=1';

    return fetch(url, { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.code !== 0 || !j.data || !j.data.dash) return null;
        var vs = (j.data.dash.video || []).slice().sort(pickBest);
        var top = vs[0];
        if (!top) return null;

        // 720P 那一档的帧率（"720P 秒下"走的是单文件通道，帧率跟 720P 流一致）
        var near720 = vs.slice().sort(function (a, b) {
          return Math.abs((a.height || 0) - 720) - Math.abs((b.height || 0) - 720);
        })[0];

        var fpsList = vs.map(function (v) { return parseFloat(v.frameRate) || 0; });
        var spec = {
          qn: top.id,
          width: top.width,
          height: top.height,
          fps: parseFloat(top.frameRate) || 0,
          mbps: Math.round((top.bandwidth || 0) / 100000) / 10,
          maxHeight: Math.max.apply(null, vs.map(function (v) { return v.height || 0; })),
          maxFps: Math.max.apply(null, fpsList),
          fps720: parseFloat((near720 || {}).frameRate) || 0,
          quality:
            (j.data.accept_description || [])[(j.data.accept_quality || []).indexOf(top.id)] || '',
        };
        specCache[cid] = { at: Date.now(), spec: spec };
        return spec;
      })
      .catch(function () { return null; });
  }

  function placeMenu(m, x, y) {
    var r = m.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + 'px';
    m.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + 'px';
  }

  function openMenu(x, y) {
    ensureStyle();
    closeMenu();
    st.menuXY = [x, y];
    refreshCurrent();

    var hasVideo = !!(st.bvid && st.cid);
    var m = el('div', 'bdl-menu');

    // ---- 头部：● 下载助手  BV1xxx  [复制]
    var hd = el('div', 'bdl-hd', '<span class="bdl-dot"></span>下载助手' +
      (hasVideo
        ? ' <b class="bdl-bv" title="点击复制视频链接">' + st.bvid + '</b>' +
          '<span class="bdl-copy" title="点击复制视频链接">复制</span>'
        : ''));
    m.appendChild(hd);

    if (hasVideo) {
      var copyLink = function (ev) {
        ev.stopPropagation();
        var url = 'https://www.bilibili.com/video/' + st.bvid;
        copyText(url).then(function (ok) {
          toast(ok ? '已复制视频链接' : '复制失败，请手动复制：' + url);
          closeMenu();
        });
      };
      var bvEl = m.querySelector('.bdl-bv');
      var cpEl = m.querySelector('.bdl-copy');
      if (bvEl) bvEl.addEventListener('click', copyLink);
      if (cpEl) cpEl.addEventListener('click', copyLink);
    }

    // ---- 规格行：真实清晰度 / 分辨率 / 帧率 / 码率
    var specEl = null;
    if (hasVideo) {
      specEl = el('div', 'bdl-spec', '正在读取清晰度…');
      m.appendChild(specEl);
    }

    m.appendChild(el('div', 'bdl-sep'));

    function makeRow(label, right, disabled, cls) {
      var row = el('div', 'bdl-item' + (disabled ? ' bdl-off' : '') + (cls ? ' ' + cls : ''),
        '<span>' + label + '</span><em>' + right + '</em>');
      return row;
    }

    // ---- 主行动
    var bestRow = makeRow('下载视频', '—', !hasVideo);
    bestRow.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (!hasVideo) return;
      closeMenu();
      startDownload('best');
    });
    m.appendChild(bestRow);

    var audioRow = makeRow('仅下载音频', 'M4A', !hasVideo);
    audioRow.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (!hasVideo) return;
      closeMenu();
      startDownload('audio');
    });
    m.appendChild(audioRow);

    // ---- 更多清晰度（折叠，避免菜单一屏七八行）
    var sub = el('div', 'bdl-sub');
    var moreRow = el('div', 'bdl-item' + (hasVideo ? '' : ' bdl-off'),
      '<span>更多清晰度</span><span class="bdl-arrow">▸</span>');

    var fastRow = makeRow('720P 秒下', '单文件', !hasVideo);
    fastRow.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (!hasVideo) return;
      closeMenu();
      startDownload('fast');
    });
    var k2Row = makeRow('高清 2K', '—', !hasVideo);
    k2Row.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (!hasVideo) return;
      closeMenu();
      startDownload('2k');
    });
    var k4Row = makeRow('高清 4K', '—', !hasVideo);
    k4Row.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (!hasVideo) return;
      closeMenu();
      startDownload('4k');
    });
    sub.appendChild(fastRow);
    sub.appendChild(k2Row);
    sub.appendChild(k4Row);

    var expanded = false;
    moreRow.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (!hasVideo) return;
      expanded = !expanded;
      sub.style.display = expanded ? 'block' : 'none';
      moreRow.querySelector('.bdl-arrow').textContent = expanded ? '▾' : '▸';
      placeMenu(m, x, y);
    });

    m.appendChild(moreRow);
    m.appendChild(sub);

    m.appendChild(el('div', 'bdl-sep'));

    var folder = el('div', 'bdl-item bdl-minor', '<span>打开下载文件夹</span>');
    folder.addEventListener('click', function (ev) {
      ev.stopPropagation();
      closeMenu();
      post('/api/openfolder', {}).catch(function () {});
    });
    m.appendChild(folder);

    var settings = el('div', 'bdl-item bdl-minor',
      '<span>设置下载位置…</span><em>' + (baseName(st.downloadDir) || '') + '</em>');
    settings.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openSettings();
    });
    m.appendChild(settings);

    if (!hasVideo) {
      m.appendChild(el('div', 'bdl-tip', '还没识别到视频，先播放一下再右键'));
    }

    overlayRoot().appendChild(m);
    st.menuEl = m;
    placeMenu(m, x, y);

    if (!hasVideo) return;

    // ---- 异步补上真实规格
    function applySpec(spec) {
      if (!spec || st.menuEl !== m) return;

      specEl.innerHTML =
        '<b>' + fullSpec(spec) + '</b>' +
        (spec.maxFps && spec.maxFps < 45 ? '<br>本视频最高 ' + Math.round(spec.maxFps) + 'fps' : '');
      bestRow.querySelector('em').textContent = shortSpec(spec);

      var native2k = spec.maxHeight >= 1440 - 8;
      var native4k = spec.maxHeight >= 2160 - 8;
      var fps = Math.round(spec.fps || 0);
      var f720 = Math.round(spec.fps720 || 0);

      fastRow.querySelector('em').textContent = (f720 ? f720 + 'fps · ' : '') + '单文件';
      k2Row.querySelector('em').textContent = fps + 'fps · ' + (native2k ? '原生' : '放大');
      k4Row.querySelector('em').textContent = fps + 'fps · ' + (native4k ? '原生' : '放大');

      placeMenu(m, x, y);
    }

    fetchSpec(st.bvid, st.cid).then(applySpec);

    // 信息流页面（#/page/selected）URL 和 DOM 都没有 bvid，
    // 只能拿客户端刚才用 avid 请求过的视频反查，再刷新头部与规格。
    if (!pagePair() && liveAids.length) {
      var elV = mainVideo();
      var target = elV && isFinite(elV.duration) ? elV.duration : 0;
      var aids = liveAids.slice(0, 5);

      // 最近一条未必是在播的那个（后面的视频会被预加载），所以逐个查时长，
      // 命中播放器时长才认，否则试下一个。
      var tryAid = function (i) {
        if (i >= aids.length || st.menuEl !== m) return;
        var a = aids[i];
        bvidForAid(a.aid).then(function (bv) {
          if (!bv) return tryAid(i + 1);
          return durationOf(bv, a.cid).then(function (dur) {
            var hit = target && dur && Math.abs(dur - target) <= Math.max(3, target * 0.05);
            if (!hit) return tryAid(i + 1);
            st.bvid = bv;
            st.cid = a.cid;
            var bvNode = m.querySelector('.bdl-bv');
            if (bvNode) bvNode.textContent = bv;
            fetchSpec(bv, a.cid).then(applySpec);
          });
        });
      };
      tryAid(0);
    }
  }
  on(document, 'contextmenu', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest('input,textarea,[contenteditable="true"]')) return;

    // 只在这个页面确实有播放器时才接管右键。
    // 现在注入范围覆盖客户端所有页面（主页、搜索页、合集页…），
    // 如果不加这道判断，普通页面上的右键也会被我们吃掉。
    var hasVideo = !!document.querySelector('video');
    if (!hasVideo) return;

    e.preventDefault();
    e.stopPropagation();

    st.hydrated = false;
    openMenu(e.clientX, e.clientY);
    if (!st.bvid || !st.cid) hydrateFromServer();
  }, true);

  ['mousedown', 'wheel', 'keydown'].forEach(function (evt) {
    on(document, evt, function (e) {
      if (!st.menuEl) return;
      if (evt === 'keydown' && e.key !== 'Escape') return;
      if (evt === 'mousedown' && st.menuEl.contains(e.target)) return;
      closeMenu();
    }, true);
  });

  on(window, 'blur', closeMenu);

  // ---------------------------------------------------------------- 进度面板
  function showPanel(title) {
    ensureStyle();
    if (st.panelEl) st.panelEl.remove();

    var p = el('div', 'bdl-panel');
    p.innerHTML =
      '<div class="bdl-p-head">' +
        '<span class="bdl-dot"></span>' +
        '<span class="bdl-p-name"></span>' +
        '<span class="bdl-p-cancel">取消</span>' +
        '<span class="bdl-p-x">✕</span>' +
      '</div>' +
      '<div class="bdl-bar"><i></i></div>' +
      '<div class="bdl-meta"><span class="bdl-p-stat">准备中…</span><span class="bdl-p-pct"></span></div>' +
      '<div class="bdl-meta bdl-p-extra" style="display:none"></div>';

    p.querySelector('.bdl-p-name').textContent = title || '视频';
    p.querySelector('.bdl-p-x').addEventListener('click', function () {
      p.remove();
      st.panelEl = null;
      stopPolling();
    });

    // 取消按钮：中断下载并让服务端清掉半成品
    var cancelBtn = p.querySelector('.bdl-p-cancel');
    cancelBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (cancelBtn.getAttribute('data-busy') === '1') return;
      var id = st.currentJobId;
      if (!id) return;
      cancelBtn.setAttribute('data-busy', '1');
      cancelBtn.textContent = '取消中…';
      post('/api/cancel', { id: id }).catch(function () {
        cancelBtn.removeAttribute('data-busy');
        cancelBtn.textContent = '取消';
      });
    });

    overlayRoot().appendChild(p);
    st.panelEl = p;
    return p;
  }

  function setPanel(percent, statHtml) {
    if (!st.panelEl) return;
    st.panelEl.querySelector('.bdl-bar i').style.width = Math.max(0, Math.min(100, percent || 0)) + '%';
    st.panelEl.querySelector('.bdl-p-stat').innerHTML = statHtml;
    st.panelEl.querySelector('.bdl-p-pct').textContent = (percent ? percent.toFixed(0) : '0') + '%';
  }

  function setExtra(html) {
    if (!st.panelEl) return;
    var e = st.panelEl.querySelector('.bdl-p-extra');
    e.style.display = 'block';
    e.innerHTML = html;
  }

  function stopPolling() {
    if (st.polling) {
      clearInterval(st.polling);
      st.polling = null;
    }
  }

  /** 控制"取消"按钮的显示 */
  function setCancel(visible, text, busy) {
    if (!st.panelEl) return;
    var b = st.panelEl.querySelector('.bdl-p-cancel');
    if (!b) return;
    b.style.display = visible ? 'inline' : 'none';
    b.textContent = text || '取消';
    if (busy) b.setAttribute('data-busy', '1');
    else b.removeAttribute('data-busy');
  }

  function closePanelSoon(ms) {
    setTimeout(function () {
      if (st.panelEl) {
        st.panelEl.remove();
        st.panelEl = null;
      }
    }, ms);
  }

  // ---------------------------------------------------------------- 解析流地址
  function resolveStreams(bvid, cid, mode) {
    var wantsHi = mode === '2k' || mode === '4k';
    var targetH = mode === '4k' ? 2160 : 1440;

    var qn = mode === 'fast' ? 64 : 120;
    var fnval = mode === 'fast' ? 1 : 4048;

    var url = 'https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid) +
      '&cid=' + encodeURIComponent(cid) + '&qn=' + qn + '&fnval=' + fnval + '&fourk=1';

    return fetch(url, { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.code !== 0 || !j.data) throw new Error('取流失败（code=' + (j && j.code) + '）');
        var d = j.data;

        // 这条流本该有多长（秒）：用来和播放器实际时长比对，识别 id 有没有认错
        var apiDur = 0;
        if (d.dash && d.dash.duration) apiDur = d.dash.duration;
        else if (d.durl && d.durl[0] && d.durl[0].length) apiDur = d.durl[0].length / 1000;
        else if (d.timelength) apiDur = d.timelength / 1000;

        if (mode === 'fast') {
          var durl = d.durl || [];
          if (durl.length === 1) {
            return {
              mode: 'fast',
              quality: d.quality,
              apiDur: apiDur,
              streams: [{ url: durl[0].url, kind: 'video' }],
            };
          }
          // 长视频会被切成多段，改走 DASH（一条画面流 + 一条声音流，更好合并）
          mode = 'best';
        }

        var dash = d.dash;
        var hasVideoTrack = !!(dash && dash.video && dash.video.length);

        // 仅音频模式下不要求有画面流（少数内容就是纯音频）
        if (!hasVideoTrack && mode !== 'audio') {
          throw new Error('这个视频没有可用的 DASH 流');
        }
        if (!dash) throw new Error('这个视频没有可用的 DASH 流');

        var audios = (dash.audio || []).slice().sort(function (a, b) {
          return (b.id || 0) - (a.id || 0);
        });
        var bestAudio = audios[0];

        if (mode === 'audio') {
          if (!bestAudio) throw new Error('没有可用音频流');
          return {
            mode: 'audio',
            quality: bestAudio.id,
            apiDur: apiDur,
            streams: [{ url: bestAudio.baseUrl || bestAudio.base_url, kind: 'audio' }],
          };
        }

        // ---- 高清下载（2K / 4K）：原生优先，源不够高才放大
        if (wantsHi) {
          var byRes = dash.video.slice().sort(function (a, b) {
            return (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0);
          });
          var top = byRes[0];
          var nativeH = (top && top.height) || 0;
          var nativeW = (top && top.width) || 0;
          // 容差 8px：1440 附近算 2K，2160 附近算 4K
          var needUpscale = nativeH > 0 && nativeH < targetH - 8;

          return {
            mode: 'hires',
            quality: top.id,
            apiDur: apiDur,
            targetHeight: targetH,
            nativeHeight: nativeH,
            nativeWidth: nativeW,
            upscale: needUpscale,
            spec: {
              width: needUpscale ? 0 : nativeW,
              height: needUpscale ? targetH : nativeH,
              fps: parseFloat(top.frameRate) || 0,
              mbps: Math.round((top.bandwidth || 0) / 100000) / 10,
              upscale: needUpscale,
            },
            streams: [
              { url: top.baseUrl || top.base_url, kind: 'video' },
              { url: (bestAudio || {}).baseUrl || (bestAudio || {}).base_url, kind: 'audio' },
            ],
          };
        }

        var videos = dash.video.slice().sort(pickBest);
        var bestVideo = videos[0];

        // 记录这条流的真实规格，给"下载完成"的卡片用
        var spec = {
          quality: '',
          width: bestVideo.width || 0,
          height: bestVideo.height || 0,
          fps: parseFloat(bestVideo.frameRate) || 0,
          mbps: Math.round((bestVideo.bandwidth || 0) / 100000) / 10,
        };

        return {
          mode: 'best',
          quality: bestVideo.id,
          apiDur: apiDur,
          spec: spec,
          streams: [
            { url: bestVideo.baseUrl || bestVideo.base_url, kind: 'video' },
            { url: (bestAudio || {}).baseUrl || (bestAudio || {}).base_url, kind: 'audio' },
          ],
        };
      });
  }

  // ---------------------------------------------------------------- 开始下载

  /** 用 view 接口取"某个 bvid 的真实标题"（分P 会把小节名带上），
   *  保证文件名和下载到的内容永远来自同一个视频，不会张冠李戴。 */
  function fetchTitleFor(bvid, cid) {
    return fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), {
      credentials: 'include',
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.code !== 0 || !j.data) return '';
        var t = j.data.title || '';
        var pages = j.data.pages || [];
        if (pages.length > 1) {
          for (var i = 0; i < pages.length; i++) {
            if (String(pages[i].cid) === String(cid)) {
              t = t + ' P' + pages[i].page + ' ' + (pages[i].part || '');
              break;
            }
          }
        }
        return t.trim();
      })
      .catch(function () { return ''; });
  }

  /**
   * 从 <video> 往上找它所在的视频卡片，取出 BV 号。
   *
   * 信息流页面（index.html#/page/selected）里 URL 不带 bvid/cid，
   * 页面上还同时挂着好几个 <video>（后面的视频已预加载），
   * 只能靠 DOM：正在播的那个元素所在的卡片里一定有 /video/BVxxxx 的链接。
   */
  function bvidNearVideo(v) {
    if (!v) return null;
    var el = v;
    for (var i = 0; i < 14 && el; i++) {
      try {
        var a = el.querySelector && el.querySelector('a[href*="/video/BV"]');
        if (a) {
          var m = /\/video\/(BV[0-9A-Za-z]{10})/.exec(a.getAttribute('href') || '');
          if (m) return m[1];
        }
        var attr = el.getAttribute && (el.getAttribute('data-bvid') || '');
        if (/^BV[0-9A-Za-z]{10}$/.test(attr)) return attr;
      } catch (e) {}
      el = el.parentElement;
    }
    return null;
  }

  /** 用 view 接口把 avid 换成 bvid（信息流页面的 playurl 只给 avid） */
  function bvidForAid(aid) {
    if (!aid) return Promise.resolve(null);
    return fetch('https://api.bilibili.com/x/web-interface/view?aid=' + encodeURIComponent(aid), {
      credentials: 'include',
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        return j && j.code === 0 && j.data && j.data.bvid ? j.data.bvid : null;
      })
      .catch(function () { return null; });
  }

  /** 查这条流有多长（秒），用来和播放器时长比对 */
  function durationOf(bvid, cid) {
    if (!bvid || !cid) return Promise.resolve(0);
    var url =
      'https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid) +
      '&cid=' + encodeURIComponent(cid) + '&qn=64&fnval=4048&fourk=1';
    return fetch(url, { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.code !== 0 || !j.data) return 0;
        var d = j.data;
        if (d.dash && d.dash.duration) return d.dash.duration;
        if (d.timelength) return d.timelength / 1000;
        return 0;
      })
      .catch(function () { return 0; });
  }

  /** 用 view 接口把 bvid 换成 cid */
  function cidFor(bvid) {
    if (!bvid) return Promise.resolve(null);
    return fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), {
      credentials: 'include',
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.code === 0 && j.data && j.data.cid) return String(j.data.cid);
        return null;
      })
      .catch(function () { return null; });
  }

  function startDownload(mode) {
    refreshCurrent();

    var own = pagePair();
    var v = mainVideo();
    var elDur = 0;
    if (v && isFinite(v.duration) && v.duration > 0) elDur = v.duration;

    // 信息流页面（index.html#/page/selected）URL 不带 bvid/cid，
    // 页面上还预加载了好几个 <video>，只能从"正在播的那个"往上找卡片里的 BV 号。
    var domBv = bvidNearVideo(v);

    // 先把"额外候选"补齐：DOM 里的 BV 号、以及信息流页面用 avid 发起的 playurl
    var extras = [];
    var chain = Promise.resolve();

    if (domBv && (!own || own.bvid !== domBv)) {
      chain = chain.then(function () {
        return cidFor(domBv).then(function (cid) {
          if (cid) extras.push({ bvid: domBv, cid: cid });
        });
      });
    }

    if (liveAids.length) {
      var aids = liveAids.slice(0, 6);
      chain = chain.then(function () {
        return Promise.all(
          aids.map(function (a) {
            return bvidForAid(a.aid).then(function (bv) {
              return bv ? { bvid: bv, cid: a.cid } : null;
            });
          })
        ).then(function (list) {
          for (var i = 0; i < list.length; i++) if (list[i]) extras.push(list[i]);
        });
      });
    }

    chain.then(function () {
      runDownload(mode, own, elDur, extras);
    });
  }

  function runDownload(mode, own, elDur, extras) {
    var cands = [];
    function add(b, c, fromUrl) {
      if (!b || !c) return;
      for (var i = 0; i < cands.length; i++) {
        if (cands[i].bvid === b && cands[i].cid === c) {
          if (fromUrl) cands[i].fromUrl = true;
          return;
        }
      }
      cands.push({ bvid: b, cid: c, fromUrl: !!fromUrl });
    }
    // ⓪ 画面/DOM/avid 反查出来的候选（信息流页面全靠这个）
    for (var ei = 0; ei < (extras || []).length; ei++) {
      add(extras[ei].bvid, extras[ei].cid, true);
    }
    // ① 画面所在的视频（最可信）
    add(own && own.bvid, own && own.cid, true); // ② 页面 URL
    // ③ 最近客户端请求过的所有 playurl（信息流页面唯一的线索）
    var rp = st.recentPairs || [];
    for (var ri = 0; ri < rp.length; ri++) add(rp[ri].bvid, rp[ri].cid, false);
    add(st.voteBvid, st.voteCid, false); // ④ 分片投票（会预加载推荐视频，仅参考）
    add(st.lastBvid, st.lastCid, false); // ⑤ 上次解析

    if (!cands.length) {
      hydrateFromServer().then(function () {
        if (st.bvid && st.cid) startDownload(mode);
        else alert('还没识别到当前视频，先播放一下再试');
      });
      return;
    }

    showPanel(document.title && document.title.length > 2 ? document.title : cands[0].bvid);
    setPanel(0, '正在解析视频流…');
    stopPolling();

    // 依次解析所有候选，收集各自的时长
    var got = [];
    function resolveAt(i) {
      if (i >= cands.length) return Promise.resolve(got);
      return resolveStreams(cands[i].bvid, cands[i].cid, mode)
        .then(function (plan) {
          got.push({ cand: cands[i], plan: plan });
          return resolveAt(i + 1);
        })
        .catch(function () {
          return resolveAt(i + 1); // 单个候选失败不影响其他候选
        });
    }

    resolveAt(0)
      .then(function (list) {
        if (!list.length) throw new Error('没拿到可下载的地址（可能是会员专享或已下架）');

        // 选优顺序：**和播放器时长对得上的** > 页面 URL > 第一个可用的。
        //
        // 为什么以时长为准：页面 URL 和 <video> 元素会短暂不同步（两个方向都出现过）——
        // 有时 URL 已经切到新视频、画面还是旧的；有时画面已经切了、URL 还是旧的。
        // 只有"播放器里真正在放的那条流"是用户眼睛看到的，所以以它为准。
        //
        // 容差取 5%（至少 3 秒）：MSE 加载初期 duration 会是不完整的渐进值
        // （实测同一视频先报 208s、随后变 215s），容差太小会把正确结果判成不一致。
        var tol = Math.max(3, (elDur || 0) * 0.05);
        var pick = null;

        for (var i = 0; i < list.length; i++) {
          var d = list[i].plan.apiDur;
          if (elDur && d && Math.abs(d - elDur) <= tol) {
            pick = list[i];
            break;
          }
        }
        if (!pick) {
          for (var j = 0; j < list.length; j++) {
            if (list[j].cand.fromUrl) {
              pick = list[j];
              break;
            }
          }
        }
        if (!pick) pick = list[0];

        // 时长对不上时只提示、不阻断：
        // 信息流页面上可能有多个 <video>（后面几个是预加载的），
        // 拿到的 duration 未必是正在播的那个，直接报错会让用户"什么都下不了"。
        var picked = pick.plan.apiDur || 0;
        var durWarn = '';
        if (elDur && picked && Math.abs(picked - elDur) > Math.max(8, elDur * 0.1)) {
          durWarn = '⚠ 识别到 ' + Math.round(picked) + 's，播放器 ' + Math.round(elDur) + 's，如内容不符请 Ctrl+R 后重试';
        }

        var plan = pick.plan;
        st.bvid = pick.cand.bvid;
        st.cid = pick.cand.cid;

        var streams = (plan.streams || []).filter(function (s) { return s && s.url; });
        if (!streams.length) throw new Error('没拿到可下载的地址');

        var tip = '已解析，开始下载…';

        if (plan.mode === 'hires') {
          var label = plan.targetHeight >= 2160 ? '4K' : '2K';
          tip = plan.upscale
            ? '源片 ' + plan.nativeHeight + 'p，下载后放大到 ' + label + '…'
            : '原生 ' + plan.nativeHeight + 'p（已是 ' + label + '），开始下载…';
        }
        // 记住这次下载的规格，完成卡片上要显示出来
        st.lastSpec = plan.spec || null;
        if (durWarn) tip = durWarn;
        setPanel(3, tip);

        // 标题也用这个 bvid 去查，确保"文件名"和"内容"是同一个视频
        return fetchTitleFor(pick.cand.bvid, pick.cand.cid).then(function (realTitle) {
          var title = realTitle || document.title || '';
          if (realTitle && st.panelEl) {
            var nameEl = st.panelEl.querySelector('.bdl-p-name');
            if (nameEl) nameEl.textContent = realTitle;
          }
          return post('/api/download', {
            bvid: pick.cand.bvid,
            cid: pick.cand.cid,
            mode: plan.mode,
            quality: plan.quality,
            title: title,
            streams: streams,
            targetHeight: plan.targetHeight || 0,
            nativeHeight: plan.nativeHeight || 0,
            upscale: !!plan.upscale,

            duration: plan.apiDur || 0,
          });
        });
      })
      .then(function (res) {
        if (!res || !res.id) throw new Error((res && res.error) || '下载服务没有返回任务号');
        st.currentJobId = res.id;
        poll(res.id);
      })
      .catch(function (e) {
        setPanel(0, '<span class="bdl-err">失败：' + String(e.message || e) + '</span>');
        closePanelSoon(9000);
      });
  }

  function poll(id) {
    var started = Date.now();
    stopPolling();

    st.polling = setInterval(function () {
      get('/api/progress?id=' + encodeURIComponent(id))
        .then(function (p) {
          if (!p) return;

          if (p.status === 'downloading') {
            setCancel(true);
            var speed = p.speed ? ' · ' + fmtSize(p.speed) + '/s' : '';
            setPanel(p.percent || 0, fmtSize(p.received) + (p.total ? ' / ' + fmtSize(p.total) : '') + speed);
          } else if (p.status === 'merging') {
            setCancel(true);
            setPanel(99, '正在用 ffmpeg 合并音视频…');

          } else if (p.status === 'upscaling') {
            setCancel(true);
            var tag = (p.targetHeight || 0) >= 2160 ? '4K' : '2K';
            setPanel(p.upscalePercent || 0, '正在放大到 ' + tag + '… ' + (p.upscalePercent || 0) + '%（耗时较长）');
          } else if (p.status === 'cancelling') {
            setCancel(true, '取消中…', true);
            setPanel(0, '正在取消…');
          } else if (p.status === 'cancelled') {
            stopPolling();
            setCancel(false);
            st.currentJobId = null;
            setPanel(0, '<span class="bdl-err">已取消，临时文件已清理</span>');
            closePanelSoon(6000);
          } else if (p.status === 'done') {
            stopPolling();
            setCancel(false);
            st.currentJobId = null;
            var sp = st.lastSpec || null;
            var specTxt = '';
            if (sp && sp.height) {
              specTxt =
                ' · ' + (sp.width ? sp.width + '×' : '') + sp.height +
                ' · ' + Math.round(sp.fps || 0) + 'fps' +
                ' · ' + sp.mbps + 'Mbps' +
                (sp.upscale ? '（放大）' : '');
            }
            setPanel(100, '<span class="bdl-done">✓ 下载完成' + specTxt + '</span>');
            setExtra(
              '<span class="bdl-open">打开文件夹</span>' +
                (st.downloadDir
                  ? '<span class="bdl-path" title="' + st.downloadDir + '">已保存到 ' + st.downloadDir + '</span>'
                  : '')
            );
            var o = st.panelEl && st.panelEl.querySelector('.bdl-open');
            if (o) {
              o.addEventListener('click', function () {
                post('/api/openfolder', { file: p.file }).catch(function () {});
              });
            }
            closePanelSoon(25000);
          } else if (p.status === 'error') {
            stopPolling();
            setCancel(false);
            st.currentJobId = null;
            setPanel(0, '<span class="bdl-err">失败：' + (p.error || '未知错误') + '</span>');
            closePanelSoon(12000);
          }

          if (Date.now() - started > 30 * 60 * 1000) stopPolling();
        })
        .catch(function () {});
    }, 700);
  }

  // ---------------------------------------------------------------- 调试入口
  window.__BDL_STATE__ = st;
  window.__BDL_REFRESH__ = refreshCurrent;
  window.__BDL_MENU__ = function (x, y) { openMenu(x == null ? 100 : x, y == null ? 100 : y); };
  window.__BDL_SETTINGS__ = openSettings;
  window.__BDL_DL__ = startDownload; // 调试用：直接触发下载，不经过菜单

  // ---------------------------------------------------------------- 卸载入口
  // 脚本更新后会被重新注入，注入前先调用它，避免新旧两个实例同时抢右键。
  window.__BDL_TEARDOWN__ = function () {
    try {
      for (var i = 0; i < disposers.length; i++) {
        try { disposers[i](); } catch (e) {}
      }
    } catch (e) {}
    disposers.length = 0;

    try { stopPolling(); } catch (e) {}
    try { closeMenu(); } catch (e) {}

    var kill = ['#bdl-style', '.bdl-menu', '.bdl-panel', '.bdl-mask', '.bdl-toast', '.bdl-card'];
    for (var k = 0; k < kill.length; k++) {
      try {
        var nodes = document.querySelectorAll(kill[k]);
        for (var n = 0; n < nodes.length; n++) nodes[n].remove();
      } catch (e) {}
    }

    try { delete window.__BDL_INSTALLED__; } catch (e) { window.__BDL_INSTALLED__ = false; }
    try { delete window.__BDL_TEARDOWN__; } catch (e) {}
    try { delete window.__BDL_STATE__; } catch (e) {}
  };

  refreshCurrent();
  loadConfigOnce();
})();
