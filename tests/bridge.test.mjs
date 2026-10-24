// 本文件：dsh 桥接的单元测试。用假 dsh 上下文和 S1 的 AcpClient 覆盖发现文件、认证、会话方法、事件映射和重连补发。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AcpClient } from '../core/acp-client.mjs';
import { truncateText } from '../dsh-bridge/lib/acp-server.js';
import { apply } from '../dsh-bridge/lib/index.js';
import { createFakeDsh, makeTempHome } from './fixtures/fake-dsh.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgePackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'dsh-bridge', 'package.json'), 'utf8'));

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 4000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error('timed out waiting for ' + label);
}

async function startBridge(options = {}) {
  const home = makeTempHome();
  const context = createFakeDsh({ homeDir: home, ...options });
  apply(context.ctx);
  const file = path.join(home, 'agent-collab', 'bridge-' + (options.profile ?? 'web') + '.json');
  if (options.expectNoFile) {
    await delay(300);
    assert.equal(fs.existsSync(file), false, '非 web profile 不应写发现文件');
    return { home, fakeDsh: context.fake, file, discovery: null };
  }
  await waitFor(() => fs.existsSync(file), 4000, 'discovery file');
  const discovery = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { home, fakeDsh: context.fake, file, discovery };
}

async function stopBridge(box) {
  box.fakeDsh.dispose();
  await delay(50);
  fs.rmSync(box.home, { recursive: true, force: true });
}

async function connect(discovery) {
  return AcpClient.connectTcp({ host: discovery.host, port: discovery.port });
}

async function initialize(client, discovery, meta = {}) {
  return client.initialize({
    _meta: {
      agentCollab: {
        token: discovery.token,
        protocol: 1,
        protocolMin: 1,
        clientVersion: 'test',
        ...meta,
      },
    },
  });
}

function workDir(box) {
  return fs.mkdtempSync(path.join(box.home, 'work-'));
}

async function newSession(client, cwd, meta = {}) {
  return client.newSession({
    cwd,
    mcpServers: [],
    _meta: {
      agentCollab: {
        runId: 'T001',
        title: '[collab] T001 test',
        permissionPreset: 'workspace-write',
        env: {},
        ...meta,
      },
    },
  });
}

function notifications(client) {
  const list = [];
  client.onNotification((method, params) => list.push({ method, params }));
  return list;
}

test('发现文件字段、权限和删除；带 problem 时拒绝连接；非 web profile 不监听', async () => {
  const box = await startBridge();
  try {
    const { discovery, file } = box;
    assert.equal(discovery.v, 1);
    assert.equal(discovery.host, '127.0.0.1');
    assert.ok(Number.isInteger(discovery.port) && discovery.port > 0);
    assert.equal(typeof discovery.token, 'string');
    assert.ok(discovery.token.length >= 40);
    assert.equal(discovery.pid, process.pid);
    assert.equal(discovery.protocol, 1);
    assert.equal(discovery.protocolMin, 1);
    assert.equal(discovery.bridgeVersion, bridgePackage.version);
    assert.equal(discovery.dshVersion, '0.2.1');
    assert.equal(discovery.profile, 'web');
    assert.match(discovery.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    }

    const client = await connect(discovery);
    const init = await initialize(client, discovery);
    assert.equal(init.agentInfo.name, 'agent-collab-bridge');
    assert.equal(init._meta.agentCollab.profile, 'web');
    assert.ok(init._meta.agentCollab.agentPresets.available.includes('agent-collab'));
    assert.equal(init._meta.agentCollab.agentPresets.default, 'agent-collab');
    assert.equal(init._meta.agentCollab.agentPresets.agentCollabInSync, true);
    const models = await client.extensionRequest('_agentCollab/models', {});
    assert.deepEqual(models.current, { provider: 'fake', model: 'fake-model', reasoningEffort: 'high' });
    assert.deepEqual(models.models[0], { provider: 'fake', model: 'fake-model', displayName: 'Fake Model' });
    await client.close();
    box.fakeDsh.dispose();
    await waitFor(() => !fs.existsSync(file), 2000, 'discovery file removal');
    await assert.rejects(connect(discovery), /failed to connect|ECONNREFUSED/);
  } finally {
    await stopBridge(box);
  }

  const problemBox = await startBridge({ version: '0.1.0' });
  try {
    assert.match(problemBox.discovery.problem, /0\.1\.0/);
    const client = await connect(problemBox.discovery);
    await assert.rejects(initialize(client, problemBox.discovery), /closed|ECONNRESET|socket/i);
    await client.close().catch(() => {});
  } finally {
    await stopBridge(problemBox);
  }

  const nonWeb = await startBridge({ withoutWorkspaceRegistry: true, expectNoFile: true });
  await stopBridge(nonWeb);
});

test('认证：令牌错误、缺失、initialize 前请求都被断开；协议版本没有交集回 -32002', async () => {
  const box = await startBridge();
  try {
    for (const meta of [{ token: 'wrong-token' }, { token: undefined }]) {
      const client = await connect(box.discovery);
      await assert.rejects(initialize(client, box.discovery, meta), (error) => error.code === -32001);
      await client.close().catch(() => {});
    }

    const beforeInit = await connect(box.discovery);
    await assert.rejects(beforeInit.newSession({ cwd: box.home, mcpServers: [] }), (error) => error.code === -32001);
    await beforeInit.close().catch(() => {});

    const badProtocol = await connect(box.discovery);
    await assert.rejects(initialize(badProtocol, box.discovery, { protocol: 2, protocolMin: 2 }), (error) => {
      assert.equal(error.code, -32002);
      assert.deepEqual(error.data, { protocol: 1, protocolMin: 1 });
      return true;
    });
    await badProtocol.close().catch(() => {});
  } finally {
    await stopBridge(box);
  }
});

test('session/new：参数校验、预设选择和退回、权限的两种设法', async () => {
  const box = await startBridge();
  try {
    let client = await connect(box.discovery);
    await initialize(client, box.discovery);
    for (const cwd of ['relative/path', path.join(box.home, 'missing-dir')]) {
      await assert.rejects(newSession(client, cwd), (error) => error.code === -32602);
    }
    await assert.rejects(newSession(client, box.home, { env: { HOME: '/tmp' } }), (error) => error.code === -32602);
    await assert.rejects(newSession(client, box.home, { agentPreset: 'does-not-exist' }), (error) => error.code === -32005);
    await client.close();

    const fallbackBox = await startBridge({ mountErrors: { 'agent-collab': 'preset exploded' } });
    try {
      client = await connect(fallbackBox.discovery);
      await initialize(client, fallbackBox.discovery);
      const created = await newSession(client, workDir(fallbackBox));
      assert.equal(created._meta.agentCollab.agentPreset, 'standard');
      assert.deepEqual(created._meta.agentCollab.presetFallback.from, 'agent-collab');
      assert.match(created._meta.agentCollab.presetFallback.reason, /preset exploded/);
      await client.close();
    } finally {
      await stopBridge(fallbackBox);
    }

    const permissionBox = await startBridge({
      permissionSpecs: [{ name: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' }],
    });
    try {
      client = await connect(permissionBox.discovery);
      await initialize(client, permissionBox.discovery);
      const readOnly = await newSession(client, workDir(permissionBox), { permissionPreset: 'read-only' });
      assert.deepEqual(readOnly._meta.agentCollab.permission, { sandbox: 'read-only', approval: 'ask', presetName: null });
      const readOnlySession = permissionBox.fakeDsh.sessions.get(readOnly.sessionId);
      assert.ok(readOnlySession.events.some((event) => event.type === 'sandbox/mode' && event.data.mode === 'read-only'));
      assert.ok(readOnlySession.events.some((event) => event.type === 'approval/policy' && event.data.policy === 'ask'));

      const write = await newSession(client, workDir(permissionBox), { permissionPreset: 'workspace-write' });
      assert.deepEqual(write._meta.agentCollab.permission, { sandbox: 'workspace-write', approval: 'ask', presetName: 'workspace-write' });
      assert.deepEqual(permissionBox.fakeDsh.permissionSets.at(-1).name, 'workspace-write');
      await client.close();
    } finally {
      await stopBridge(permissionBox);
    }
  } finally {
    await stopBridge(box);
  }
});

test('同一进程里的多个会话：shell 环境相互隔离，关闭一个后不再注入', async () => {
  const box = await startBridge();
  try {
    const client = await connect(box.discovery);
    await initialize(client, box.discovery);
    const cwdA = workDir(box);
    const cwdB = workDir(box);
    const sessionA = await newSession(client, cwdA, {
      runId: 'T001',
      title: '[collab] T001 会话 A',
      env: { DSH_AGENT_COLLAB_ROLE: 'executor', DSH_AGENT_COLLAB_MARK: 'one' },
    });
    const sessionB = await newSession(client, cwdB, {
      runId: 'T002',
      title: '[collab] T002 会话 B',
      env: { DSH_AGENT_COLLAB_ROLE: 'executor', DSH_AGENT_COLLAB_MARK: 'two' },
    });
    assert.deepEqual(box.fakeDsh.collectEnv(sessionA.sessionId), { DSH_AGENT_COLLAB_ROLE: 'executor', DSH_AGENT_COLLAB_MARK: 'one' });
    assert.deepEqual(box.fakeDsh.collectEnv(sessionB.sessionId), { DSH_AGENT_COLLAB_ROLE: 'executor', DSH_AGENT_COLLAB_MARK: 'two' });

    const plain = box.fakeDsh.makeSession('plain-session', workDir(box), null).agent;
    assert.deepEqual(box.fakeDsh.shellEnv.collect({ agent: plain }), {}, '非 agent-collab 会话不应有桥接注入');

    await client.closeSession({ sessionId: sessionA.sessionId });
    await delay(30);
    assert.deepEqual(box.fakeDsh.collectEnv(sessionA.sessionId), {}, '关闭后的会话不应继续注入');
    assert.deepEqual(box.fakeDsh.collectEnv(sessionB.sessionId), { DSH_AGENT_COLLAB_ROLE: 'executor', DSH_AGENT_COLLAB_MARK: 'two' }, '关闭一个会话不应影响另一个');

    const [sessionC, sessionD] = await Promise.all([
      newSession(client, workDir(box), { runId: 'T003', title: '[collab] T003 并发 C', env: { DSH_AGENT_COLLAB_ROLE: 'executor', DSH_AGENT_COLLAB_MARK: 'three' } }),
      newSession(client, workDir(box), { runId: 'T004', title: '[collab] T004 并发 D', env: { DSH_AGENT_COLLAB_ROLE: 'executor', DSH_AGENT_COLLAB_MARK: 'four' } }),
    ]);
    assert.deepEqual(box.fakeDsh.collectEnv(sessionC.sessionId), { DSH_AGENT_COLLAB_ROLE: 'executor', DSH_AGENT_COLLAB_MARK: 'three' });
    assert.deepEqual(box.fakeDsh.collectEnv(sessionD.sessionId), { DSH_AGENT_COLLAB_ROLE: 'executor', DSH_AGENT_COLLAB_MARK: 'four' });

    box.fakeDsh.disposeAgent(sessionB.sessionId);
    assert.deepEqual(box.fakeDsh.collectEnv(sessionB.sessionId), {}, 'agent 卸载后不应继续注入');
    assert.deepEqual(box.fakeDsh.collectEnv(sessionC.sessionId), { DSH_AGENT_COLLAB_ROLE: 'executor', DSH_AGENT_COLLAB_MARK: 'three' });
    await client.close();
  } finally {
    await stopBridge(box);
  }
});

test('Web 重启后续接仍注入会话环境；agent 卸载后恢复也有；session/close 删除持久化文件', async () => {
  const home = makeTempHome();
  const cwd = fs.mkdtempSync(path.join(home, 'work-'));
  const discoveryFile = path.join(home, 'agent-collab', 'bridge-web.json');
  const envFile = (sessionId) => path.join(home, 'agent-collab', 'session-env', sessionId + '.json');
  const expected = { DSH_AGENT_COLLAB_ROLE: 'executor', DSH_AGENT_COLLAB_MARK: 'one' };
  let first = createFakeDsh({ homeDir: home });
  let second = null;
  let client = null;
  try {
    apply(first.ctx);
    await waitFor(() => fs.existsSync(discoveryFile), 4000, '第一次的发现文件');
    let discovery = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));
    client = await connect(discovery);
    await initialize(client, discovery);
    const session = await newSession(client, cwd, { env: expected });
    assert.deepEqual(first.fake.collectEnv(session.sessionId), expected);
    await client.close();
    client = null;
    first.fake.dispose();
    first = null;
    await waitFor(() => !fs.existsSync(discoveryFile), 2000, '第一次的发现文件删除');

    // 新的假 dsh 实例代表 Web 重启：同一个 DSH_HOME，内存里的会话表已经没了。
    // 假 dsh 保存的会话 cwd 要和桥接 validateCwd 一样是真实路径；否则符号链接 TMPDIR 下续接会被
    // 桥接的 cwd 校验拒绝（macOS 的 /var → /private/var）。
    const realCwd = fs.realpathSync(cwd);
    second = createFakeDsh({ homeDir: home, resumable: true, resumeCwd: realCwd, resumePreset: 'agent-collab' });
    apply(second.ctx);
    discovery = await waitFor(() => {
      try { return JSON.parse(fs.readFileSync(discoveryFile, 'utf8')); } catch { return null; }
    }, 4000, '重启后的发现文件');
    client = await connect(discovery);
    await initialize(client, discovery);
    const resumed = await client.resumeSession({ sessionId: session.sessionId, cwd, mcpServers: [] });
    assert.equal(resumed._meta.agentCollab.alreadyLoaded, false);
    assert.deepEqual(second.fake.collectEnv(session.sessionId), expected, 'Web 重启后续接应恢复会话环境');
    assert.ok(fs.existsSync(envFile(session.sessionId)), 'session/new 后应写持久化文件');
    if (process.platform !== 'win32') assert.equal(fs.statSync(envFile(session.sessionId)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(envFile(session.sessionId), 'utf8')), { v: 1, sessionId: session.sessionId, env: expected });

    assert.equal(second.fake.disposeAgent(session.sessionId), true);
    assert.deepEqual(second.fake.collectEnv(session.sessionId), {}, 'agent 卸载后不应继续注入');
    await second.fake.resumeAgentDirect(session.sessionId, realCwd, 'agent-collab');
    assert.deepEqual(second.fake.collectEnv(session.sessionId), expected, 'agent 卸载后被 Web 直接恢复也应恢复会话环境');

    const plain = second.fake.makeSession('plain-session', cwd, null).agent;
    assert.deepEqual(second.fake.shellEnv.collect({ agent: plain }), {}, '非 agent-collab 会话不应有桥接注入');

    await client.closeSession({ sessionId: session.sessionId });
    await delay(50);
    assert.equal(fs.existsSync(envFile(session.sessionId)), false, 'session/close 后应删除持久化文件');
    assert.deepEqual(second.fake.collectEnv(session.sessionId), {}, 'session/close 后不应继续注入');
  } finally {
    if (client) await client.close().catch(() => {});
    if (first) first.fake.dispose();
    if (second) second.fake.dispose();
    await delay(50);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('新工作区用目录名而不是会话标题；已有工作区不改名', async () => {
  const box = await startBridge();
  try {
    const client = await connect(box.discovery);
    await initialize(client, box.discovery);
    const cwd = workDir(box);
    // 桥接按 validateCwd 的 realpath 建工作区；临时目录本身可能是符号链接（macOS 的 /var → /private/var）。
    const realCwd = fs.realpathSync(cwd);
    const first = await newSession(client, cwd, { title: '[collab] T001 任务标题' });
    const workspace = box.fakeDsh.workspaces.find((item) => item.path === realCwd);
    assert.ok(workspace, '应创建对应工作区');
    assert.equal(workspace.title, path.basename(realCwd), '新工作区标题应为目录名');
    assert.notEqual(workspace.title, '[collab] T001 任务标题');

    const second = await newSession(client, cwd, { runId: 'T002', title: '[collab] T002 另一个标题' });
    assert.equal(second._meta.agentCollab.workspaceId, first._meta.agentCollab.workspaceId, '同一路径应复用工作区');
    assert.equal(workspace.title, path.basename(realCwd), '已有工作区不应被改名为会话标题');
    await client.close();
  } finally {
    await stopBridge(box);
  }
});

test('session/prompt：通知映射、seq/sub、截断、自己消息不回显、人发消息带 dsh-web-human', async () => {
  const box = await startBridge();
  try {
    const client = await connect(box.discovery);
    await initialize(client, box.discovery);
    const cwd = workDir(box);
    const session = await newSession(client, cwd);
    const configOptions = await client.setConfigOption({ sessionId: session.sessionId, configId: 'model', value: JSON.stringify(['fake', 'fake-model']) });
    assert.equal(configOptions.configOptions[0].currentValue, JSON.stringify(['fake', 'fake-model']));
    const updates = notifications(client);
    const prompt = client.promptText(session.sessionId, 'go', { timeoutMs: 10000 });
    await delay(20);

    const huge = 'x'.repeat(9000);
    await box.fakeDsh.emit(session.sessionId, 'turn/start', { turn: 1 });
    await box.fakeDsh.emit(session.sessionId, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { id: 'm1', role: 'assistant', content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'answer' + 'z'.repeat(9000) }] },
      usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1, totalTokens: 16 },
    });
    await box.fakeDsh.emit(session.sessionId, 'tool/call', { turn: 1, step: 2, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: huge }) });
    await box.fakeDsh.emit(session.sessionId, 'tool/result', {
      turn: 1,
      step: 2,
      message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'y'.repeat(9000) }] },
    });
    await box.fakeDsh.emit(session.sessionId, 'tool/call', { turn: 1, step: 3, callId: 'q1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q', question: 'Which?' }] }) });
    await box.fakeDsh.emit(session.sessionId, 'tool/result', { turn: 1, step: 3, message: { toolCallId: 'q1', isError: false, content: [{ type: 'text', text: 'answer' }] } });
    await box.fakeDsh.emit(session.sessionId, 'user/message', { id: 'human-1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user', rpcId: 'r1' } });
    await box.fakeDsh.emit(session.sessionId, 'user/message', { id: 'own-1', role: 'user', content: [{ type: 'text', text: 'hidden' }], source: { kind: 'agent-collab-bridge' } });
    await box.fakeDsh.emit(session.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    const result = await prompt;
    assert.equal(result.stopReason, 'end_turn');
    assert.equal(result._meta.agentCollab.endReason, 'completed');
    assert.equal(result._meta.agentCollab.stoppedBy, null);

    await delay(30);
    const standard = updates.filter((item) => item.method === 'session/update').map((item) => item.params.update);
    const thought = standard.find((update) => update.sessionUpdate === 'agent_thought_chunk');
    const message = standard.find((update) => update.sessionUpdate === 'agent_message_chunk');
    assert.equal(thought.content.text, 'think');
    assert.equal(message.content.text.length, 9000 + 6);
    assert.ok(message.content.text.startsWith('answer'));
    const toolCall = standard.find((update) => update.sessionUpdate === 'tool_call');
    assert.equal(toolCall.toolCallId, 'c1');
    assert.equal(toolCall.truncated, true);
    assert.ok(toolCall.rawInput.command.length < 9000);
    const toolResult = standard.find((update) => update.sessionUpdate === 'tool_call_update');
    assert.equal(toolResult.status, 'completed');
    assert.equal(toolResult.truncated, true);
    assert.ok(toolResult.content[0].content.text.length < 9000);
    const human = standard.find((update) => update.sessionUpdate === 'user_message_chunk');
    assert.equal(human.content.text, 'hello');
    assert.equal(updates.filter((item) => item.method === 'session/update' && item.params.update.sessionUpdate === 'user_message_chunk').length, 1);

    const assistantNotifications = updates.filter((item) => item.method === 'session/update' && (item.params.update.sessionUpdate === 'agent_thought_chunk' || item.params.update.sessionUpdate === 'agent_message_chunk'));
    assert.equal(assistantNotifications[0].params._meta.agentCollab.sub, 0);
    assert.equal(assistantNotifications[1].params._meta.agentCollab.sub, 1);
    assert.equal(assistantNotifications[0].params._meta.agentCollab.seq, assistantNotifications[1].params._meta.agentCollab.seq);
    assert.match(assistantNotifications[0].params._meta.agentCollab.at, /^\d{4}-\d{2}-\d{2}T/);

    const usage = updates.find((item) => item.method === '_agentCollab/status' && item.params.kind === 'usage');
    assert.deepEqual(usage.params.usage, { input: 10, output: 2, cacheRead: 3, cacheWrite: 1 });
    assert.ok(updates.some((item) => item.method === '_agentCollab/status' && item.params.kind === 'question_pending' && item.params.questions[0].question === 'Which?'));
    assert.ok(updates.some((item) => item.method === '_agentCollab/status' && item.params.kind === 'question_resolved' && item.params.callId === 'q1'));
    await client.close();
  } finally {
    await stopBridge(box);
  }
});

test('session/prompt：同一会话第二个 prompt 回 -32004；stoppedBy 的 client、human、null', async () => {
  const box = await startBridge();
  try {
    const client = await connect(box.discovery);
    await initialize(client, box.discovery);
    const session = await newSession(client, workDir(box));

    const first = client.promptText(session.sessionId, 'one', { timeoutMs: 10000 });
    await delay(20);
    await assert.rejects(client.promptText(session.sessionId, 'two'), (error) => error.code === -32004);
    await box.fakeDsh.emit(session.sessionId, 'turn/start', { turn: 1 });
    await box.fakeDsh.emit(session.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    const normal = await first;
    assert.equal(normal._meta.agentCollab.stoppedBy, null);

    const cancelled = client.promptText(session.sessionId, 'three', { timeoutMs: 10000 });
    await delay(20);
    await box.fakeDsh.emit(session.sessionId, 'turn/start', { turn: 2 });
    client.cancel(session.sessionId);
    await delay(20);
    await box.fakeDsh.emit(session.sessionId, 'turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } });
    const clientStop = await cancelled;
    assert.equal(clientStop.stopReason, 'cancelled');
    assert.equal(clientStop._meta.agentCollab.stoppedBy, 'client');
    assert.deepEqual(box.fakeDsh.cancels.at(-1).cause, { kind: 'user' });

    const human = client.promptText(session.sessionId, 'four', { timeoutMs: 10000 });
    await delay(20);
    await box.fakeDsh.emit(session.sessionId, 'turn/start', { turn: 3 });
    await box.fakeDsh.emit(session.sessionId, 'turn/end', { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } });
    const humanStop = await human;
    assert.equal(humanStop._meta.agentCollab.stoppedBy, 'human');
    await client.close();
  } finally {
    await stopBridge(box);
  }
});

test('truncateText：4 MiB ASCII 和中文都线性截断到 8 KiB，不产生 U+FFFD', () => {
  const cases = [
    ['ASCII', 'a'.repeat(4 * 1024 * 1024)],
    ['中文', '汉'.repeat(Math.floor(4 * 1024 * 1024 / 3))],
  ];
  for (const [label, text] of cases) {
    const started = process.hrtime.bigint();
    const result = truncateText(text);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(result.truncated, true, label + ' 应被截断');
    assert.ok(Buffer.byteLength(result.text, 'utf8') <= 8 * 1024, label + ' 截断后应不超过 8 KiB');
    assert.equal(result.text.includes('\uFFFD'), false, label + ' 不应出现 U+FFFD');
    assert.ok(elapsedMs < 200, label + ' 截断耗时 ' + elapsedMs.toFixed(1) + ' ms，应小于 200 ms');
  }
  const boundary = truncateText('a'.repeat(8191) + '汉');
  assert.equal(boundary.truncated, true);
  assert.equal(Buffer.byteLength(boundary.text, 'utf8'), 8191);
  assert.equal(boundary.text.includes('\uFFFD'), false);
});

test('session/resume：同一进程重连补发保留 stoppedBy=client', async () => {
  const box = await startBridge();
  try {
    let client = await connect(box.discovery);
    await initialize(client, box.discovery);
    const cwd = workDir(box);
    const session = await newSession(client, cwd);

    const prompt = client.promptText(session.sessionId, 'go', { timeoutMs: 10000 });
    await delay(20);
    await box.fakeDsh.emit(session.sessionId, 'turn/start', { turn: 1 });
    client.cancel(session.sessionId);
    await delay(20);
    await box.fakeDsh.emit(session.sessionId, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } });
    const stopped = await prompt;
    assert.equal(stopped._meta.agentCollab.stoppedBy, 'client');
    const endEvent = box.fakeDsh.sessions.get(session.sessionId).events.find((event) => event.type === 'turn/end');
    assert.ok(endEvent, '假 dsh 应有 turn/end 事件');

    await client.close();
    await delay(50);
    client = await connect(box.discovery);
    await initialize(client, box.discovery);
    const replayed = [];
    client.onNotification((method, params) => replayed.push({ method, params }));
    await client.resumeSession({
      sessionId: session.sessionId,
      cwd,
      mcpServers: [],
      _meta: { agentCollab: { sinceSeq: endEvent.seq - 1 } },
    });
    await delay(50);
    const turnEnd = replayed.find((item) => item.method === '_agentCollab/status' && item.params.kind === 'turn_end');
    assert.ok(turnEnd, '重连后应补发 turn_end');
    assert.equal(turnEnd.params.stoppedBy, 'client');
    assert.equal(turnEnd.params.endReason, 'aborted');
    await client.close();
  } finally {
    await stopBridge(box);
  }
});

test('session/resume：无连接期间 human 停止的记录在重连补发时仍为 human', async () => {
  const box = await startBridge();
  try {
    let client = await connect(box.discovery);
    await initialize(client, box.discovery);
    const cwd = workDir(box);
    const session = await newSession(client, cwd);
    await client.close();
    await delay(50);

    await box.fakeDsh.emit(session.sessionId, 'turn/start', { turn: 1 });
    const endSeq = await box.fakeDsh.emit(session.sessionId, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } });
    await delay(20);

    client = await connect(box.discovery);
    await initialize(client, box.discovery);
    const replayed = [];
    client.onNotification((method, params) => replayed.push({ method, params }));
    await client.resumeSession({
      sessionId: session.sessionId,
      cwd,
      mcpServers: [],
      _meta: { agentCollab: { sinceSeq: endSeq - 1 } },
    });
    await delay(50);
    const turnEnd = replayed.find((item) => item.method === '_agentCollab/status' && item.params.kind === 'turn_end');
    assert.ok(turnEnd, '重连后应补发 turn_end');
    assert.equal(turnEnd.params.stoppedBy, 'human');
    assert.equal(turnEnd.params.endReason, 'aborted');
    await client.close();
  } finally {
    await stopBridge(box);
  }
});

test('session/resume：sinceSeq 补发在返回前完成、按 (seq, sub) 去重后不缺不重、pendingApprovals 正确', async () => {
  const box = await startBridge();
  try {
    let client = await connect(box.discovery);
    await initialize(client, box.discovery);
    const cwd = workDir(box);
    const session = await newSession(client, cwd);

    const prompt = client.promptText(session.sessionId, 'go', { timeoutMs: 10000 });
    await delay(20);
    await box.fakeDsh.emit(session.sessionId, 'turn/start', { turn: 1 });
    await box.fakeDsh.emit(session.sessionId, 'assistant/message', { turn: 1, step: 1, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'one' }] } });
    await box.fakeDsh.emit(session.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    await prompt;
    await box.fakeDsh.emit(session.sessionId, 'approval/asked', { id: 'approval-1', toolName: 'write', callId: 'c1', reason: 'need write' });
    await delay(30);

    const seen = [];
    client.onNotification((method, params) => {
      if (params && params._meta && params._meta.agentCollab && Number.isInteger(params._meta.agentCollab.seq)) {
        seen.push(params._meta.agentCollab.seq + ':' + params._meta.agentCollab.sub);
      }
    });
    await client.close();
    await delay(50);

    client = await connect(box.discovery);
    await initialize(client, box.discovery);
    const replayed = [];
    client.onNotification((method, params) => {
      if (params && params._meta && params._meta.agentCollab && Number.isInteger(params._meta.agentCollab.seq)) {
        replayed.push({ key: params._meta.agentCollab.seq + ':' + params._meta.agentCollab.sub, method, params });
      }
    });
    const resumed = await client.resumeSession({
      sessionId: session.sessionId,
      cwd,
      mcpServers: [],
      _meta: { agentCollab: { sinceSeq: 2 } },
    }).catch((error) => { throw error; });
    assert.equal(resumed._meta.agentCollab.alreadyLoaded, true);
    assert.equal(resumed._meta.agentCollab.running, false);
    assert.equal(resumed._meta.agentCollab.pendingApprovals.length, 1);
    assert.equal(resumed._meta.agentCollab.pendingApprovals[0].approvalId, 'approval-1');

    await delay(50);
    const unique = new Set(replayed.map((item) => item.key));
    assert.equal(unique.size, replayed.length, '补发事件不应重复');
    assert.ok(replayed.some((item) => item.method === 'session/update' && item.params.update.sessionUpdate === 'agent_message_chunk'));
    const duplicateCount = replayed.filter((item) => seen.includes(item.key)).length;
    assert.equal(duplicateCount, 0, '客户端按 (seq, sub) 去重后不应见到重复事件');
    await client.close();
  } finally {
    await stopBridge(box);
  }
});

test('两个连接各自只收到自己的会话通知；断开不取消会话', async () => {
  const box = await startBridge();
  try {
    const a = await connect(box.discovery);
    const b = await connect(box.discovery);
    await initialize(a, box.discovery);
    await initialize(b, box.discovery);
    const sessionA = await newSession(a, workDir(box), { runId: 'T001' });
    const sessionB = await newSession(b, workDir(box), { runId: 'T002' });
    const updatesA = notifications(a);
    const updatesB = notifications(b);

    await box.fakeDsh.emit(sessionA.sessionId, 'turn/start', { turn: 1 });
    await box.fakeDsh.emit(sessionA.sessionId, 'assistant/message', { turn: 1, step: 1, message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'only-a' }] } });
    await box.fakeDsh.emit(sessionA.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    await delay(30);
    assert.ok(updatesA.some((item) => item.method === 'session/update'));
    assert.equal(updatesB.length, 0, '另一个连接不应收到通知');
    assert.deepEqual(box.fakeDsh.cancels, [], '断开连接不应取消会话');

    await a.close();
    await delay(50);
    assert.deepEqual(box.fakeDsh.cancels, [], '断开连接不应取消会话');
    const sessionB2 = await newSession(b, workDir(box), { runId: 'T003' });
    assert.ok(sessionB2.sessionId);
    await b.close();
    assert.ok(box.fakeDsh.sessions.has(sessionB2.sessionId), 'session/close 不应删除会话');
    assert.ok(box.fakeDsh.agents.has(sessionB2.sessionId), 'session/close 不应销毁 agent');
  } finally {
    await stopBridge(box);
  }
});

test('lib/jsonrpc.js 与 core/jsonrpc.mjs 内容相同', () => {
  const bridge = fs.readFileSync(path.join(repoRoot, 'dsh-bridge', 'lib', 'jsonrpc.js'), 'utf8');
  const core = fs.readFileSync(path.join(repoRoot, 'core', 'jsonrpc.mjs'), 'utf8');
  assert.equal(bridge, core);
});

test('index.js 和 acp-server.js 不直接访问 dsh 服务或 agent/session 成员', () => {
  const servicePattern = /\bctx\s*\.\s*(get|agents|sessions|llm|permissionPresets|agentPresets|workspaceRegistry|shellEnv|agentDefaultModel|sessionTitle|subagents|webApp|pluginPackages|dshHomePath)\b/;
  // 这些名字只属于 dsh 的 agent/session 对象；桥接自己的 view 用 currentSeq/readEvent 等不同名字。
  const memberPatterns = [
    /\.(?:agent|session|followup|whenIdle|status|eventAt|header|requestHeader)\b/,
    /\b(?:agent|session|resumedAgent)\s*\.\s*(?:cancel|seq)\b/,
  ];
  for (const sample of [
    'agent.followup(x)',
    'state.agent.followup(x)',
    'agent.cancel({})',
    'agent.whenIdle()',
    'agent.status',
    'session.seq',
    'session.eventAt(0)',
    'session.header',
    'agent.session.requestHeader()',
    'resumedAgent.session.requestHeader()',
  ]) {
    assert.equal(memberPatterns.some((pattern) => pattern.test(sample)), true, '访问检查应能查出：' + sample);
  }
  for (const file of ['index.js', 'acp-server.js']) {
    const text = fs.readFileSync(path.join(repoRoot, 'dsh-bridge', 'lib', file), 'utf8');
    assert.equal(servicePattern.test(text), false, file + ' 不应直接访问 dsh 服务');
    for (const pattern of memberPatterns) {
      assert.equal(pattern.test(text), false, file + ' 不应直接访问 dsh agent/session 成员');
    }
  }
});
