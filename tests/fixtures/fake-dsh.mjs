// 本文件：桥接单元测试用的假 dsh 上下文。用内存假会话按脚本产生 dsh 事件，替代真实 dsh 服务。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

function makeSession(fake, id, cwd, preset) {
  const events = [];
  const session = {
    id,
    header: { cwd, agentPreset: preset ?? null },
    events,
    get seq() { return events.length; },
    eventAt(seq) { return events[seq]; },
    requestHeader() { return fake.requestHeader; },
    append(type, data) {
      const event = { type, seq: events.length, time: Date.now(), data };
      events.push(event);
      fake.emitSession(session, event);
      if (type === 'turn/end') fake.agents.get(session.id)?.setIdle();
      return event.seq;
    },
  };
  return session;
}

function makeAgent(fake, session) {
  let idleResolvers = [];
  let idle = true;
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    options: {},
    followup(message) {
      fake.followups.push({ sessionId: session.id, message });
      idle = false;
      agent.status = 'running';
      if (typeof fake.runTurn === 'function') fake.runTurn(session, agent);
    },
    whenIdle() {
      if (idle) return Promise.resolve();
      return new Promise((resolve) => idleResolvers.push(resolve));
    },
    cancel(cause) {
      fake.cancels.push({ sessionId: session.id, cause });
      idle = true;
      agent.status = 'idle';
      for (const resolve of idleResolvers) resolve();
      idleResolvers = [];
    },
    setIdle() {
      idle = true;
      agent.status = 'idle';
      for (const resolve of idleResolvers) resolve();
      idleResolvers = [];
    },
    ctx: {},
  };
  return agent;
}

export function createFakeDsh(options = {}) {
  const home = options.homeDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'agent-collab-fake-dsh-'));
  const sessions = new Map();
  const agents = new Map();
  const sessionHandlers = [];
  const agentErrorHandlers = [];
  const effects = [];
  const fake = {
    home,
    sessions,
    agents,
    effects,
    created: [],
    followups: [],
    cancels: [],
    workspaces: [],
    mountedPresets: [],
    registeredEnv: [],
    permissionSets: [],
    sandboxModes: [],
    approvalPolicies: [],
    titles: [],
    turnCounters: new Map(),
    turns: Array.isArray(options.turns) ? options.turns : null,
    requestHeader: options.requestHeader ?? null,
    childrenPending: options.childrenPending ?? false,
    async emit(sessionId, type, data) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error('unknown fake session: ' + sessionId);
      return session.append(type, data);
    },
    emitSession(session, event) {
      for (const handler of sessionHandlers) handler(session, event);
    },
    emitAgentError(agent, error) {
      for (const handler of agentErrorHandlers) handler({ agent, error });
    },
    makeSession(id, cwd, preset) {
      const session = makeSession(fake, id, cwd, preset);
      sessions.set(id, session);
      const agent = makeAgent(fake, session);
      agents.set(id, agent);
      return { session, agent };
    },
    dispose() {
      for (const cleanup of effects.reverse()) cleanup();
    },
  };

  const agentPresets = {
    async list() {
      if (options.presets !== undefined) return options.presets;
      return [{ id: 'standard', name: 'Standard' }, { id: 'agent-collab', name: 'Agent Collab' }];
    },
    async readDocument(id) {
      if (options.documents && Object.hasOwn(options.documents, id)) return { agentPreset: id, content: options.documents[id] };
      if (id === 'standard') return { agentPreset: id, content: "- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n- id: tool-ask-user\n  name: '@deepseek-ai/dsh-tool-ask-user'\n" };
      if (id === 'agent-collab') return { agentPreset: id, content: "- id: tool-bash\n  name: '@deepseek-ai/dsh-tool-bash'\n" };
      throw new Error('unknown preset: ' + id);
    },
    async mount(agentCtx, id) {
      if (options.mountErrors && options.mountErrors[id]) throw new Error(options.mountErrors[id]);
      fake.mountedPresets.push({ sessionId: agentCtx.sessionId, id });
      agentCtx.agent.session.header.agentPreset = id;
      return { id };
    },
  };

  const agentsService = {
    async create(createOptions) {
      const { sessionId } = createOptions;
      const { session, agent } = fake.makeSession(sessionId, createOptions.meta && createOptions.meta.cwd, createOptions.meta && createOptions.meta.agentPreset);
      agent.options = createOptions.agentOptions ?? {};
      const agentCtx = {
        sessionId,
        agent,
        get(name) {
          if (name === 'shellEnv') return fake.shellEnv;
          return undefined;
        },
        on() { return () => {}; },
      };
      if (typeof createOptions.setup === 'function') await createOptions.setup(agentCtx, agent);
      fake.created.push({ sessionId, agentOptions: createOptions.agentOptions, preset: agent.session.header.agentPreset });
      return { agent, async dispose() { agents.delete(sessionId); } };
    },
    async resume(resumeOptions) {
      const id = resumeOptions.resumeSessionId;
      let agent = agents.get(id);
      if (!agent) {
        if (!options.resumable) throw new Error('not resumable: ' + id);
        const created = fake.makeSession(id, options.resumeCwd ?? fake.home, options.resumePreset ?? null);
        agent = created.agent;
      }
      const agentCtx = {
        sessionId: id,
        agent,
        get(name) { if (name === 'shellEnv') return fake.shellEnv; return undefined; },
        on() { return () => {}; },
      };
      if (typeof resumeOptions.setup === 'function') await resumeOptions.setup(agentCtx, agent);
      return { agent, async dispose() {} };
    },
    get(id) { return agents.get(id); },
  };

  fake.shellEnv = {
    register(entry) { fake.registeredEnv.push(entry); },
  };

  const permissionPresets = {
    catalog() {
      const specs = options.permissionSpecs ?? [
        { name: 'read-only', sandbox: 'read-only', approval: 'ask' },
        { name: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
        { name: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' },
      ];
      return { defaultOptions: specs.map((spec) => ({ value: spec.name, name: spec.name })), options: [], defaultPreset: specs[0] && specs[0].name };
    },
    resolve(name) {
      const specs = options.permissionSpecs ?? [
        { name: 'read-only', sandbox: 'read-only', approval: 'ask' },
        { name: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' },
        { name: 'danger-full-access', sandbox: 'danger-full-access', approval: 'never' },
      ];
      const spec = specs.find((item) => item.name === name);
      if (!spec) throw new Error('unknown permission preset: ' + name);
      return { sandbox: spec.sandbox, approval: spec.approval };
    },
    set(session, name) {
      fake.permissionSets.push({ sessionId: session.id, name });
      session.append('permission/preset', { preset: name });
    },
  };

  const workspaceRegistry = {
    async create(cwd, title) {
      let record = fake.workspaces.find((item) => item.path === cwd);
      if (!record) {
        record = { id: 'ws-' + (fake.workspaces.length + 1), title, path: cwd, sessionIds: new Set(), attachSession(id) { this.sessionIds.add(id); } };
        fake.workspaces.push(record);
      }
      return record;
    },
    list() { return fake.workspaces; },
  };

  const llm = {
    listProviders() { return [{ id: 'fake', name: 'Fake Provider' }]; },
    async listModels() { return [{ id: 'fake-model', name: 'Fake Model', inputModalities: ['text'] }]; },
    async resolveModelInfo() {
      return { reasoning: { defaultEffort: 'medium', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } };
    },
  };

  const services = {
    agents: agentsService,
    agentPresets,
    shellEnv: fake.shellEnv,
    sessions: { get(id) { return sessions.get(id); }, async flush() {} },
    llm,
    workspaceRegistry,
    permissionPresets,
    agentDefaultModel: { currentSelection() { return options.defaultModel ?? { provider: 'fake', model: 'fake-model', reasoningEffort: 'high' }; } },
    sessionTitle: {
      rename(session, title) {
        fake.titles.push({ sessionId: session.id, title });
        session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } });
      },
    },
    subagents: { async waitForChildren() { return fake.childrenPending; } },
    dshHomePath: (...segments) => path.join(home, ...segments.map(String)),
    pluginPackages: { packageOf() { return { name: '@deepseek-ai/dsh', version: options.version ?? '0.2.1' }; } },
    webApp: { getAdvertisedUrl() { return 'http://127.0.0.1:1'; } },
  };
  if (options.web === false) delete services.workspaceRegistry;
  if (options.withoutWorkspaceRegistry) delete services.workspaceRegistry;

  const ctx = {
    baseUrl: pathToFileURL(path.join(home, 'profiles', profileName(options))).href + '/',
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get(name) { return services[name]; },
    inject(deps, callback) {
      if (deps.every((name) => services[name] !== undefined)) callback(ctx);
    },
    effect(register) {
      const cleanup = register();
      if (typeof cleanup === 'function') effects.push(cleanup);
      return cleanup;
    },
    on(event, handler, eventOptions) {
      if (event === 'session/event') sessionHandlers.push(handler);
      else if (event === 'agent/error') agentErrorHandlers.push(handler);
      void eventOptions;
      return () => {};
    },
  };

  fake.runTurn = (session, agent) => {
    if (!fake.turns) return;
    const turn = (fake.turnCounters.get(session.id) ?? 0) + 1;
    fake.turnCounters.set(session.id, turn);
    const steps = fake.turns[Math.min(turn - 1, fake.turns.length - 1)] ?? [];
    let ended = false;
    const end = (reason) => {
      if (ended) return;
      ended = true;
      session.append('turn/end', { turn, reason });
    };
    session.append('turn/start', { turn });
    (async () => {
      try {
        for (const step of steps) {
          if (ended) break;
          if (!step || typeof step !== 'object') continue;
          if (step.kind === 'text') {
            session.append('assistant/message', {
              message: { id: 'fake-msg-' + Math.random().toString(36).slice(2), role: 'assistant', content: [{ type: 'text', text: String(step.text ?? '') }] },
              ...(step.usage ? { usage: step.usage } : {}),
            });
          } else if (step.kind === 'thinking') {
            session.append('assistant/message', {
              message: { id: 'fake-msg-' + Math.random().toString(36).slice(2), role: 'assistant', content: [{ type: 'reasoning', text: String(step.text ?? '') }] },
            });
          } else if (step.kind === 'tool') {
            session.append('tool/call', {
              callId: step.callId ?? 'call-' + Math.random().toString(36).slice(2),
              name: step.name ?? 'bash',
              arguments: JSON.stringify(step.input ?? {}),
            });
          } else if (step.kind === 'toolResult') {
            session.append('tool/result', {
              message: {
                toolCallId: step.callId ?? 'call-1',
                isError: step.ok === false,
                content: [{ type: 'text', text: String(step.output ?? '') }],
              },
            });
          } else if (step.kind === 'sleep') {
            await new Promise((resolve) => setTimeout(resolve, step.ms ?? 100));
          } else if (step.kind === 'humanStop') {
            agent.cancel({ kind: 'user' });
            end({ kind: 'aborted', reason: { kind: 'user' } });
          } else if (step.kind === 'waitCancel') {
            const deadline = Date.now() + (step.timeoutMs ?? 20000);
            while (Date.now() < deadline && !fake.cancels.some((item) => item.sessionId === session.id)) {
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
            end({ kind: 'aborted', reason: { kind: 'user' } });
          } else if (step.kind === 'turnEnd') {
            end({ kind: step.endReason ?? 'completed' });
          }
        }
        end({ kind: 'completed' });
      } catch (error) {
        fake.lastError = error;
        end({ kind: 'error', error: String(error && error.message ? error.message : error) });
      }
    })();
  };

  fake.snapshot = () => ({
    created: fake.created.map((item) => ({ sessionId: item.sessionId, agentOptions: item.agentOptions ?? null, preset: item.preset ?? null })),
    followups: fake.followups.map((item) => ({ sessionId: item.sessionId })),
    cancels: fake.cancels.map((item) => ({ sessionId: item.sessionId })),
    workspaces: fake.workspaces.map((item) => ({ id: item.id, title: item.title, path: item.path, sessionIds: [...item.sessionIds] })),
    mountedPresets: fake.mountedPresets,
    titles: fake.titles,
    permissionSets: fake.permissionSets,
    registeredEnv: fake.registeredEnv.map((entry) => {
      const sessionId = String(entry.name ?? '').replace(/^agent-collab-/, '');
      const agent = fake.agents.get(sessionId);
      let resolved = null;
      try { resolved = typeof entry.resolve === 'function' ? entry.resolve({ agent }) : null; } catch { resolved = null; }
      return { sessionId, variables: Object.keys(entry.variables ?? {}), resolved };
    }),
  });

  for (const [name, service] of Object.entries(services)) ctx[name] = service;
  return { ctx, fake, services, home };
}

function profileName(options) {
  return options.profile ?? 'web';
}

export function makeTempHome(prefix = 'agent-collab-bridge-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
