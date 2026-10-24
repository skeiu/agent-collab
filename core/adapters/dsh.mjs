// 本文件：dsh 执行端适配器（桥接、自动启动 Web、acp 退回和覆盖层）。接口见 docs/protocol.md 第 3 节，连接顺序见 PLAN.md §11.5。
// acp 覆盖层的 YAML 只借用 dsh 安装目录自带的 js-yaml（保留 !!js 标签）；找不到或接口不对时 acp 模式不可用。

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { AcpClient } from '../acp-client.mjs';
import {
  SUPPORTED_PROTOCOL,
  SUPPORTED_PROTOCOL_MIN,
  detectDsh,
  probeLoginShellEnv,
  readDiscoveryFile,
} from '../detect.mjs';
import { compareCursor } from '../events.mjs';
import { ensurePrivateDir, isPidAlive, resolveAgentCollabHome, writePrivateFile } from '../platform.mjs';

const rootDir = fileURLToPath(new URL('../..', import.meta.url));
const packageManifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envNumber(env, name, fallback) {
  const raw = env && env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function resolveDshHomeSync({ configHome, env }) {
  if (typeof configHome === 'string' && configHome.trim() !== '') return path.resolve(configHome);
  if (env && typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '') return path.resolve(env.DSH_HOME);
  return path.join(os.homedir(), '.dsh');
}

function normalizeTitle(runId, title) {
  return '[collab] ' + String(runId) + (title ? ' ' + String(title) : '');
}

function isDsEnvKey(key) {
  return typeof key === 'string' && key.startsWith('DSH_');
}

/** 把配置里的 model（字符串或 { provider, model }）转成桥接/ACP 用的对象。 */
export function normalizeModel(value) {
  if (value === null || value === undefined) return { model: null, warning: null };
  if (typeof value === 'string') {
    const slash = value.indexOf('/');
    if (slash <= 0 || slash === value.length - 1) {
      return { model: null, warning: '模型 ' + JSON.stringify(value) + ' 拆不开服务商和模型（需要“服务商/模型”），跟随 dsh 的设置' };
    }
    return { model: { provider: value.slice(0, slash), model: value.slice(slash + 1) }, warning: null };
  }
  if (typeof value === 'object' && !Array.isArray(value) && typeof value.provider === 'string' && typeof value.model === 'string') {
    return { model: { provider: value.provider, model: value.model }, warning: null };
  }
  return { model: null, warning: '模型配置格式不对，跟随 dsh 的设置' };
}

/** reasoningEffort 映射：follow 为 null；其余档位保持 dsh 的同名档位。 */
export function mapReasoningEffort(value) {
  if (value === null || value === undefined || value === 'follow') return { value: null, warning: null };
  if (['low', 'medium', 'high', 'max'].includes(value)) return { value, warning: null };
  return { value: null, warning: '未知的思考强度 ' + JSON.stringify(value) + '，跟随 dsh 的设置' };
}

function stopReasonFromEndReason(endReason) {
  if (endReason === 'max-tokens') return 'max_tokens';
  if (endReason === 'aborted' || endReason === 'interrupted') return 'cancelled';
  return 'end_turn';
}

function endReasonFromStopReason(stopReason) {
  switch (stopReason) {
    case 'max_tokens': return 'max-tokens';
    case 'cancelled': return 'aborted';
    case 'refusal': return 'blocked';
    case 'max_turn_requests': return 'error';
    default: return 'completed';
  }
}

function cursorOf(params) {
  const meta = params && params._meta && params._meta.agentCollab;
  if (!meta || !Number.isInteger(meta.seq)) return undefined;
  return { seq: meta.seq, sub: Number.isInteger(meta.sub) ? meta.sub : 0 };
}

function textFromToolContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const item of content) {
    if (item && item.type === 'content' && item.content && item.content.type === 'text') parts.push(item.content.text);
    else if (item && item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
  }
  return parts.join('');
}

function turnFinalText(events) {
  const texts = [];
  for (const event of events) {
    if (event.type === 'text') texts.push(String(event.text ?? ''));
    else if (event.type === 'tool_call') texts.length = 0;
  }
  return texts.join('');
}

/** 纯函数：从解析后的 cordis.patch.yml 顶层列表里挑出覆盖层条目。 */
export function selectOverlayEntries(entries, model) {
  if (!Array.isArray(entries)) throw new TypeError('cordis.patch.yml 顶层必须是 YAML 数组');
  const selected = entries.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.id === 'string'
    && (entry.id.startsWith('llm-') || entry.id === 'agent-default-model'));
  let provider = null;
  let modelId = null;
  let warning = null;
  if (model && typeof model === 'object' && typeof model.provider === 'string' && typeof model.model === 'string') {
    provider = model.provider;
    modelId = model.model;
  } else {
    const defaults = selected.find((entry) => entry.id === 'agent-default-model');
    const config = defaults && defaults.config;
    if (config && typeof config.provider === 'string' && typeof config.model === 'string') {
      provider = config.provider;
      modelId = config.model;
    } else {
      warning = 'web profile 的 cordis.patch.yml 里没有可用的 agent-default-model，覆盖层不设置 acp 默认模型';
    }
  }
  const result = selected.map((entry) => structuredClone(entry));
  if (provider && modelId) result.push({ id: 'acp', config: { provider, model: modelId } });
  return { entries: result, acpModel: provider && modelId ? { provider, model: modelId } : null, warning };
}

function overlayYamlUnavailable(message) {
  const error = new Error(message + '，acp 模式不可用');
  error.code = 'overlay_yaml_unavailable';
  return error;
}

/** 按 Node 的 node_modules 查找顺序列出候选，只查 dsh 安装目录及其祖先，不去找 Node 的全局路径。 */
function jsYamlCandidates(packageDir) {
  const candidates = [];
  let current = packageDir;
  for (;;) {
    candidates.push(path.basename(current) === 'node_modules' ? path.join(current, 'js-yaml') : path.join(current, 'node_modules', 'js-yaml'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return candidates;
}

/** 只从 dsh 包目录解析 js-yaml，并带上能保留 !!js 标签的 schema。 */
async function loadYamlLibrary(packageDir) {
  let resolved = null;
  for (const candidate of jsYamlCandidates(packageDir)) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      resolved = candidate;
      break;
    }
  }
  if (!resolved) throw overlayYamlUnavailable('dsh 安装目录里找不到 js-yaml');
  let api;
  try {
    const require = createRequire(path.join(packageDir, 'package.json'));
    const module = require(resolved);
    api = module && module.default && module.default.load ? module.default : module;
  } catch (error) {
    const wrapped = overlayYamlUnavailable('dsh 安装目录里的 js-yaml 加载不了（' + (error && error.message ? error.message : String(error)) + '）');
    wrapped.cause = error;
    throw wrapped;
  }
  if (!api || typeof api.load !== 'function' || typeof api.dump !== 'function' || typeof api.Type !== 'function'
    || !api.JSON_SCHEMA || typeof api.JSON_SCHEMA.extend !== 'function') {
    throw overlayYamlUnavailable('dsh 安装目录里的 js-yaml 接口不对');
  }
  try {
    return { name: 'js-yaml', api, schema: makeJsExprSchema(api) };
  } catch (error) {
    const wrapped = overlayYamlUnavailable('dsh 安装目录里的 js-yaml 无法构造 !!js 类型（' + (error && error.message ? error.message : String(error)) + '）');
    wrapped.cause = error;
    throw wrapped;
  }
}

function makeJsExprSchema(api) {
  const JsExpr = new api.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
    predicate: (data) => Boolean(data && typeof data === 'object' && typeof data.__jsExpr === 'string'),
    represent: (data) => data.__jsExpr,
  });
  return api.JSON_SCHEMA.extend(JsExpr);
}

function parseYaml(api, schema, text) {
  return api.load(text, { schema });
}

function dumpYaml(api, schema, value) {
  return api.dump(value, { schema, lineWidth: -1, noRefs: true });
}

/** 读 web profile 用户层，生成 acp 覆盖层；返回 { file, dir, entries, warning, yaml }。失败时不留下覆盖层目录。 */
export async function buildAcpOverlay({ dshInfo, model, env = process.env }) {
  const profile = dshInfo.profile ?? 'web';
  const patchFile = path.join(dshInfo.home.home, 'profiles', profile, 'cordis.patch.yml');
  let text = '';
  try {
    text = await fsp.readFile(patchFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const packageDir = dshInfo.package ? dshInfo.package.dir : null;
  let yaml = null;
  const yamlLibrary = async () => {
    if (yaml) return yaml;
    if (!packageDir) throw overlayYamlUnavailable('找不到 dsh 包目录，无法读取 js-yaml');
    yaml = await loadYamlLibrary(packageDir);
    return yaml;
  };
  const header = '# generated by agent-collab for dsh --profile acp; do not edit\n';
  let entries;
  let warning;
  let body;
  if (text.trim() !== '') {
    const library = await yamlLibrary();
    const parsed = parseYaml(library.api, library.schema, text);
    const selected = selectOverlayEntries(parsed, model);
    entries = selected.entries;
    warning = selected.warning;
    body = header + dumpYaml(library.api, library.schema, entries) + '\n';
  } else {
    const selected = selectOverlayEntries([], model);
    entries = selected.entries;
    warning = selected.warning;
    if (entries.length > 0) {
      const library = await yamlLibrary();
      body = header + dumpYaml(library.api, library.schema, entries) + '\n';
    } else {
      body = header + '[]\n';
    }
  }
  const dir = path.join(resolveAgentCollabHome(env), 'overlays', 'dsh-acp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex'));
  const file = path.join(dir, 'cordis.patch.yml');
  try {
    await ensurePrivateDir(dir);
    await writePrivateFile(file, body);
  } catch (error) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { dir, file, entries, warning, patchFile, yaml: yaml ? yaml.name : null };
}

function permissionOutcome(params, policy) {
  const options = Array.isArray(params && params.options) ? params.options : [];
  const allow = policy === 'allow';
  const preferred = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  let option = preferred.map((kind) => options.find((item) => item && item.kind === kind)).find(Boolean);
  if (!option) option = options.find((item) => item && (allow ? String(item.kind).startsWith('allow') : String(item.kind).startsWith('reject')));
  if (!option) return 'cancelled';
  return option.kind === 'allow_once' || option.kind === 'allow_always' ? 'allowed-once' : 'rejected';
}

function unifyNotification(method, params) {
  if (method === 'session/update') {
    const update = params && params.update;
    if (!update) return null;
    const cursor = cursorOf(params);
    const base = cursor === undefined ? {} : { cursor };
    switch (update.sessionUpdate) {
      case 'agent_thought_chunk': return { type: 'thinking', text: update.content?.text ?? '', ...base };
      case 'agent_message_chunk': return { type: 'text', text: update.content?.text ?? '', ...base };
      case 'tool_call': return { type: 'tool_call', callId: update.toolCallId ?? null, name: update.name ?? update.title ?? null, input: update.rawInput ?? null, ...base };
      case 'tool_call_update': return { type: 'tool_result', callId: update.toolCallId ?? null, ok: update.status === 'completed', output: update.rawOutput ?? textFromToolContent(update.content), ...base };
      case 'user_message_chunk': return { type: 'human_message', text: update.content?.text ?? '', source: params._meta?.agentCollab?.source ?? null, ...base };
      case 'usage_update': return { type: 'usage', input: Number.isFinite(update.used) ? update.used : null, output: null, cacheRead: null, cacheWrite: null, ...base };
      default: return null;
    }
  }
  if (method !== '_agentCollab/status') return null;
  const cursor = cursorOf(params);
  const base = cursor === undefined ? {} : { cursor };
  switch (params && params.kind) {
    case 'usage': return { type: 'usage', input: params.usage?.input ?? null, output: params.usage?.output ?? null, cacheRead: params.usage?.cacheRead ?? null, cacheWrite: params.usage?.cacheWrite ?? null, ...base };
    case 'turn_end': return { type: 'turn_end', stopReason: stopReasonFromEndReason(params.endReason ?? null), endReason: params.endReason ?? null, stoppedBy: params.stoppedBy ?? null, ...base };
    case 'approval_pending': return { type: 'approval', state: 'pending', approvalId: params.approvalId ?? null, toolName: params.toolName ?? null, callId: params.callId ?? null, reason: params.reason ?? null, ...base };
    case 'approval_resolved': return { type: 'approval', state: 'resolved', approvalId: params.approvalId ?? null, toolName: null, callId: null, reason: null, outcome: params.outcome ?? null, ...base };
    case 'question_pending': return { type: 'question', state: 'pending', callId: params.callId ?? null, questions: params.questions ?? [], ...base };
    case 'question_resolved': return { type: 'question', state: 'resolved', callId: params.callId ?? null, questions: null, ...base };
    case 'error': return { type: 'error', message: String(params.message ?? 'dsh 报错'), fatal: false, ...base };
    default: return null;
  }
}

/** dsh 适配器。 */
export function createAdapter({ config, onEvent, log = () => {}, env = process.env, state = null }) {
  const warnings = [];
  let current = null;
  let lastInfo = null;
  let overlay = null;
  let lastTransport = state && state.executor ? state.executor.transport ?? null : null;
  let images = false;
  let closed = false;
  let cwd = state && state.repoRoot ? state.repoRoot : null;
  let currentTurn = null;
  let cancelSent = false;
  let webChild = null;
  let webLogFile = null;
  let currentPolicy = 'deny';
  let replayFilter = null;

  function emit(event) {
    try {
      onEvent(event);
    } catch (error) {
      log('适配器事件回调失败：' + (error && error.message ? error.message : String(error)));
    }
  }

  function warn(message) {
    warnings.push(String(message));
    emit({ type: 'warning', message: String(message) });
  }

  function transportChanged(next) {
    if (lastTransport && next && lastTransport !== next) {
      warn('连接方式由 ' + lastTransport + ' 变为 ' + next + '（不沿用上一次的选择）');
    }
    lastTransport = next;
  }

  function allowForward(cursor) {
    if (!replayFilter) return true;
    const order = compareCursor(cursor, replayFilter.sinceCursor);
    if (order === null) return true;
    return order > 0;
  }

  function handleNotification(method, params) {
    if (currentTurn && method === '_agentCollab/status' && params && params.kind === 'turn_start') {
      currentTurn.events.length = 0;
      currentTurn.end = null;
    }
    const event = unifyNotification(method, params);
    if (event) {
      if (currentTurn) currentTurn.events.push(event);
      if (allowForward(event.cursor)) emit(event);
      if (event.type === 'turn_end' && currentTurn) {
        currentTurn.end = { endReason: event.endReason, stoppedBy: event.stoppedBy, stopReason: event.stopReason };
        if (currentTurn.resolveTurn) {
          const resolve = currentTurn.resolveTurn;
          currentTurn.resolveTurn = null;
          resolve();
        }
      }
    }
  }

  function attachClientHandlers(client) {
    client.on('close', (error) => {
      if (closed) return;
      const message = 'dsh 连接断开：' + (error && error.message ? error.message : '连接关闭');
      log(message);
      // S2 留下的要求：JsonRpcPeer 只发 close，不回收底层 socket 或子进程。
      void client.close().catch(() => {});
      if (currentTurn) {
        const turn = currentTurn;
        currentTurn = null;
        turn.reject(Object.assign(new Error(message), { code: 'dsh_disconnected' }));
      }
    });
    client.on('notification', (method, params) => {
      try {
        handleNotification(method, params);
      } catch (error) {
        log('处理通知失败：' + (error && error.message ? error.message : String(error)));
      }
    });
    client.on('permissionRequest', (params) => {
      const approvalId = params && params.toolCall && params.toolCall.toolCallId ? params.toolCall.toolCallId : null;
      emit({ type: 'approval', state: 'pending', approvalId, toolName: null, callId: approvalId, reason: null });
      emit({
        type: 'approval',
        state: 'resolved',
        approvalId,
        toolName: null,
        callId: approvalId,
        reason: null,
        outcome: permissionOutcome(params, currentPolicy),
      });
    });
  }

  function createTurn() {
    let reject = null;
    const guard = new Promise((resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    return { events: [], end: null, resolveTurn: null, reject, guard };
  }

  function buildResult(turn) {
    const end = turn.end ?? {};
    const stoppedBy = end.stoppedBy ?? (cancelSent ? 'client' : null);
    const endReason = end.endReason ?? null;
    return {
      stopReason: end.stopReason ?? stopReasonFromEndReason(endReason),
      endReason,
      stoppedBy,
      finalText: turnFinalText(turn.events),
    };
  }

  function makeTurn(client, sessionId, promptText) {
    const turn = createTurn();
    currentTurn = turn;
    const promptPromise = client.promptText(sessionId, promptText).then((response) => {
      const meta = response && response._meta && response._meta.agentCollab ? response._meta.agentCollab : {};
      if (meta.endReason !== undefined && meta.endReason !== null) turn.end = { ...(turn.end ?? {}), endReason: meta.endReason };
      if (meta.stoppedBy !== undefined) turn.end = { ...(turn.end ?? {}), stoppedBy: meta.stoppedBy };
      if (currentTurn === turn) currentTurn = null;
      const result = buildResult(turn);
      if (response && typeof response.stopReason === 'string') {
        result.stopReason = response.stopReason;
        if (result.endReason === null) result.endReason = endReasonFromStopReason(response.stopReason);
      }
      return result;
    }, (error) => {
      if (currentTurn === turn) currentTurn = null;
      throw error;
    });
    return { promise: Promise.race([promptPromise, turn.guard]), reject: turn.reject };
  }

  function makeAttachTurn() {
    const turn = createTurn();
    currentTurn = turn;
    turn.promise = new Promise((resolve) => {
      turn.resolveTurn = () => resolve(buildResult(turn));
    });
    return turn;
  }

  async function getDshInfo() {
    lastInfo = await detectDsh({ config, env: process.env, cwd: cwd ?? process.cwd() });
    return lastInfo;
  }

  async function connectBridge(discovery) {
    let client = null;
    try {
      client = await AcpClient.connectTcp({ host: discovery.record.host, port: discovery.record.port, permissionPolicy: currentPolicy });
      attachClientHandlers(client);
      const init = await client.initialize({
        clientInfo: { name: 'agent-collab', version: packageManifest.version },
        _meta: {
          agentCollab: {
            token: discovery.record.token,
            protocol: SUPPORTED_PROTOCOL,
            protocolMin: SUPPORTED_PROTOCOL_MIN,
            clientVersion: packageManifest.version,
          },
        },
      });
      images = Boolean(init && init.agentCapabilities && init.agentCapabilities.promptCapabilities && init.agentCapabilities.promptCapabilities.image);
      return { client, init };
    } catch (error) {
      if (client) await client.close().catch(() => {});
      const code = error && Number.isInteger(error.code) ? error.code : null;
      const reason = code === -32001 ? 'unauthorized（令牌被拒绝）' : code === -32002 ? 'protocol_incompatible（协议无交集）' : (error && error.message ? error.message : String(error));
      const wrapped = new Error('连接桥接失败：' + reason);
      wrapped.code = code === -32001 ? 'unauthorized' : code === -32002 ? 'protocol_incompatible' : 'bridge_unavailable';
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async function lockWebStart(dshHome, profile) {
    const dir = path.join(resolveAgentCollabHome(process.env), 'locks');
    await ensurePrivateDir(dir);
    const key = crypto.createHash('sha256').update(dshHome + '\0' + profile).digest('hex').slice(0, 16);
    const file = path.join(dir, 'dsh-web-' + key + '.lock');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await fsp.open(file, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ v: 1, pid: process.pid, dshHome, profile, at: nowIso() }));
        await handle.close();
        return { acquired: true, file };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await fsp.readFile(file, 'utf8').catch(() => null);
        let stale = false;
        if (existing) {
          try {
            const record = JSON.parse(existing);
            stale = !isPidAlive(record.pid);
          } catch {
            stale = true;
          }
        }
        if (stale && attempt === 0) {
          await fsp.unlink(file).catch(() => {});
          continue;
        }
        return { acquired: false, file };
      }
    }
    return { acquired: false, file };
  }

  async function waitForDiscovery({ home, profile, startedAt, child, timeoutMs, requireStartedAt }) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child && child.exitCode !== null) {
        return { ok: false, reason: 'dsh Web 提前退出（Web pid ' + (child.pid ?? '?') + '，退出码 ' + child.exitCode + '）', discovery: await readDiscoveryFile({ home, profile, isAlive: isPidAlive }) };
      }
      const found = await readDiscoveryFile({ home, profile, isAlive: isPidAlive });
      if (found.online) {
        const started = Date.parse(found.record.startedAt);
        if (!requireStartedAt || !Number.isFinite(startedAt) || (Number.isFinite(started) && started >= startedAt - 1000)) {
          return { ok: true, discovery: found };
        }
      }
      await sleep(200);
    }
    const current = await readDiscoveryFile({ home, profile, isAlive: isPidAlive });
    return { ok: false, reason: '等待发现文件超时（' + timeoutMs + ' ms）' + (current.reason ? '；' + current.reason : ''), discovery: current };
  }

  async function startWebAndWait(dshInfo) {
    const home = dshInfo.home.home;
    const profile = dshInfo.profile;
    const lock = await lockWebStart(home, profile);
    try {
      const existing = await readDiscoveryFile({ home, profile, isAlive: isPidAlive });
      if (existing.online) return { ok: true, discovery: existing, started: false };
      if (!lock.acquired) {
        const timeoutMs = envNumber(process.env, 'AGENT_COLLAB_TEST_WEB_START_TIMEOUT_MS', 60000);
        const waited = await waitForDiscovery({ home, profile, startedAt: Date.now(), child: null, timeoutMs, requireStartedAt: false });
        return { ...waited, started: false };
      }
      const entry = dshInfo.entry && dshInfo.entry.ok ? dshInfo.entry.file : null;
      if (!entry) return { ok: false, reason: '解析不出 dsh 入口，不能自动启动 Web', started: false };
      const logDir = path.join(resolveAgentCollabHome(process.env), 'logs');
      await ensurePrivateDir(logDir);
      const logFile = path.join(logDir, 'dsh-web-' + profile + '.log');
      const fd = fs.openSync(logFile, 'a', 0o600);
      try { fs.chmodSync(logFile, 0o600); } catch { /* Windows */ }
      const args = [entry, '--profile', profile];
      const openBrowser = config.dsh && config.dsh.openBrowserOnStart !== undefined ? config.dsh.openBrowserOnStart : true;
      if (openBrowser === false) args.push('--no-open');
      if (config.dsh && Array.isArray(config.dsh.webArgs)) args.push(...config.dsh.webArgs.map(String));
      const baseEnv = await buildInheritedEnv();
      const child = spawn(process.execPath, args, {
        cwd: cwd ?? process.cwd(),
        env: { ...baseEnv, DSH_HOME: home },
        detached: true,
        windowsHide: true,
        stdio: ['ignore', fd, fd],
      });
      fs.closeSync(fd);
      child.unref();
      webChild = child;
      webLogFile = logFile;
      const timeoutMs = envNumber(process.env, 'AGENT_COLLAB_TEST_WEB_START_TIMEOUT_MS', 60000);
      const waited = await waitForDiscovery({ home, profile, startedAt: Date.now(), child, timeoutMs, requireStartedAt: true });
      if (!waited.ok) {
        return { ok: false, reason: waited.reason + '（Web pid ' + (child.pid ?? '?') + '）', discovery: waited.discovery, started: true, pid: child.pid ?? null, logFile };
      }
      return { ...waited, started: true, pid: child.pid ?? null, logFile };
    } finally {
      if (lock.acquired) await fsp.unlink(lock.file).catch(() => {});
    }
  }

  async function setOverlay(next) {
    if (overlay && overlay.dir && overlay.dir !== next.dir) await fsp.rm(overlay.dir, { recursive: true, force: true }).catch(() => {});
    overlay = next;
  }

  async function buildInheritedEnv() {
    if (config.inheritEnv === 'login-shell') {
      const probed = await probeLoginShellEnv({ platform: process.platform, env: process.env });
      if (probed.ok) return { ...probed.env };
      warn('登录 shell 环境探测失败（' + probed.reason + '），改用设计端环境');
    }
    return { ...process.env };
  }

  async function chooseTransport() {
    const info = await getDshInfo();
    const configured = config.dsh && config.dsh.transport ? config.dsh.transport : 'auto';
    if (configured === 'acp') return { mode: 'acp', info };
    const autoStart = config.dsh && config.dsh.autoStartWeb !== undefined ? config.dsh.autoStartWeb : true;
    let lastProblem = info.discovery.online ? null : info.discovery.reason;
    if (info.discovery.online) {
      try {
        return { mode: 'bridge', info, discovery: info.discovery, ...(await connectBridge(info.discovery)) };
      } catch (error) {
        lastProblem = error.message;
      }
    }
    if (info.installation.installed && autoStart) {
      const started = await startWebAndWait(info);
      if (started.ok) {
        try {
          return { mode: 'bridge', info, discovery: started.discovery, ...(await connectBridge(started.discovery)) };
        } catch (error) {
          lastProblem = error.message;
        }
      } else {
        lastProblem = started.reason + (started.discovery && started.discovery.reason ? '；' + started.discovery.reason : '');
      }
    } else if (!info.installation.installed) {
      lastProblem = 'profile ' + info.profile + ' 里没有装桥接（' + info.installation.reason + '）';
    }
    if (configured === 'bridge') {
      warn('桥接不可用（executor_unavailable）：' + String(lastProblem ?? '未知原因'));
      const error = new Error('dsh 桥接不可用（executor_unavailable）：' + String(lastProblem ?? '未知原因'));
      error.code = 'executor_unavailable';
      throw error;
    }
    warn('桥接不可用，退回 dsh --profile acp：' + String(lastProblem ?? '未知原因') + '。这个会话不会实时显示；任务结束前不要在 dsh Web 里打开它，否则会占锁。');
    return { mode: 'acp', info, reason: lastProblem };
  }

  async function buildAcpEnv() {
    const base = await buildInheritedEnv();
    return {
      ...base,
      ...(env && typeof env === 'object' ? env : {}),
      AGENT_COLLAB_ROLE: 'executor',
      DSH_AGENT_COLLAB_ROLE: 'executor',
      DSH_PERMISSION_MODE: config.permissionPreset || 'workspace-write',
      DSH_HOME: lastInfo && lastInfo.home ? lastInfo.home.home : '',
    };
  }

  async function spawnAcpClient(info) {
    const entry = info.entry && info.entry.ok ? info.entry.file : null;
    if (!entry) {
      const error = new Error('解析不出 dsh 入口，acp 模式不可用');
      error.code = 'executor_unavailable';
      throw error;
    }
    const baseEnv = await buildAcpEnv();
    const client = await AcpClient.connectStdio({
      command: process.execPath,
      args: [entry, '--profile', 'acp', '--patch', overlay.file],
      cwd: cwd ?? process.cwd(),
      env: baseEnv,
      permissionPolicy: currentPolicy,
    });
    attachClientHandlers(client);
    await client.initialize({ clientInfo: { name: 'agent-collab', version: packageManifest.version } });
    return client;
  }

  async function startAcp(info, options, brief) {
    await setOverlay(await buildAcpOverlay({ dshInfo: info, model: normalizeModel(options.model).model, env: process.env }));
    if (overlay.warning) warn(overlay.warning);
    const client = await spawnAcpClient(info);
    const created = await client.newSession({ cwd: cwd ?? process.cwd(), mcpServers: [] });
    const sessionId = created.sessionId;
    const model = normalizeModel(options.model);
    if (model.warning) warn(model.warning);
    if (model.model) {
      try {
        await client.setConfigOption({ sessionId, configId: 'model', value: JSON.stringify([model.model.provider, model.model.model]) });
      } catch (error) {
        warn('acp 模式设置模型失败（' + error.message + '），使用覆盖层带来的默认模型');
      }
    }
    const reasoning = mapReasoningEffort(options.reasoningEffort);
    if (reasoning.warning) warn(reasoning.warning);
    if (reasoning.value !== null) {
      const configOptions = Array.isArray(created.configOptions) ? created.configOptions : [];
      const hasReasoning = configOptions.some((option) => option && option.id === 'reasoning_effort');
      if (!hasReasoning) {
        warn('这个模型没有提供 reasoning_effort 选项，忽略思考强度 ' + reasoning.value + '（dsh 的档位有 low、medium、high、max；deepseek 服务商是 off、low、high、max）');
      } else {
        try {
          await client.setConfigOption({ sessionId, configId: 'reasoning_effort', value: reasoning.value });
        } catch (error) {
          warn('acp 模式设置思考强度失败（' + error.message + '），使用模型默认值');
        }
      }
    }
    const turn = makeTurn(client, sessionId, brief);
    current = { client, transport: 'acp', sessionId };
    transportChanged('acp');
    return { sessionId, transport: 'acp', model: model.model ?? (overlay.entries.find((entry) => entry.id === 'acp')?.config ?? null), turn: turn.promise };
  }

  async function startBridge(info, discovery, client, options, brief, runId, title) {
    const envForSession = {};
    for (const [key, value] of Object.entries(env ?? {})) {
      if (isDsEnvKey(key)) envForSession[key] = String(value);
      else warn('桥接模式只能注入 DSH_ 开头的环境变量，已丢弃：' + key);
    }
    envForSession.DSH_AGENT_COLLAB_ROLE = 'executor';
    const model = normalizeModel(options.model);
    if (model.warning) warn(model.warning);
    const reasoning = mapReasoningEffort(options.reasoningEffort);
    if (reasoning.warning) warn(reasoning.warning);
    const agentPreset = options.agentPreset && options.agentPreset !== 'agent-collab' ? options.agentPreset : null;
    const created = await client.newSession({
      cwd: cwd ?? process.cwd(),
      mcpServers: [],
      _meta: {
        agentCollab: {
          runId,
          title: normalizeTitle(runId, title),
          agentPreset,
          permissionPreset: options.permissionPreset ?? 'workspace-write',
          model: model.model,
          reasoningEffort: reasoning.value,
          attachWorkspace: true,
          env: envForSession,
        },
      },
    });
    const sessionId = created.sessionId;
    const turn = makeTurn(client, sessionId, brief);
    current = { client, transport: 'bridge', sessionId };
    transportChanged('bridge');
    const meta = created._meta && created._meta.agentCollab ? created._meta.agentCollab : {};
    return {
      sessionId,
      transport: 'bridge',
      model: meta.model ?? model.model,
      agentPreset: meta.agentPreset ?? null,
      turn: turn.promise,
    };
  }

  return {
    capabilities() {
      const configured = config.dsh && config.dsh.transport ? config.dsh.transport : 'auto';
      let bridge = false;
      if (configured === 'bridge') bridge = true;
      else if (configured === 'auto') {
        if (current) bridge = current.transport === 'bridge';
        else if (lastInfo) bridge = Boolean(lastInfo.discovery && lastInfo.discovery.online);
        else {
          // 还没连接过：同步看一眼发现文件，按“会走的那一种”回答。
          try {
            const homeInfo = resolveDshHomeSync({ configHome: config.dsh && config.dsh.home, env: process.env });
            const file = path.join(homeInfo, 'agent-collab', 'bridge-' + ((config.dsh && config.dsh.profile) || 'web') + '.json');
            const record = JSON.parse(fs.readFileSync(file, 'utf8'));
            bridge = Number.isInteger(record.pid) && isPidAlive(record.pid) && !record.problem;
          } catch {
            bridge = false;
          }
        }
      }
      return { images, structuredOutput: false, liveView: bridge, resume: true, humanApproval: bridge };
    },

    async start({ cwd: startCwd, runId, title, brief, options, env: startEnv }) {
      if (closed) throw new Error('适配器已经关闭');
      cwd = startCwd ?? cwd;
      if (startEnv && typeof startEnv === 'object') env = startEnv;
      currentPolicy = options && options.unattendedApproval === 'allow' ? 'allow' : 'deny';
      const choice = await chooseTransport();
      if (choice.mode === 'bridge') {
        return await startBridge(choice.info, choice.discovery, choice.client, options ?? {}, brief, runId, title);
      }
      return await startAcp(choice.info, options ?? {}, brief);
    },

    async resume({ sessionId, message }) {
      if (closed) throw new Error('适配器已经关闭');
      const choice = await chooseTransport();
      if (choice.mode === 'bridge') {
        const client = choice.client;
        try {
          await client.resumeSession({ sessionId, cwd: cwd ?? process.cwd(), mcpServers: [] });
        } catch (error) {
          await client.close().catch(() => {});
          throw error;
        }
        const turn = makeTurn(client, sessionId, message);
        current = { client, transport: 'bridge', sessionId };
        transportChanged('bridge');
        return { turn: turn.promise };
      }
      await setOverlay(await buildAcpOverlay({ dshInfo: choice.info, model: null, env: process.env }));
      if (overlay.warning) warn(overlay.warning);
      const client = await spawnAcpClient(choice.info);
      await client.resumeSession({ sessionId, cwd: cwd ?? process.cwd(), mcpServers: [] });
      const turn = makeTurn(client, sessionId, message);
      current = { client, transport: 'acp', sessionId };
      transportChanged('acp');
      return { turn: turn.promise };
    },

    async attach({ sessionId, sinceCursor }) {
      if (closed) throw new Error('适配器已经关闭');
      const choice = await chooseTransport();
      if (choice.mode === 'acp') return { attached: false };
      const client = choice.client;
      const turn = makeAttachTurn();
      replayFilter = { sinceCursor };
      let resumed;
      try {
        resumed = await client.resumeSession({
          sessionId,
          cwd: cwd ?? process.cwd(),
          mcpServers: [],
          _meta: { agentCollab: { sinceSeq: 0 } },
        });
      } catch (error) {
        replayFilter = null;
        currentTurn = null;
        await client.close().catch(() => {});
        if (error && (error.code === -32003 || error.code === -32002)) return { attached: false };
        throw error;
      } finally {
        replayFilter = null;
      }
      const meta = resumed && resumed._meta && resumed._meta.agentCollab ? resumed._meta.agentCollab : {};
      if (Array.isArray(meta.pendingApprovals)) {
        for (const item of meta.pendingApprovals) {
          emit({ type: 'approval', state: 'pending', approvalId: item.approvalId ?? null, toolName: item.toolName ?? null, callId: item.callId ?? null, reason: item.reason ?? null });
        }
      }
      if (Array.isArray(meta.pendingQuestions)) {
        for (const item of meta.pendingQuestions) {
          emit({ type: 'question', state: 'pending', callId: item.callId ?? null, questions: item.questions ?? [] });
        }
      }
      current = { client, transport: 'bridge', sessionId };
      transportChanged('bridge');
      if (meta.running === true) {
        return { attached: true, running: true, turn: turn.promise };
      }
      if (!turn.end) {
        currentTurn = null;
        await client.close().catch(() => {});
        return { attached: false };
      }
      currentTurn = null;
      return { attached: true, running: false, result: buildResult(turn) };
    },

    async cancel({ sessionId }) {
      if (!current || !current.client) return;
      cancelSent = true;
      try {
        current.client.cancel({ sessionId: sessionId ?? current.sessionId });
      } catch (error) {
        log('发送 session/cancel 失败：' + (error && error.message ? error.message : String(error)));
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      if (current && current.client) {
        try { await current.client.close(); } catch { /* 已关闭 */ }
      }
      // 自动启动的 Web 是独立常驻进程，不在任务结束时结束它（它可能已经是用户在用的 Web）。
      webChild = null;
      if (overlay && overlay.dir) {
        await fsp.rm(overlay.dir, { recursive: true, force: true }).catch(() => {});
      }
      overlay = null;
      current = null;
    },

    diagnostics() {
      return { warnings: [...warnings], webLogFile };
    },
  };
}

export default createAdapter;
