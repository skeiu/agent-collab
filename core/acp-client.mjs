// 本文件：ACP v1 客户端。基于 core/jsonrpc.mjs，支持 TCP 和 stdio 两种连接；ACP 方法或字段变化时更新。

import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import net from 'node:net';

import { JsonRpcConnectionError, JsonRpcPeer } from './jsonrpc.mjs';

/** ACP 协议版本（@agentclientprotocol/sdk 的 PROTOCOL_VERSION）。 */
export const ACP_PROTOCOL_VERSION = 1;

/** ACP 客户端错误。 */
export class AcpClientError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'AcpClientError';
    if (options.code !== undefined) this.code = options.code;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function waitChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

function waitSocketClose(socket, timeoutMs) {
  if (socket.destroyed) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      socket.off('close', onClose);
      resolve(false);
    }, timeoutMs);
    socket.once('close', onClose);
  });
}

/**
 * ACP v1 客户端。
 *
 * 事件：
 * - notification(method, params)：所有通知按到达顺序触发。
 * - sessionUpdate(params)：session/update 通知的便捷事件。
 * - permissionRequest(params)：收到 session/request_permission 时触发。
 * - close(error)：连接关闭时触发。
 */
export class AcpClient extends EventEmitter {
  constructor({ peer, transport, socket = null, child = null, permissionPolicy = 'deny', stderr = () => '' }) {
    super();
    if (!peer) throw new TypeError('peer is required');
    if (permissionPolicy !== 'deny' && permissionPolicy !== 'allow') {
      throw new TypeError('permissionPolicy must be "deny" or "allow"');
    }
    this.peer = peer;
    this.transport = transport;
    this.socket = socket;
    this.child = child;
    this.permissionPolicy = permissionPolicy;
    this.stderrText = stderr;
    this.closed = false;
    this.initializeResult = null;
    this.exitInfo = null;
    this._closing = null;

    peer.on('notification', (method, params) => {
      this.emit('notification', method, params);
      if (method === 'session/update') this.emit('sessionUpdate', params);
    });
    peer.on('notificationError', (error, message) => this.emit('notificationError', error, message));
    peer.on('close', (error) => {
      if (!this.closed) {
        this.closed = true;
        this.emit('close', error);
      }
    });
    peer.onRequest('session/request_permission', (params) => this._answerPermission(params));
  }

  /** 连接 ACP 代理。transport 可取 "tcp" 或 "stdio"；不传时按参数推断。 */
  static async connect(options = {}) {
    const transport = options.transport ?? (options.port !== undefined ? 'tcp' : options.command !== undefined ? 'stdio' : null);
    if (transport === 'tcp') return AcpClient.connectTcp(options);
    if (transport === 'stdio') return AcpClient.connectStdio(options);
    throw new TypeError('ACP connection requires transport "tcp" (host/port) or "stdio" (command)');
  }

  /** 连接 TCP 上的 ACP 代理。 */
  static async connectTcp(options = {}) {
    const host = options.host ?? '127.0.0.1';
    const port = options.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('port must be an integer between 1 and 65535');
    const socket = net.createConnection({ host, port });
    socket.setNoDelay(true);
    try {
      await once(socket, 'connect');
    } catch (error) {
      socket.destroy();
      throw new AcpClientError('failed to connect to ACP over TCP at ' + host + ':' + port, { cause: error });
    }
    const peer = new JsonRpcPeer({ readable: socket, writable: socket, name: 'acp-tcp' });
    return new AcpClient({
      peer,
      transport: 'tcp',
      socket,
      permissionPolicy: options.permissionPolicy ?? 'deny',
    });
  }

  /** 启动并连接 stdio 上的 ACP 代理子进程。 */
  static async connectStdio(options = {}) {
    const command = options.command;
    if (typeof command !== 'string' || !command) throw new TypeError('command is required for stdio transport');
    const args = Array.isArray(options.args) ? options.args : [];
    const env = options.env === undefined ? process.env : options.env;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
      if (options.onStderr) options.onStderr(chunk);
    });
    const peer = new JsonRpcPeer({ readable: child.stdout, writable: child.stdin, name: 'acp-stdio' });
    const client = new AcpClient({
      peer,
      transport: 'stdio',
      child,
      permissionPolicy: options.permissionPolicy ?? 'deny',
      stderr: () => stderr,
    });
    child.once('exit', (code, signal) => {
      client.exitInfo = { code, signal };
      peer.close('ACP process exited: code=' + code + ' signal=' + signal + (stderr ? '; stderr=' + stderr.slice(-1000) : ''));
    });
    child.once('error', (error) => {
      peer.close('ACP process error: ' + error.message);
    });
    try {
      await once(child, 'spawn');
    } catch (error) {
      peer.close('ACP process failed to spawn: ' + error.message);
      throw new AcpClientError('failed to spawn ACP process: ' + command, { cause: error });
    }
    return client;
  }

  /** ACP initialize。客户端固定声明不支持 fs 和 terminal。 */
  async initialize(params = {}) {
    const clientCapabilities = { ...(params.clientCapabilities ?? {}) };
    clientCapabilities.fs = { ...(clientCapabilities.fs ?? {}), readTextFile: false, writeTextFile: false };
    clientCapabilities.terminal = false;
    const request = {
      ...params,
      protocolVersion: params.protocolVersion ?? ACP_PROTOCOL_VERSION,
      clientCapabilities,
      clientInfo: params.clientInfo === undefined ? { name: 'agent-collab', version: '0.0.0' } : params.clientInfo,
    };
    const result = await this.request('initialize', request);
    this.initializeResult = result;
    return result;
  }

  /** ACP session/new。mcpServers 缺省为空数组。 */
  newSession(params = {}) {
    if (typeof params.cwd !== 'string' || !params.cwd) throw new TypeError('session/new requires cwd');
    return this.request('session/new', { ...params, mcpServers: params.mcpServers ?? [] });
  }

  /** ACP session/resume。 */
  resumeSession(params = {}) {
    if (typeof params.sessionId !== 'string' || !params.sessionId) throw new TypeError('session/resume requires sessionId');
    if (typeof params.cwd !== 'string' || !params.cwd) throw new TypeError('session/resume requires cwd');
    return this.request('session/resume', { ...params, mcpServers: params.mcpServers ?? [] });
  }

  /** ACP session/prompt。prompt 可以是字符串或 ContentBlock 数组。 */
  prompt(params = {}) {
    if (typeof params.sessionId !== 'string' || !params.sessionId) throw new TypeError('session/prompt requires sessionId');
    let prompt = params.prompt;
    if (typeof prompt === 'string') prompt = [{ type: 'text', text: prompt }];
    if (!Array.isArray(prompt)) throw new TypeError('session/prompt requires prompt as string or ContentBlock array');
    return this.request('session/prompt', { ...params, prompt });
  }

  /** ACP session/prompt 的便捷方法：直接发送一段文本。 */
  promptText(sessionId, text, options = {}) {
    return this.prompt({ sessionId, prompt: text, ...options });
  }

  /** ACP session/cancel（通知）。 */
  cancel(params = {}) {
    const request = typeof params === 'string' ? { sessionId: params } : params;
    if (typeof request.sessionId !== 'string' || !request.sessionId) throw new TypeError('session/cancel requires sessionId');
    this.notify('session/cancel', request);
  }

  /** ACP session/set_config_option。 */
  setConfigOption(params = {}) {
    if (typeof params.sessionId !== 'string' || !params.sessionId) throw new TypeError('session/set_config_option requires sessionId');
    if (typeof params.configId !== 'string' || !params.configId) throw new TypeError('session/set_config_option requires configId');
    return this.request('session/set_config_option', params);
  }

  /** ACP session/close。 */
  closeSession(params = {}) {
    const request = typeof params === 'string' ? { sessionId: params } : params;
    if (typeof request.sessionId !== 'string' || !request.sessionId) throw new TypeError('session/close requires sessionId');
    return this.request('session/close', request);
  }

  /** 通用请求（标准方法或以下划线开头的扩展方法）。 */
  request(method, params, options = {}) {
    return this.peer.request(method, params, options);
  }

  /** 通用通知（标准方法或以下划线开头的扩展方法）。 */
  notify(method, params) {
    this.peer.notify(method, params);
  }

  /** 扩展请求；方法名必须以 _ 开头。 */
  extensionRequest(method, params, options = {}) {
    if (typeof method !== 'string' || !method.startsWith('_')) throw new TypeError('extension method must start with "_"');
    return this.request(method, params, options);
  }

  /** 扩展通知；方法名必须以 _ 开头。 */
  extensionNotify(method, params) {
    if (typeof method !== 'string' || !method.startsWith('_')) throw new TypeError('extension method must start with "_"');
    this.notify(method, params);
  }

  /** 注册通知回调，返回取消函数。 */
  onNotification(handler) {
    this.on('notification', handler);
    return () => this.off('notification', handler);
  }

  /** 注册 session/update 回调，返回取消函数。 */
  onSessionUpdate(handler) {
    this.on('sessionUpdate', handler);
    return () => this.off('sessionUpdate', handler);
  }

  /** stdio 模式下子进程的 PID。 */
  get pid() {
    return this.child ? this.child.pid : null;
  }

  /** stdio 模式最近收到的 stderr。 */
  stderr() {
    return this.stderrText();
  }

  /** 断开连接；stdio 模式下按 PID 结束自己 spawn 的子进程。 */
  close() {
    if (this._closing) return this._closing;
    this._closing = this._doClose();
    return this._closing;
  }

  async _doClose() {
    if (!this.peer.closed) this.peer.close('ACP client closed');
    if (this.child) {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        try {
          this.child.stdin.end();
        } catch {
          // 子进程可能已经退出，忽略 EPIPE。
        }
        if (!await waitChildExit(this.child, 1000)) {
          try {
            this.child.kill('SIGTERM');
          } catch {
            // 已退出。
          }
          if (!await waitChildExit(this.child, 2000)) {
            try {
              this.child.kill('SIGKILL');
            } catch {
              // 已退出。
            }
            await waitChildExit(this.child, 1000);
          }
        }
      }
    } else if (this.socket) {
      this.socket.end();
      if (!await waitSocketClose(this.socket, 500)) this.socket.destroy();
    }
    this.closed = true;
  }

  _answerPermission(params) {
    this.emit('permissionRequest', params);
    const options = Array.isArray(params?.options) ? params.options : [];
    const allow = this.permissionPolicy === 'allow';
    const preferred = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
    let option = preferred.map((kind) => options.find((item) => item && item.kind === kind)).find(Boolean);
    if (!option) {
      option = options.find((item) => item && (allow ? String(item.kind).startsWith('allow') : String(item.kind).startsWith('reject')));
    }
    if (!option) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: option.optionId } };
  }
}

/** 连接 ACP 客户端的便捷函数。 */
export function connectAcpClient(options) {
  return AcpClient.connect(options);
}

export { JsonRpcConnectionError };
