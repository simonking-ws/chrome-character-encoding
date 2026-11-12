/**
 * 通过调试管道（--remote-debugging-pipe）与 Chrome 通信的极简 CDP 客户端。
 *
 * 之所以用管道而不是端口：正式版 Chrome 从 137 起禁用了 --load-extension，
 * 只能改用 CDP 的 Extensions.loadUnpacked 接口加载未打包扩展，而该接口
 * 要求使用 --remote-debugging-pipe 搭配 --enable-unsafe-extension-debugging。
 *
 * 管道协议很简单：每条消息是一个以 \0 结尾的 JSON 文本，读端是 fd 3，
 * 写端是 fd 4。
 */
const fs = require('fs');

class PipeCDP {
  /**
   * @param {stream.Writable} writeStream 写入浏览器读取的管道（子进程的 fd 3）
   * @param {stream.Readable} readStream  从浏览器写出的管道读取（子进程的 fd 4）
   */
  constructor(writeStream, readStream) {
    this.writeStream = writeStream;
    this.readStream = readStream;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.buffer = '';

    this.readStream.setEncoding('utf8');
    this.readStream.on('data', (chunk) => this._onData(chunk));
    this.readStream.on('error', () => {});
  }

  _onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\0')) !== -1) {
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!raw) continue;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message + ' ' + (msg.error.data || '')));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const key = msg.sessionId ? msg.sessionId + ':' + msg.method : msg.method;
      const list = this.handlers.get(key) || this.handlers.get(msg.method);
      if (list) list.forEach((fn) => fn(msg.params, msg.sessionId));
    }
  }

  /** 监听事件 */
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  /** 发送命令 */
  send(method, params, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params: params || {} };
    if (sessionId) payload.sessionId = sessionId;
    this.writeStream.write(JSON.stringify(payload) + '\0');
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 命令超时: ' + method));
        }
      }, 30000);
    });
  }

  /** 在指定会话中求值 */
  async evaluate(expression, sessionId) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    }, sessionId);
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || 'JS 异常');
    }
    return res.result.value;
  }
}

module.exports = { PipeCDP };
