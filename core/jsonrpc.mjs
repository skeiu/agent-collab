// 本文件：换行分隔的 JSON-RPC 2.0 对端实现。acp-client 和测试用假的 ACP 代理共用；协议细节变化时更新。

import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

/** JSON-RPC 2.0 标准错误码。 */
export const JSON_RPC_ERRORS = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
});

/** 带 JSON-RPC 错误码的错误。 */
export class JsonRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** 对端连接关闭时，未完成请求收到的错误。 */
export class JsonRpcConnectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JsonRpcConnectionError';
    this.code = 'JSONRPC_CONNECTION_CLOSED';
  }
}

/** 单行超过 maxLineBytes 时用于关闭连接的错误。 */
export class JsonRpcLineTooLongError extends Error {
  constructor(maxLineBytes) {
    super('JSON-RPC line exceeds ' + maxLineBytes + ' bytes');
    this.name = 'JsonRpcLineTooLongError';
    this.code = 'JSONRPC_LINE_TOO_LONG';
    this.maxLineBytes = maxLineBytes;
  }
}

/** 请求超过调用方给的 timeoutMs 时收到的错误。 */
export class JsonRpcTimeoutError extends Error {
  constructor(method, timeoutMs) {
    super('JSON-RPC request timed out after ' + timeoutMs + 'ms: ' + method);
    this.name = 'JsonRpcTimeoutError';
    this.code = 'JSONRPC_TIMEOUT';
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorPayload(error) {
  if (error instanceof JsonRpcError || (error && Number.isInteger(error.code))) {
    const payload = { code: error.code, message: String(error.message || 'JSON-RPC error') };
    if (error.data !== undefined) payload.data = error.data;
    return payload;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: JSON_RPC_ERRORS.INTERNAL_ERROR, message };
}

/**
 * 一对可读、可写流上的 JSON-RPC 2.0 对端。
 *
 * 事件：
 * - notification(method, params)：收到任意通知后触发。
 * - notificationError(error, message)：通知处理函数抛错时触发。
 * - close(error?)：对端关闭时触发。
 */
export class JsonRpcPeer extends EventEmitter {
  constructor({ readable, writable, input, output, name = 'jsonrpc', maxLineBytes = 16 * 1024 * 1024 } = {}) {
    super();
    readable = readable ?? input;
    writable = writable ?? output;
    if (!readable || typeof readable.on !== 'function') throw new TypeError('readable stream is required');
    if (!writable || typeof writable.write !== 'function') throw new TypeError('writable stream is required');
    if (!Number.isInteger(maxLineBytes) || maxLineBytes < 1) throw new TypeError('maxLineBytes must be a positive integer');
    this.name = name;
    this.readable = readable;
    this.writable = writable;
    this.closed = false;
    this.buffer = '';
    this.bufferBytes = 0;
    this.maxLineBytes = maxLineBytes;
    this.decoder = new StringDecoder('utf8');
    this.nextId = 1;
    this.pending = new Map();
    this.requestHandlers = new Map();
    this.notificationHandlers = new Map();

    this._onData = (chunk) => this._handleData(chunk);
    this._onEnd = () => this._shutdown(new JsonRpcConnectionError('JSON-RPC peer closed'));
    this._onError = (error) => this._shutdown(error instanceof Error ? error : new JsonRpcConnectionError(String(error)));
    this._onWritableError = (error) => this._shutdown(error instanceof Error ? error : new JsonRpcConnectionError(String(error)));
    this._onWritableClose = () => this._shutdown(new JsonRpcConnectionError('JSON-RPC writable closed'));

    readable.on('data', this._onData);
    readable.on('end', this._onEnd);
    readable.on('close', this._onEnd);
    readable.on('error', this._onError);
    writable.on('error', this._onWritableError);
    writable.on('close', this._onWritableClose);
  }

  /** 发送请求，按 id 匹配响应。 */
  request(method, params, options = {}) {
    if (this.closed) return Promise.reject(new JsonRpcConnectionError('JSON-RPC peer is closed'));
    const id = this.nextId++;
    const timeoutMs = Number(options.timeoutMs);
    return new Promise((resolve, reject) => {
      let timer;
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new JsonRpcTimeoutError(method, timeoutMs));
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
      this.pending.set(id, { resolve, reject, timer, method });
      this._write({ jsonrpc: '2.0', id, method, params: params === undefined ? undefined : params });
    });
  }

  /** 发送通知。 */
  notify(method, params) {
    if (this.closed) throw new JsonRpcConnectionError('JSON-RPC peer is closed');
    this._write({ jsonrpc: '2.0', method, params: params === undefined ? undefined : params });
  }

  /** 注册收到的请求处理函数；同一个方法名后注册的覆盖先注册的。 */
  onRequest(method, handler) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    this.requestHandlers.set(method, handler);
    return () => {
      if (this.requestHandlers.get(method) === handler) this.requestHandlers.delete(method);
    };
  }

  /** 注册收到的通知处理函数。 */
  onNotification(method, handler) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    this.notificationHandlers.set(method, handler);
    return () => {
      if (this.notificationHandlers.get(method) === handler) this.notificationHandlers.delete(method);
    };
  }

  /** 停止处理，拒绝所有未完成请求；不主动关闭底层流。 */
  close(reason = 'JSON-RPC peer closed by caller') {
    this._shutdown(new JsonRpcConnectionError(reason));
  }

  _write(message) {
    if (this.closed) return;
    let line;
    try {
      line = JSON.stringify(message) + '\n';
    } catch (error) {
      this._shutdown(error);
      return;
    }
    try {
      this.writable.write(line);
    } catch (error) {
      this._shutdown(error);
    }
  }

  _handleData(chunk) {
    if (this.closed) return;
    let text;
    if (typeof chunk === 'string') text = chunk;
    else text = this.decoder.write(chunk);
    if (!text) return;
    this.buffer += text;
    this.bufferBytes += Buffer.byteLength(text, 'utf8');
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const rawLine = this.buffer.slice(0, newline);
      const line = rawLine.replace(/\r$/, '');
      const consumed = rawLine + '\n';
      this.buffer = this.buffer.slice(newline + 1);
      this.bufferBytes -= Buffer.byteLength(consumed, 'utf8');
      if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) {
        this._failLineTooLong();
        return;
      }
      this._handleLine(line);
    }
    if (this.bufferBytes > this.maxLineBytes) this._failLineTooLong();
  }

  _failLineTooLong() {
    if (this.closed) return;
    this.buffer = '';
    this.bufferBytes = 0;
    this._shutdown(new JsonRpcLineTooLongError(this.maxLineBytes));
  }

  _handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this._write({ jsonrpc: '2.0', id: null, error: { code: JSON_RPC_ERRORS.PARSE_ERROR, message: 'Parse error' } });
      return;
    }
    this._handleMessage(message);
  }

  _handleMessage(message) {
    if (Array.isArray(message)) {
      this._write({ jsonrpc: '2.0', id: null, error: { code: JSON_RPC_ERRORS.INVALID_REQUEST, message: 'Batch requests are not supported' } });
      return;
    }
    if (!isPlainObject(message)) {
      this._write({ jsonrpc: '2.0', id: null, error: { code: JSON_RPC_ERRORS.INVALID_REQUEST, message: 'Invalid request' } });
      return;
    }
    if (typeof message.method === 'string') {
      if (Object.prototype.hasOwnProperty.call(message, 'id')) {
        this._handleRequest(message);
      } else {
        this._handleNotification(message);
      }
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, 'id')) this._handleResponse(message);
  }

  _handleNotification(message) {
    const handler = this.notificationHandlers.get(message.method);
    if (handler) {
      try {
        const result = handler(message.params, { method: message.method, raw: message });
        if (result && typeof result.then === 'function') {
          result.catch((error) => this.emit('notificationError', error, message));
        }
      } catch (error) {
        this.emit('notificationError', error, message);
      }
    }
    this.emit('notification', message.method, message.params);
  }

  async _handleRequest(message) {
    const handler = this.requestHandlers.get(message.method);
    if (!handler) {
      this._write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: JSON_RPC_ERRORS.METHOD_NOT_FOUND, message: 'Method not found: ' + message.method },
      });
      return;
    }
    try {
      const result = await handler(message.params, { method: message.method, id: message.id, raw: message });
      this._write({ jsonrpc: '2.0', id: message.id, result: result === undefined ? null : result });
    } catch (error) {
      this._write({ jsonrpc: '2.0', id: message.id, error: errorPayload(error) });
    }
  }

  _handleResponse(message) {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (entry.timer) clearTimeout(entry.timer);
    if (message.error !== undefined) {
      const error = message.error && typeof message.error === 'object' ? message.error : {};
      entry.reject(new JsonRpcError(Number.isInteger(error.code) ? error.code : JSON_RPC_ERRORS.INTERNAL_ERROR, error.message || 'JSON-RPC error', error.data));
    } else {
      entry.resolve(message.result);
    }
  }

  _shutdown(error) {
    if (this.closed) return;
    this.closed = true;
    this.readable.off('data', this._onData);
    this.readable.off('end', this._onEnd);
    this.readable.off('close', this._onEnd);
    this.writable.off('close', this._onWritableClose);
    // error 监听要保留：关闭之后底层流还会报错（断线时的 ECONNRESET、EPIPE，macOS 上还有 EPROTOTYPE），
    // 没有监听器时 Node 把它当成未捕获异常，工作进程直接退出、来不及写终态（run wait 只会记成 worker_lost）。
    // _onError / _onWritableError 只调用 _shutdown，关闭后第一行就返回，不会重复处理。
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error instanceof Error ? error : new JsonRpcConnectionError(String(error)));
    }
    this.emit('close', error);
  }
}

/** 创建 JSON-RPC 对端的便捷函数。 */
export function createJsonRpcPeer(options) {
  return new JsonRpcPeer(options);
}
