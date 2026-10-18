'use strict';
/**
 * cdp.js —— 极简 Chrome DevTools Protocol 客户端
 *
 * 只用 Node 内置的 WebSocket（Node 22+ 自带），不依赖任何 npm 包。
 */

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  /** 建立连接 */
  connect(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch (_) {}
        reject(new Error('CDP 连接超时'));
      }, timeoutMs);

      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });

      ws.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('CDP 连接失败'));
      });

      ws.addEventListener('close', () => {
        this.closed = true;
        for (const { reject: rj } of this.pending.values()) {
          rj(new Error('CDP 连接已关闭'));
        }
        this.pending.clear();
      });

      ws.addEventListener('message', (ev) => this._onMessage(ev));
    });
  }

  _onMessage(ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }

    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error('CDP: ' + (msg.error.message || JSON.stringify(msg.error))));
      else resolve(msg.result);
      return;
    }

    if (msg.method && this.listeners.has(msg.method)) {
      for (const cb of this.listeners.get(msg.method)) {
        try { cb(msg.params); } catch (_) {}
      }
    }
  }

  /** 发送一条 CDP 命令 */
  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('CDP 连接已关闭'));
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, timeoutMs);
    });
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }

  /** 在页面里执行一段 JS，返回其值 */
  async evaluate(expression, timeoutMs = 15000) {
    const res = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      timeoutMs
    );
    if (res.exceptionDetails) {
      const d = res.exceptionDetails.exception && res.exceptionDetails.exception.description;
      throw new Error('页面 JS 异常: ' + (d || res.exceptionDetails.text));
    }
    return res.result ? res.result.value : undefined;
  }

  close() {
    try { this.ws && this.ws.close(); } catch (_) {}
  }
}

module.exports = { CDP };
