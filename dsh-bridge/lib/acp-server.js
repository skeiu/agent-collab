// 本文件：桥接的 ACP 服务端（回环 TCP + 换行分隔 JSON-RPC）。把 dsh 会话事件映射成 ACP 通知；不直接访问 dsh 服务，只调用 dsh-api 导出的方法。

import { randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { JsonRpcError, JsonRpcPeer } from './jsonrpc.js';

export const PROTOCOL_VERSION = 1;
export const PROTOCOL_MIN = 1;

const MAX_FIELD_BYTES = 8 * 1024;
const UNAUTHORIZED = -32001;
const PROTOCOL_INCOMPATIBLE = -32002;
const SESSION_NOT_FOUND = -32003;
const SESSION_BUSY = -32004;
const PRESET_UNAVAILABLE = -32005;
const INVALID_PARAMS = -32602;

const PERMISSION_PRESETS = {
  'read-only': { sandbox: 'read-only', approval: 'ask' },
  'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
  'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
};

function rpcError(code, message, data) {
  return new JsonRpcError(code, message, data);
}

/** 按 UTF-8 字节截断，时间随输入长度线性增长；只在完整字符边界处切开。 */
export function truncateText(text, maxBytes = MAX_FIELD_BYTES) {
  if (typeof text !== 'string') return { text, truncated: false };
  const bytes = Buffer.from(text, 'utf8');
  const limit = Math.max(0, Math.floor(maxBytes));
  if (bytes.length <= limit) return { text, truncated: false };
  let end = limit;
  // UTF-8 的后续字节形如 10xxxxxx；退到字符起始字节，避免切出 U+FFFD。
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

function truncateFields(value) {
  if (typeof value === 'string') {
    const result = truncateText(value);
    return { value: result.text, truncated: result.truncated };
  }
  if (value === null || typeof value !== 'object') return { value, truncated: false };
  if (Array.isArray(value)) {
    let truncated = false;
    const items = value.map((item) => {
      const result = truncateFields(item);
      truncated = truncated || result.truncated;
      return result.value;
    });
    return { value: items, truncated };
  }
  let truncated = false;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      const result = truncateText(item);
      output[key] = result.text;
      truncated = truncated || result.truncated;
    } else {
      const result = truncateFields(item);
      output[key] = result.value;
      truncated = truncated || result.truncated;
    }
  }
  return { value: output, truncated };
}

function isoTime(time) {
  const value = Number.isFinite(time) ? time : Date.now();
  return new Date(value).toISOString();
}

function textBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => block && block.type === 'text' && typeof block.text === 'string');
}

function messageText(content) {
  return textBlocks(content).map((block) => block.text).join('');
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function parseToolArguments(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stripPresetEntry(document, id) {
  if (typeof document !== 'string') return null;
  const lines = document.split('\n');
  const output = [];
  let skipping = false;
  for (const line of lines) {
    if (/^- id: /.test(line)) skipping = line.trim() === '- id: ' + id;
    if (!skipping) output.push(line);
  }
  return output.join('\n').trim();
}

/** 一个桥接会话的运行状态：事件序号、等待中的审批/提问、本连接的消息和当前 prompt。 */
class SessionState {
  constructor(bridge, view) {
    this.bridge = bridge;
    this.view = view;
    this.sessionId = view.sessionId;
    this.conns = new Set();
    this.pendingApprovals = new Map();
    this.pendingQuestions = new Map();
    this.ownMessageIds = new Set();
    this.turnEnds = new Map();
    this.resolvedQuestionSeqs = new Set();
    this.seq = view.currentSeq();
    this.activePrompt = null;
    this.cancelRequested = false;
    this.lastTurnEnd = null;
    this.closed = false;
  }

  /** 扫描已有日志，重建待审批、待提问和历史 turn/end。 */
  scanHistory() {
    const length = this.view.currentSeq();
    for (let seq = 0; seq < length; seq += 1) {
      const event = this.view.readEvent(seq);
      if (event) this.observe(event, true);
    }
  }

  /** 更新状态并返回要发给客户端的通知。 */
  apply(event) {
    return this.observe(event, false);
  }

  observe(event, replayed) {
    this.seq = Math.max(this.seq, event.seq + 1);
    const data = event.data || {};
    let resolvedQuestion = false;
    switch (event.type) {
      case 'turn/start':
        if (this.activePrompt !== null && this.activePrompt.turn === null && event.seq >= this.activePrompt.startSeq) {
          this.activePrompt.turn = data.turn;
        }
        break;
      case 'turn/end': {
        const reason = data.reason || {};
        const stoppedBy = replayed
          ? null
          : reason.kind === 'aborted'
            ? (this.cancelRequested ? 'client' : 'human')
            : null;
        const end = {
          turn: data.turn,
          endReason: typeof reason.kind === 'string' ? reason.kind : null,
          stoppedBy,
          seq: event.seq,
        };
        this.turnEnds.set(data.turn, end);
        this.lastTurnEnd = end;
        this.cancelRequested = false;
        if (this.activePrompt !== null && this.activePrompt.turn === data.turn) {
          this.activePrompt.resolve(end);
          this.activePrompt = null;
        }
        break;
      }
      case 'approval/asked': {
        const approval = {
          approvalId: data.id,
          toolName: data.toolName ?? null,
          callId: data.callId ?? null,
          reason: data.reason ?? null,
        };
        this.pendingApprovals.set(data.id, approval);
        break;
      }
      case 'approval/decided':
        this.pendingApprovals.delete(data.id);
        break;
      case 'tool/call':
        if (data.name === 'ask_user_question') {
          const args = parseToolArguments(data.arguments);
          const questions = args && typeof args === 'object' && Array.isArray(args.questions) ? args.questions : [];
          this.pendingQuestions.set(data.callId, {
            callId: data.callId,
            questions: truncateFields(questions).value,
          });
        }
        break;
      case 'tool/result': {
        const callId = data.message && data.message.toolCallId;
        if (callId !== undefined) {
          resolvedQuestion = this.pendingQuestions.delete(callId);
          if (resolvedQuestion) this.resolvedQuestionSeqs.add(event.seq);
        }
        break;
      }
      default:
        break;
    }
    return this.project(event, { resolvedQuestion });
  }

  /** 把一条 dsh 会话事件映射成 ACP 通知；不修改状态。 */
  project(event, flags = {}) {
    const sessionId = this.sessionId;
    const data = event.data || {};
    const at = isoTime(event.time);
    let sub = 0;
    const meta = (extra) => ({
      agentCollab: {
        seq: event.seq,
        sub: sub++,
        at,
        ...(extra === undefined ? {} : extra),
      },
    });
    const update = (content, extra) => ({
      method: 'session/update',
      params: { sessionId, update: content, _meta: meta(extra) },
    });
    const status = (kind, fields) => ({
      method: '_agentCollab/status',
      params: { sessionId, kind, ...fields, _meta: meta() },
    });
    const notifications = [];

    switch (event.type) {
      case 'assistant/message': {
        const content = data.message && Array.isArray(data.message.content) ? data.message.content : [];
        for (const block of content) {
          if (!block || typeof block !== 'object') continue;
          if (block.type === 'reasoning' && typeof block.text === 'string' && block.text.length > 0) {
            notifications.push(update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: block.text } }));
          } else if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
            notifications.push(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: block.text } }));
          }
        }
        if (data.usage && typeof data.usage === 'object') {
          const usage = data.usage;
          notifications.push(status('usage', {
            usage: {
              input: Number.isFinite(usage.inputTokens) ? usage.inputTokens : null,
              output: Number.isFinite(usage.outputTokens) ? usage.outputTokens : null,
              cacheRead: Number.isFinite(usage.cacheReadTokens) ? usage.cacheReadTokens : null,
              cacheWrite: Number.isFinite(usage.cacheWriteTokens) ? usage.cacheWriteTokens : null,
            },
          }));
        }
        break;
      }
      case 'tool/call': {
        const parsed = truncateFields(parseToolArguments(data.arguments));
        const toolCall = {
          sessionUpdate: 'tool_call',
          toolCallId: data.callId,
          title: data.name,
          name: data.name,
          kind: 'other',
          status: 'in_progress',
          rawInput: parsed.value,
        };
        const notification = update(toolCall);
        if (parsed.truncated) notification.params.update.truncated = true;
        notifications.push(notification);
        if (data.name === 'ask_user_question') {
          const args = parseToolArguments(data.arguments);
          const questions = args && typeof args === 'object' && Array.isArray(args.questions) ? args.questions : [];
          notifications.push(status('question_pending', {
            callId: data.callId,
            questions: truncateFields(questions).value,
          }));
        }
        break;
      }
      case 'tool/result': {
        const message = data.message || {};
        const output = messageText(message.content);
        const truncated = truncateText(output);
        const result = {
          sessionUpdate: 'tool_call_update',
          toolCallId: message.toolCallId,
          status: message.isError === true ? 'failed' : 'completed',
          content: [{ type: 'content', content: { type: 'text', text: truncated.text } }],
          rawOutput: truncated.text,
        };
        const notification = update(result);
        if (truncated.truncated) notification.params.update.truncated = true;
        notifications.push(notification);
        const callId = message.toolCallId;
        if (callId !== undefined && (flags.resolvedQuestion === true || this.resolvedQuestionSeqs.has(event.seq))) {
          notifications.push(status('question_resolved', { callId }));
        }
        break;
      }
      case 'user/message': {
        if (!data.source || data.source.kind !== 'user') break;
        if (data.id !== undefined && this.ownMessageIds.has(data.id)) break;
        const blocks = textBlocks(data.content);
        for (const block of blocks) {
          notifications.push(update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: block.text } }, { source: 'dsh-web-human' }));
        }
        if (blocks.length === 0 && typeof data.content === 'string' && data.content.length > 0) {
          notifications.push(update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: data.content } }, { source: 'dsh-web-human' }));
        }
        break;
      }
      case 'turn/start':
        notifications.push(status('turn_start', {}));
        break;
      case 'turn/end': {
        const recorded = this.turnEnds.get(data.turn);
        const reason = data.reason || {};
        notifications.push(status('turn_end', {
          endReason: typeof reason.kind === 'string' ? reason.kind : null,
          stoppedBy: recorded ? recorded.stoppedBy : null,
        }));
        break;
      }
      case 'approval/asked':
        notifications.push(status('approval_pending', {
          approvalId: data.id,
          toolName: data.toolName ?? null,
          callId: data.callId ?? null,
          reason: data.reason ?? null,
        }));
        break;
      case 'approval/decided':
        notifications.push(status('approval_resolved', {
          approvalId: data.id,
          outcome: data.outcome ?? null,
        }));
        break;
      default:
        break;
    }
    return notifications;
  }
}

/** 一条客户端连接：JSON-RPC 对端、已接管的会话和有序发送队列。 */
class Connection {
  constructor(server, socket) {
    this.server = server;
    this.socket = socket;
    this.initialized = false;
    this.closed = false;
    this.sessions = new Set();
    this.queue = Promise.resolve();
    this.peer = new JsonRpcPeer({ readable: socket, writable: socket, name: 'acp-bridge-connection' });
    this.peer.on('close', () => this.onClose());
    this.registerHandlers();
  }

  enqueue(message) {
    if (this.closed) return this.queue;
    this.queue = this.queue.then(() => {
      if (this.closed) return;
      try {
        this.peer.notify(message.method, message.params);
      } catch {
        this.closed = true;
      }
    });
    return this.queue;
  }

  flush() {
    return this.queue;
  }

  onClose() {
    this.closed = true;
    for (const sessionId of [...this.sessions]) {
      const state = this.server.sessions.get(sessionId);
      if (state === undefined) continue;
      state.conns.delete(this);
      // 会话状态在桥接进程存活期间保留，断线后仍继续观察事件；只有显式 session/close 才丢弃。
      if (state.conns.size === 0 && state.closed && state.activePrompt === null) this.server.dropSession(sessionId);
    }
    this.sessions.clear();
  }

  requireInitialized() {
    if (this.initialized) return;
    const error = rpcError(UNAUTHORIZED, 'unauthorized: initialize required');
    this.server.rejectConnection(this);
    throw error;
  }

  registerHandlers() {
    const peer = this.peer;

    peer.onRequest('initialize', (params) => this.server.initialize(this, params));
    peer.onRequest('session/new', (params) => this.server.newSession(this, params));
    peer.onRequest('session/resume', (params) => this.server.resumeSession(this, params));
    peer.onRequest('session/prompt', (params) => this.server.prompt(this, params));
    peer.onRequest('session/set_config_option', (params) => this.server.setConfigOption(this, params));
    peer.onRequest('session/close', (params) => this.server.closeSession(this, params));
    peer.onRequest('_agentCollab/models', (params) => this.server.models(this, params));

    peer.onNotification('session/cancel', (params) => this.server.cancel(this, params));
  }
}

/** 桥接 ACP 服务：监听回环 TCP，接受多个客户端连接，按连接隔离通知。 */
export class AcpBridgeServer {
  constructor({ dsh, bridgeVersion, token, problem = null, logger = console }) {
    this.dsh = dsh;
    this.bridgeVersion = bridgeVersion;
    this.token = token;
    this.problem = problem;
    this.logger = logger;
    this.sessions = new Map();
    this.connections = new Set();
    this.pendingModelControls = new Map();
    this.server = null;
    this.agentPresetInfo = null;
    this.dsh.onSessionEvent((sessionId, event) => this.handleSessionEvent(sessionId, event));
    this.dsh.onAgentError((agentId, error) => this.handleAgentError(agentId, error));
  }

  async start() {
    this.server = net.createServer((socket) => {
      if (this.problem !== null) {
        socket.destroy();
        return;
      }
      socket.setNoDelay(true);
      const conn = new Connection(this, socket);
      this.connections.add(conn);
      socket.once('close', () => this.connections.delete(conn));
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  async stop() {
    for (const conn of [...this.connections]) {
      try {
        conn.socket.destroy();
      } catch {
        // 已关闭。
      }
    }
    this.connections.clear();
    this.sessions.clear();
    this.pendingModelControls.clear();
    if (this.server !== null) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => server.close(() => resolve()));
    }
  }

  rejectConnection(conn) {
    setTimeout(() => {
      try {
        conn.socket.end();
        conn.socket.destroy();
      } catch {
        // 已关闭。
      }
    }, 20);
  }

  handleSessionEvent(sessionId, event) {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return;
    const notifications = state.apply(event);
    for (const conn of [...state.conns]) {
      for (const notification of notifications) conn.enqueue(notification);
    }
  }

  handleAgentError(agentId, error) {
    if (typeof agentId !== 'string') return;
    const state = this.sessions.get(agentId);
    if (state === undefined) return;
    const message = error && typeof error.message === 'string' ? error.message : String(error);
    const status = {
      sessionId: state.sessionId,
      kind: 'error',
      message,
      ...error && typeof error.code === 'string' ? { code: error.code } : {},
      _meta: { agentCollab: { seq: null, sub: 0, at: new Date().toISOString() } },
    };
    for (const conn of [...state.conns]) conn.enqueue({ method: '_agentCollab/status', params: status });
  }

  /** 丢弃会话状态；只在 session/close 或桥接停止时调用。 */
  dropSession(sessionId) {
    this.sessions.delete(sessionId);
    this.pendingModelControls.delete(sessionId);
  }

  async ensureAgentPresetInfo() {
    if (this.agentPresetInfo !== null) return this.agentPresetInfo;
    let presets = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      presets = await this.dsh.listAgentPresets();
      if (presets !== null && presets.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const available = (presets ?? []).filter((preset) => preset && preset.broken === undefined).map((preset) => preset.id);
    const defaultPreset = available.includes('agent-collab') ? 'agent-collab' : 'standard';
    let agentCollabInSync = null;
    if (available.includes('agent-collab')) {
      const [agentDocument, standardDocument] = await Promise.all([
        this.dsh.readPresetDocument('agent-collab'),
        this.dsh.readPresetDocument('standard'),
      ]);
      if (typeof agentDocument === 'string' && typeof standardDocument === 'string') {
        const stripped = stripPresetEntry(standardDocument, 'tool-ask-user');
        agentCollabInSync = stripped !== null && stripped === agentDocument.trim();
      }
    }
    this.agentPresetInfo = { available, default: defaultPreset, agentCollabInSync };
    return this.agentPresetInfo;
  }

  async initialize(conn, params) {
    const meta = params && params._meta && params._meta.agentCollab;
    const providedToken = meta && meta.token;
    if (!sameToken(providedToken, this.token)) {
      conn.initialized = false;
      this.rejectConnection(conn);
      throw rpcError(UNAUTHORIZED, 'unauthorized: invalid token');
    }
    const clientProtocol = Number.isInteger(meta.protocol) ? meta.protocol : PROTOCOL_VERSION;
    const clientMin = Number.isInteger(meta.protocolMin) ? meta.protocolMin : clientProtocol;
    const protocol = Math.min(clientProtocol, PROTOCOL_VERSION);
    if (protocol < Math.max(clientMin, PROTOCOL_MIN)) {
      this.rejectConnection(conn);
      throw rpcError(PROTOCOL_INCOMPATIBLE, 'no common protocol version', {
        protocol: PROTOCOL_VERSION,
        protocolMin: PROTOCOL_MIN,
      });
    }
    conn.initialized = true;
    const info = await this.ensureAgentPresetInfo();
    const models = await this.dsh.listModels();
    const current = this.dsh.getDefaultModelSelection();
    const currentModel = models.find((item) => current && item.provider === current.provider && item.model === current.model);
    const image = currentModel !== undefined && Array.isArray(currentModel.inputModalities)
      ? currentModel.inputModalities.includes('image')
      : false;
    return {
      protocolVersion: protocol,
      agentCapabilities: {
        promptCapabilities: { image, audio: false, embeddedContext: false },
        sessionCapabilities: { resume: {}, close: {} },
      },
      agentInfo: { name: 'agent-collab-bridge', version: this.bridgeVersion },
      _meta: {
        agentCollab: {
          protocol,
          bridgeVersion: this.bridgeVersion,
          dshVersion: this.dsh.dshVersion,
          profile: this.dsh.profileName,
          agentPresets: info,
        },
      },
    };
  }

  async newSession(conn, params) {
    conn.requireInitialized();
    if (!params || typeof params !== 'object') throw rpcError(INVALID_PARAMS, 'session/new requires params');
    const meta = params._meta && params._meta.agentCollab;
    if (!meta || typeof meta !== 'object') throw rpcError(INVALID_PARAMS, 'session/new requires _meta.agentCollab');
    if (typeof meta.runId !== 'string' || meta.runId.length === 0) throw rpcError(INVALID_PARAMS, 'runId is required');
    if (typeof meta.title !== 'string' || meta.title.length === 0) throw rpcError(INVALID_PARAMS, 'title is required');
    const cwd = this.validateCwd(params.cwd);
    const env = this.validateEnv(meta.env);
    const permissionPreset = meta.permissionPreset ?? 'workspace-write';
    if (!Object.hasOwn(PERMISSION_PRESETS, permissionPreset)) {
      throw rpcError(INVALID_PARAMS, 'unknown permissionPreset: ' + String(permissionPreset));
    }

    const info = await this.ensureAgentPresetInfo();
    let requestedPreset;
    if (meta.agentPreset === undefined || meta.agentPreset === null) {
      requestedPreset = info.default;
    } else if (typeof meta.agentPreset === 'string') {
      if (!info.available.includes(meta.agentPreset)) {
        throw rpcError(PRESET_UNAVAILABLE, 'unknown agent preset: ' + meta.agentPreset);
      }
      requestedPreset = meta.agentPreset;
    } else {
      throw rpcError(INVALID_PARAMS, 'agentPreset must be a string or null');
    }

    const initialSelection = meta.model === null || meta.model === undefined
      ? this.dsh.getDefaultModelSelection()
      : this.validateModel(meta.model, meta.reasoningEffort);
    const modelControl = await this.dsh.createModelControl(initialSelection);
    const selection = modelControl.get() ?? initialSelection;
    const sessionId = randomUUID();

    const create = async (preset) => {
      let handle;
      try {
        handle = await this.dsh.createAgent({
          sessionId,
          meta: { cwd, agentPreset: preset },
          agentOptions: selection ?? undefined,
          setup: async (agentCtx, view) => {
            await this.dsh.mountAgentPreset(agentCtx, preset);
            modelControl.install(agentCtx);
            view.registerEnv(agentCtx, env);
            await view.applyPermission(PERMISSION_PRESETS[permissionPreset]);
          },
        });
      } catch (error) {
        throw error;
      }
      return handle;
    };

    let handle;
    let actualPreset = requestedPreset;
    let presetFallback = null;
    try {
      handle = await create(requestedPreset);
    } catch (error) {
      if (requestedPreset !== 'agent-collab') throw rpcError(-32603, 'failed to create session: ' + errorMessage(error));
      try {
        handle = await create('standard');
        actualPreset = 'standard';
        presetFallback = { from: 'agent-collab', reason: errorMessage(error) };
      } catch (fallbackError) {
        throw rpcError(-32603, 'failed to create session with agent-collab or standard: ' + errorMessage(fallbackError));
      }
    }

    const view = handle.view;
    await view.setTitle(meta.title);
    let workspaceId = null;
    if (meta.attachWorkspace !== false) {
      try {
        workspaceId = await this.dsh.attachWorkspace(cwd, meta.title, sessionId);
      } catch (error) {
        this.logger.warn('agent-collab bridge: attachWorkspace failed: ' + errorMessage(error));
      }
    }
    const state = new SessionState(this, view);
    state.scanHistory();
    this.sessions.set(sessionId, state);
    this.pendingModelControls.set(sessionId, modelControl);
    state.conns.add(conn);
    conn.sessions.add(sessionId);

    return {
      sessionId,
      configOptions: await this.buildConfigOptions(selection),
      _meta: {
        agentCollab: {
          agentPreset: actualPreset,
          presetFallback,
          permission: await view.permissionSnapshot(PERMISSION_PRESETS[permissionPreset]),
          workspaceId,
          model: selection,
          seq: view.currentSeq(),
        },
      },
    };
  }

  async resumeSession(conn, params) {
    conn.requireInitialized();
    if (!params || typeof params.sessionId !== 'string' || params.sessionId.length === 0) {
      throw rpcError(INVALID_PARAMS, 'session/resume requires sessionId');
    }
    const cwd = this.validateCwd(params.cwd);
    let view = this.dsh.getAgent(params.sessionId);
    const alreadyLoaded = view !== undefined;
    if (view === undefined) {
      try {
        const handle = await this.dsh.resumeAgent({
          resumeSessionId: params.sessionId,
          setup: async (agentCtx, resumedView) => {
            const preset = resumedView.agentPreset();
            if (typeof preset === 'string' && preset.length > 0) {
              try {
                await this.dsh.mountAgentPreset(agentCtx, preset);
              } catch {
                // 预设不可用时也允许恢复会话；工具可能不可用，由调用方从事件判断。
              }
            }
            const control = await this.dsh.createModelControl(
              selectionFromHeader(resumedView.readRequestHeader()) ?? this.dsh.getDefaultModelSelection(),
            );
            control.install(agentCtx);
            this.pendingModelControls.set(params.sessionId, control);
          },
        });
        view = handle.view;
      } catch (error) {
        throw rpcError(SESSION_NOT_FOUND, 'session not found or not resumable: ' + params.sessionId);
      }
    }
    const sessionCwd = view.cwd();
    if (typeof sessionCwd === 'string' && sessionCwd.length > 0 && sessionCwd !== cwd) {
      throw rpcError(INVALID_PARAMS, 'cwd does not match the session cwd');
    }

    let state = this.sessions.get(params.sessionId);
    if (state === undefined) {
      state = new SessionState(this, view);
      state.scanHistory();
      this.sessions.set(params.sessionId, state);
    }
    state.conns.add(conn);
    conn.sessions.add(params.sessionId);

    const sinceSeq = params._meta && params._meta.agentCollab && Number.isInteger(params._meta.agentCollab.sinceSeq)
      ? params._meta.agentCollab.sinceSeq
      : null;
    if (sinceSeq !== null) {
      const length = view.currentSeq();
      for (let seq = sinceSeq + 1; seq < length; seq += 1) {
        const event = view.readEvent(seq);
        if (!event) continue;
        for (const notification of state.project(event)) conn.enqueue(notification);
      }
    }
    await conn.flush();

    const selection = this.pendingModelControls.get(params.sessionId)?.get()
      ?? this.dsh.getDefaultModelSelection();
    return {
      configOptions: await this.buildConfigOptions(selection),
      _meta: {
        agentCollab: {
          alreadyLoaded,
          running: view.currentStatus() === 'running',
          seq: view.currentSeq(),
          pendingApprovals: [...state.pendingApprovals.values()],
          pendingQuestions: [...state.pendingQuestions.values()],
        },
      },
    };
  }

  async prompt(conn, params) {
    conn.requireInitialized();
    const state = this.stateFor(conn, params && params.sessionId);
    if (state.activePrompt !== null) throw rpcError(SESSION_BUSY, 'a prompt is already in flight for this session');
    const text = this.extractPrompt(params.prompt);
    if (state.view.currentStatus() === 'running') throw rpcError(SESSION_BUSY, 'session is already running');

    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'agent-collab-bridge' },
    };
    state.ownMessageIds.add(message.id);
    const startSeq = state.view.currentSeq();
    const completion = new Promise((resolve) => {
      state.activePrompt = { turn: null, startSeq, resolve };
    });
    try {
      state.view.submit(message);
    } catch (error) {
      state.activePrompt = null;
      throw rpcError(-32603, 'failed to queue prompt: ' + errorMessage(error));
    }
    const end = await completion;
    await state.view.waitIdle();
    while (await state.view.waitForChildren()) await state.view.waitIdle();
    await conn.flush();
    if (state.closed && state.conns.size === 0) this.dropSession(state.sessionId);
    return {
      stopReason: stopReasonFor(end),
      _meta: { agentCollab: { endReason: end ? end.endReason : null, stoppedBy: end ? end.stoppedBy : null } },
    };
  }

  async cancel(conn, params) {
    if (!conn.initialized) {
      this.rejectConnection(conn);
      return;
    }
    const sessionId = params && params.sessionId;
    const state = typeof sessionId === 'string' ? this.sessions.get(sessionId) : undefined;
    if (state === undefined || !state.conns.has(conn)) return;
    if (state.activePrompt !== null || state.view.currentStatus() === 'running') state.cancelRequested = true;
    try {
      state.view.stop({ kind: 'user' });
    } catch {
      // 已经空闲时取消是空操作。
    }
  }

  async setConfigOption(conn, params) {
    conn.requireInitialized();
    const state = this.stateFor(conn, params && params.sessionId);
    if (!params || typeof params.configId !== 'string') throw rpcError(INVALID_PARAMS, 'configId is required');
    const control = this.pendingModelControls.get(state.sessionId);
    const current = control && control.get() ? control.get() : this.dsh.getDefaultModelSelection();
    if (current === null) throw rpcError(-32603, 'this session has no model selection');
    let selection;
    if (params.configId === 'model') {
      if (typeof params.value !== 'string') throw rpcError(INVALID_PARAMS, 'model requires a select value');
      let pair;
      try {
        pair = JSON.parse(params.value);
      } catch {
        throw rpcError(INVALID_PARAMS, 'model value must be a JSON [provider, model] pair');
      }
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
        throw rpcError(INVALID_PARAMS, 'model value must be a JSON [provider, model] pair');
      }
      selection = { provider: pair[0], model: pair[1] };
    } else if (params.configId === 'reasoning_effort') {
      if (typeof params.value !== 'string') throw rpcError(INVALID_PARAMS, 'reasoning_effort requires a select value');
      selection = { provider: current.provider, model: current.model };
      if (params.value.length > 0) selection.reasoningEffort = params.value;
    } else {
      throw rpcError(INVALID_PARAMS, 'unsupported config option: ' + params.configId);
    }
    if (control) control.set(selection);
    this.pendingModelControls.set(state.sessionId, control);
    return { configOptions: await this.buildConfigOptions(selection) };
  }

  async closeSession(conn, params) {
    conn.requireInitialized();
    const sessionId = params && params.sessionId;
    if (typeof sessionId !== 'string') throw rpcError(INVALID_PARAMS, 'sessionId is required');
    const state = this.sessions.get(sessionId);
    if (state !== undefined) {
      state.conns.delete(conn);
      state.closed = true;
      if (state.conns.size === 0 && state.activePrompt === null) this.dropSession(sessionId);
    }
    conn.sessions.delete(sessionId);
    return {};
  }

  async models(conn) {
    conn.requireInitialized();
    const models = await this.dsh.listModels();
    return {
      models: models.map((item) => ({ provider: item.provider, model: item.model, displayName: item.displayName })),
      current: this.dsh.getDefaultModelSelection(),
    };
  }

  stateFor(conn, sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw rpcError(INVALID_PARAMS, 'sessionId is required');
    const state = this.sessions.get(sessionId);
    if (state === undefined || !state.conns.has(conn)) {
      throw rpcError(SESSION_NOT_FOUND, 'unknown session: ' + sessionId);
    }
    return state;
  }

  validateCwd(value) {
    if (typeof value !== 'string' || !value) throw rpcError(INVALID_PARAMS, 'cwd must be an absolute path');
    if (!path.isAbsolute(value)) throw rpcError(INVALID_PARAMS, 'cwd must be an absolute path');
    let real;
    try {
      real = fs.realpathSync(value);
    } catch {
      throw rpcError(INVALID_PARAMS, 'cwd does not exist: ' + value);
    }
    if (!fs.statSync(real).isDirectory()) throw rpcError(INVALID_PARAMS, 'cwd is not a directory: ' + value);
    return real;
  }

  validateEnv(value) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw rpcError(INVALID_PARAMS, 'env must be an object');
    const env = {};
    for (const [key, item] of Object.entries(value)) {
      if (!key.startsWith('DSH_')) throw rpcError(INVALID_PARAMS, 'env keys must start with DSH_: ' + key);
      if (typeof item !== 'string') throw rpcError(INVALID_PARAMS, 'env values must be strings: ' + key);
      env[key] = item;
    }
    return env;
  }

  validateModel(model, reasoningEffort) {
    if (!model || typeof model !== 'object' || typeof model.provider !== 'string' || typeof model.model !== 'string') {
      throw rpcError(INVALID_PARAMS, 'model requires provider and model');
    }
    if (reasoningEffort !== undefined && reasoningEffort !== null && typeof reasoningEffort !== 'string') {
      throw rpcError(INVALID_PARAMS, 'reasoningEffort must be a string or null');
    }
    return {
      provider: model.provider,
      model: model.model,
      ...typeof reasoningEffort === 'string' && reasoningEffort.length > 0 ? { reasoningEffort } : {},
    };
  }

  extractPrompt(prompt) {
    if (!Array.isArray(prompt)) throw rpcError(INVALID_PARAMS, 'prompt must be an array of content blocks');
    const texts = [];
    for (const block of prompt) {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') {
        throw rpcError(INVALID_PARAMS, 'only text prompt content is supported');
      }
      texts.push(block.text);
    }
    if (texts.length === 0) throw rpcError(INVALID_PARAMS, 'prompt must contain text');
    return texts.join('\n');
  }

  async buildConfigOptions(selection) {
    if (!selection) return [];
    const models = await this.dsh.listModels();
    const groups = new Map();
    for (const item of models) {
      if (!groups.has(item.provider)) groups.set(item.provider, { group: item.provider, name: item.provider, options: [] });
      groups.get(item.provider).options.push({
        value: JSON.stringify([item.provider, item.model]),
        name: item.displayName,
      });
    }
    const currentValue = JSON.stringify([selection.provider, selection.model]);
    if (![...groups.values()].some((group) => group.options.some((option) => option.value === currentValue))) {
      if (!groups.has(selection.provider)) groups.set(selection.provider, { group: selection.provider, name: selection.provider, options: [] });
      groups.get(selection.provider).options.unshift({ value: currentValue, name: selection.model });
    }
    const options = [{
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue,
      options: [...groups.values()].filter((group) => group.options.length > 0),
    }];
    const info = await this.dsh.resolveModelInfo(selection.provider, selection.model);
    if (info && info.reasoning) {
      options.push({
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        type: 'select',
        currentValue: typeof selection.reasoningEffort === 'string' ? selection.reasoningEffort : '',
        options: [
          { value: '', name: 'Provider default' },
          ...(Array.isArray(info.reasoning.efforts) ? info.reasoning.efforts.map((effort) => ({
            value: String(effort.id),
            name: effort.name ?? String(effort.id),
            ...effort.description === undefined ? {} : { description: effort.description },
          })) : []),
        ],
      });
    }
    return options;
  }
}

function selectionFromHeader(header) {
  const config = header && header.config;
  if (!config || typeof config.provider !== 'string' || typeof config.model !== 'string') return null;
  return {
    provider: config.provider,
    model: config.model,
    ...typeof config.reasoningEffort === 'string' && config.reasoningEffort.length > 0
      ? { reasoningEffort: config.reasoningEffort }
      : {},
  };
}

function stopReasonFor(end) {
  if (!end) return 'end_turn';
  switch (end.endReason) {
    case 'max-tokens': return 'max_tokens';
    case 'aborted':
    case 'interrupted': return 'cancelled';
    default: return 'end_turn';
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
