#!/usr/bin/env node
'use strict';
/**
 * probe.js —— 环境探测，用退出码告诉批处理该走哪条路
 *
 * 退出码：
 *   0 = 客户端已在"可下载模式"（调试端口可用），可以直接启动
 *   2 = 客户端正在运行，但没有开调试端口 → 需要重启客户端
 *   3 = 客户端没在运行 → 直接带调试端口启动即可
 */
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const CDP_PORT = Number(process.env.BDL_CDP_PORT || 9333);
const CLIENT_PORT = 22331; // 客户端自身的内置服务端口，用来判断"它是否在跑"

function probePort(port, host) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(700);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
    s.connect(port, host || '127.0.0.1');
  });
}

(async () => {
  const cdp = await probePort(CDP_PORT, '127.0.0.1');
  if (cdp) {
    process.exit(0);
  }
  const client = await probePort(CLIENT_PORT, '127.0.0.1');
  process.exit(client ? 2 : 3);
})();
