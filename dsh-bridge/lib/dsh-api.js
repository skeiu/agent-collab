// 本文件：桥接访问 dsh 内部服务的唯一入口。所有 ctx、dsh 服务对象和内部事件订阅都集中在这里；dsh 升级时只改这一个文件。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicWriteJson } from './atomic-write.js';

/** 本桥接实测并支持的 dsh 版本范围（含下限，不含下一个次版本）。 */
export const SUPPORTED_DSH_RANGE = '>=0.2.1-rc.2 <0.3.0';

const DSH_PACKAGE_NAME = '@deepseek-ai/dsh';

function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function compareIdentifiers(a, b) {
  const aNumber = /^\d+$/.test(a);
  const bNumber = /^\d+$/.test(b);
  if (aNumber && bNumber) return Number(a) - Number(b);
  if (aNumber) return -1;
  if (bNumber) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    const result = compareIdentifiers(a[index], b[index]);
    if (result !== 0) return result;
  }
  return 0;
}

function compareVersions(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** dsh 版本是否在支持范围内；版本无法解析时按不支持处理。 */
export function isDshVersionSupported(version) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  return compareVersions(parsed, parseVersion('0.2.1-rc.2')) >= 0
    && compareVersions(parsed, parseVersion('0.3.0')) < 0;
}

function readPackageVersion(file) {
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    return manifest && manifest.name === DSH_PACKAGE_NAME && typeof manifest.version === 'string'
      ? manifest.version
      : null;
  } catch {
    return null;
  }
}

function resolveDshVersion(ctx) {
  const packages = ctx.get('pluginPackages');
  if (packages !== undefined && typeof packages.packageOf === 'function') {
    for (const parentURL of [import.meta.url, ctx.baseUrl].filter(Boolean)) {
      try {
        const found = packages.packageOf(DSH_PACKAGE_NAME, parentURL);
        if (found && typeof found.version === 'string') return found.version;
      } catch {
        // 继续尝试下一个解析基准。
      }
    }
  }
  // 兜底：从启动 dsh 的入口文件向上找 dsh 自己的 package.json。
  const entry = process.argv[1];
  if (typeof entry === 'string' && entry.length > 0) {
    const direct = readPackageVersion(path.join(path.dirname(entry), '..', 'package.json'));
    if (direct) return direct;
    const sameLevel = readPackageVersion(path.join(path.dirname(entry), 'package.json'));
    if (sameLevel) return sameLevel;
  }
  return null;
}

function resolveHomeDir(ctx) {
  const resolveHome = ctx.get('dshHomePath');
  if (typeof resolveHome === 'function') {
    try {
      const value = resolveHome();
      if (typeof value === 'string' && value.length > 0) return value;
    } catch {
      // 交给兜底。
    }
  }
  const fromEnv = process.env.DSH_HOME;
  return typeof fromEnv === 'string' && fromEnv.trim().length > 0 ? fromEnv : null;
}

function resolveProfileName(ctx) {
  try {
    if (typeof ctx.baseUrl === 'string' && ctx.baseUrl.length > 0) {
      const directory = fileURLToPath(new URL('.', ctx.baseUrl));
      const name = path.basename(directory.replace(/[\\/]+$/, ''));
      if (name.length > 0) return name;
    }
  } catch {
    // 无法从 baseUrl 推导时返回 null，由发现文件带 problem。
  }
  return null;
}

function selectionOf(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.provider !== 'string' || typeof value.model !== 'string') return null;
  return {
    provider: value.provider,
    model: value.model,
    ...typeof value.reasoningEffort === 'string' && value.reasoningEffort.length > 0
      ? { reasoningEffort: value.reasoningEffort }
      : {},
  };
}

async function loadModelSelectionInstaller() {
  try {
    const module = await import('@deepseek-ai/dsh-agent');
    return typeof module.installModelSelection === 'function' ? module.installModelSelection : null;
  } catch {
    return null;
  }
}

/**
 * 创建桥接使用的 dsh 服务门面。
 * @param {object} ctx cordis 插件上下文
 * @returns {object} 只暴露桥接需要的动作，不暴露 ctx 本身
 */
export function createDshApi(ctx) {
  const homeDir = resolveHomeDir(ctx);
  const profileName = resolveProfileName(ctx);
  const dshVersion = resolveDshVersion(ctx);

  // 每个会话的环境值单独存放；提供者按变量名各注册一次，且注册在桥接插件的根上下文上。
  // 不能按会话注册：dsh 的 ShellEnvRegistry 规定一个键只能有一个提供者，且会话上下文卸载时
  // 会连带释放注册，会误伤其他会话。
  const sessionEnvBySession = new Map();
  const sessionEnvProviders = new Map();
  // 会话环境要跨 Web 重启保留：dsh 没有稳定的会话级插件数据接口，桥接用自己的文件保存。
  // 每个会话一个文件，格式 { v: 1, sessionId, env }；目录 0700、文件 0600。
  const sessionEnvDirectory = homeDir === null ? null : path.join(homeDir, 'agent-collab', 'session-env');
  ctx.effect(() => () => {
    for (const provider of sessionEnvProviders.values()) {
      try { provider.dispose?.(); } catch { /* 已随上下文释放。 */ }
    }
    sessionEnvProviders.clear();
    sessionEnvBySession.clear();
  });

  function sessionEnvFile(sessionId) {
    if (sessionEnvDirectory === null) return null;
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
    return path.join(sessionEnvDirectory, sessionId + '.json');
  }

  function normalizeSessionEnv(env) {
    const normalized = {};
    for (const [key, value] of Object.entries(env ?? {})) {
      if (typeof value === 'string') normalized[key] = value;
    }
    return normalized;
  }

  function ensureSessionEnvProvider(key) {
    if (sessionEnvProviders.has(key)) return;
    const service = ctx.get('shellEnv');
    if (service === undefined || typeof service.register !== 'function') return;
    const contributor = {
      name: 'agent-collab-env-' + key,
      variables: { [key]: { description: 'agent-collab executor environment' } },
      resolve: (execution) => {
        const agent = execution && execution.agent;
        const sessionId = agent && typeof agent.id === 'string' ? agent.id : null;
        if (sessionId === null) return {};
        const values = sessionEnvBySession.get(sessionId);
        if (values === undefined || !Object.hasOwn(values, key)) return {};
        return { [key]: values[key] };
      },
    };
    const dispose = service.register(contributor);
    sessionEnvProviders.set(key, { contributor, dispose });
  }

  function applySessionEnv(sessionId, env) {
    const normalized = normalizeSessionEnv(env);
    for (const key of Object.keys(normalized)) ensureSessionEnvProvider(key);
    sessionEnvBySession.set(sessionId, normalized);
    return normalized;
  }

  function readSessionEnv(sessionId) {
    const file = sessionEnvFile(sessionId);
    if (file === null) return null;
    try {
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!record || record.v !== 1 || record.sessionId !== sessionId) return null;
      if (!record.env || typeof record.env !== 'object' || Array.isArray(record.env)) return null;
      const normalized = normalizeSessionEnv(record.env);
      return Object.keys(normalized).length > 0 ? normalized : null;
    } catch {
      return null;
    }
  }

  async function setSessionEnv(sessionId, env) {
    const normalized = applySessionEnv(sessionId, env);
    const file = sessionEnvFile(sessionId);
    if (file === null) return;
    try {
      await atomicWriteJson(file, { v: 1, sessionId, env: normalized });
    } catch (error) {
      ctx.logger?.warn?.('agent-collab bridge: failed to persist session env for ' + sessionId + ': ' + (error && error.message ? error.message : String(error)));
    }
  }

  /** 只清内存（桥接停止时用）：文件要留给 Web 重启后的下一轮。 */
  function clearSessionEnv(sessionId) {
    sessionEnvBySession.delete(sessionId);
  }

  /** 清内存并删除持久化文件（session/close 时用）。 */
  function deleteSessionEnv(sessionId) {
    sessionEnvBySession.delete(sessionId);
    const file = sessionEnvFile(sessionId);
    if (file === null) return;
    try {
      fs.rmSync(file, { force: true });
    } catch (error) {
      ctx.logger?.warn?.('agent-collab bridge: failed to delete session env for ' + sessionId + ': ' + (error && error.message ? error.message : String(error)));
    }
  }

  function restoreSessionEnv(agent) {
    const sessionId = agent && typeof agent.id === 'string' ? agent.id : null;
    if (sessionId === null || sessionEnvBySession.has(sessionId)) return;
    const values = readSessionEnv(sessionId);
    if (values === null) return;
    applySessionEnv(sessionId, values);
  }

  try {
    ctx.on('agent/created', (payload) => {
      restoreSessionEnv(payload && payload.agent);
    }, { global: true });
  } catch {
    // 旧 dsh 没有 agent/created 时，只能靠 session/new、session/resume 里的登记。
  }

  try {
    ctx.on('agent/disposed', (payload) => {
      const agent = payload && payload.agent;
      if (agent && typeof agent.id === 'string') clearSessionEnv(agent.id);
    }, { global: true });
  } catch {
    // 旧 dsh 没有 agent/disposed 时，session/close 仍会清理。
  }

  // 桥接插件热重载或启动时，已经活着的 agent 也要有注入；agent/created 只在创建/恢复时触发。
  try {
    for (const agent of ctx.agents.list()) restoreSessionEnv(agent);
  } catch {
    // 拿不到列表时不影响后续的 agent/created。
  }

  const api = {
    homeDir,
    profileName,
    dshVersion,
    supportedRange: SUPPORTED_DSH_RANGE,

    /** 当前 profile 是否有 Web 的 workspaceRegistry；没有就不启动监听。 */
    isWebProfile() {
      return ctx.get('workspaceRegistry') !== undefined;
    },

    getWebUrl() {
      try {
        const webApp = ctx.get('webApp');
        return webApp && typeof webApp.getAdvertisedUrl === 'function' ? webApp.getAdvertisedUrl() : null;
      } catch {
        return null;
      }
    },

    async listAgentPresets() {
      const service = ctx.get('agentPresets');
      if (service === undefined) return null;
      try {
        return await service.list();
      } catch {
        return null;
      }
    },

    async readPresetDocument(id) {
      const service = ctx.get('agentPresets');
      if (service === undefined || typeof service.readDocument !== 'function') return null;
      try {
        const document = await service.readDocument(id);
        return document && typeof document.content === 'string' ? document.content : null;
      } catch {
        return null;
      }
    },

    async mountAgentPreset(agentCtx, id) {
      const service = ctx.get('agentPresets');
      if (service === undefined || typeof service.mount !== 'function') {
        throw new Error('agentPresets service is unavailable');
      }
      return service.mount(agentCtx, id);
    },

    async createAgent(options) {
      const wrapped = { ...options };
      if (typeof options.setup === 'function') {
        wrapped.setup = (agentCtx, agent) => options.setup(agentCtx, viewOf(agent));
      }
      const handle = await ctx.agents.create(wrapped);
      const result = { view: viewOf(handle.agent) };
      if (typeof handle.dispose === 'function') result.dispose = handle.dispose.bind(handle);
      return result;
    },

    async resumeAgent(options) {
      const wrapped = { ...options };
      if (typeof options.setup === 'function') {
        wrapped.setup = (agentCtx, agent) => options.setup(agentCtx, viewOf(agent));
      }
      const handle = await ctx.agents.resume(wrapped);
      const result = { view: viewOf(handle.agent) };
      if (typeof handle.dispose === 'function') result.dispose = handle.dispose.bind(handle);
      return result;
    },

    getAgent(id) {
      const agent = ctx.agents.get(id);
      return agent === undefined ? undefined : viewOf(agent);
    },

    getDefaultModelSelection() {
      const service = ctx.get('agentDefaultModel');
      if (service === undefined || typeof service.currentSelection !== 'function') return null;
      try {
        return selectionOf(service.currentSelection());
      } catch {
        return null;
      }
    },

    async setSessionTitle(session, title) {
      const service = ctx.get('sessionTitle');
      if (service === undefined || typeof service.rename !== 'function') return;
      try {
        service.rename(session, title);
      } catch {
        // 标题只是展示信息，失败不影响会话。
      }
    },

    async attachWorkspace(cwd, sessionId) {
      const registry = ctx.get('workspaceRegistry');
      if (registry === undefined) return null;
      // 不传标题，让 dsh 按它自己的规则取目录名（dsh-workspace 的 createCanonical 会调用
      // defaultWorkspaceTitle(canonical)）；已有工作区也不会被改名。
      const workspace = await registry.create(cwd);
      await workspace.attachSession(sessionId);
      return workspace.id;
    },

    setSessionEnv,
    clearSessionEnv,
    deleteSessionEnv,

    async listPermissionPresetSpecs() {
      const service = ctx.get('permissionPresets');
      if (service === undefined) return [];
      let catalog;
      try {
        catalog = service.catalog();
      } catch {
        return [];
      }
      const specs = [];
      for (const option of catalog && Array.isArray(catalog.defaultOptions) ? catalog.defaultOptions : []) {
        try {
          const spec = service.resolve(option.value);
          specs.push({ name: option.value, sandbox: spec.sandbox, approval: spec.approval });
        } catch {
          // 跳过无法解析的条目。
        }
      }
      return specs;
    },

    setPermissionPreset(session, name) {
      const service = ctx.get('permissionPresets');
      if (service === undefined || typeof service.set !== 'function') {
        throw new Error('permissionPresets service is unavailable');
      }
      service.set(session, name);
    },

    setSandboxMode(session, mode) {
      session.append('sandbox/mode', { mode });
    },

    setApprovalPolicy(session, policy) {
      session.append('approval/policy', { policy });
    },

    async applyPermission(session, mapped) {
      const specs = await api.listPermissionPresetSpecs();
      const match = specs.find((spec) => spec.sandbox === mapped.sandbox && spec.approval === mapped.approval);
      if (match !== undefined) {
        api.setPermissionPreset(session, match.name);
        return { ...mapped, presetName: match.name };
      }
      api.setSandboxMode(session, mapped.sandbox);
      api.setApprovalPolicy(session, mapped.approval);
      return { ...mapped, presetName: null };
    },

    async permissionSnapshot(session, mapped) {
      const specs = await api.listPermissionPresetSpecs();
      const match = specs.find((spec) => spec.sandbox === mapped.sandbox && spec.approval === mapped.approval);
      return { ...mapped, presetName: match === undefined ? null : match.name };
    },

    async waitForChildren(agent) {
      const service = ctx.get('subagents');
      if (service === undefined || typeof service.waitForChildren !== 'function') return false;
      return service.waitForChildren(agent);
    },

    async listModels() {
      const llm = ctx.get('llm');
      if (llm === undefined || typeof llm.listProviders !== 'function') return [];
      const models = [];
      let providers = [];
      try {
        providers = llm.listProviders();
      } catch {
        return [];
      }
      for (const provider of providers) {
        try {
          const entries = await llm.listModels(provider.id);
          for (const entry of entries) {
            models.push({
              provider: provider.id,
              model: entry.id,
              displayName: entry.name || entry.id,
              ...Array.isArray(entry.inputModalities) ? { inputModalities: [...entry.inputModalities] } : {},
            });
          }
        } catch {
          // 该提供方目录不可用时跳过，其余提供方仍然可用。
        }
      }
      return models;
    },

    async resolveModelInfo(provider, model) {
      const llm = ctx.get('llm');
      if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return null;
      try {
        return await llm.resolveModelInfo(provider, model);
      } catch {
        return null;
      }
    },

    /** 模型选择控制器；installModelSelection 在目标 dsh 上不可用时退化为不可切换。 */
    async createModelControl(initial) {
      const install = await loadModelSelectionInstaller();
      let selected = selectionOf(initial) ?? undefined;
      const reference = {
        get current() {
          return selected;
        },
        set current(value) {
          selected = selectionOf(value) ?? undefined;
        },
        assembled: undefined,
      };
      return {
        install(agentCtx) {
          if (install !== null) install(agentCtx, reference);
        },
        get() {
          return selected === undefined ? null : { ...selected };
        },
        set(value) {
          selected = selectionOf(value) ?? undefined;
        },
      };
    },

    onSessionEvent(listener) {
      return ctx.on('session/event', (session, event) => {
        if (session && typeof session.id === 'string') listener(session.id, event);
      }, { global: true });
    },

    onAgentError(listener) {
      return ctx.on('agent/error', (payload) => {
        const agent = payload && payload.agent;
        listener(agent && typeof agent.id === 'string' ? agent.id : undefined, payload && payload.error);
      }, { global: true });
    },
  };

  const viewCache = new WeakMap();

  /** dsh agent/session 的包装视图；只暴露桥接需要的方法，不暴露底层对象。方法名刻意避开 seq/status 等 dsh 成员名，便于静态检查。 */
  function viewOf(agent) {
    const cached = viewCache.get(agent);
    if (cached !== undefined) return cached;
    const session = agent.session;
    const view = {
      id: agent.id,
      sessionId: session.id,
      currentSeq() { return session.seq; },
      readEvent(index) { return session.eventAt(index); },
      currentStatus() { return agent.status; },
      submit(message) { return agent.followup(message); },
      waitIdle() { return agent.whenIdle(); },
      stop(cause) { return agent.cancel(cause); },
      cwd() {
        return session.header && typeof session.header.cwd === 'string' ? session.header.cwd : null;
      },
      agentPreset() {
        return session.header && typeof session.header.agentPreset === 'string' ? session.header.agentPreset : null;
      },
      readRequestHeader() { return session.requestHeader(); },
      setTitle(title) { return api.setSessionTitle(session, title); },
      applyPermission(mapped) { return api.applyPermission(session, mapped); },
      permissionSnapshot(mapped) { return api.permissionSnapshot(session, mapped); },
      waitForChildren() { return api.waitForChildren(agent); },
    };
    viewCache.set(agent, view);
    return view;
  }

  return api;
}
