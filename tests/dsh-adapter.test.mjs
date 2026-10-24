// 本文件：dsh 适配器桥接路径的测试（DA2–DA4）：session/new 参数、事件 cursor、停止、取消、断线和 attach 补发。

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

import { createAdapter } from '../core/adapters/dsh.mjs';
import { JsonRpcPeer } from '../core/jsonrpc.mjs';
import { createDshCase, reportObject, reportText, turnWithReport } from './helpers/dsh-case.mjs';
import { pidAlive, waitForPidGone } from './helpers/pids.mjs';
import { runDiagnostics } from './helpers/run-harness.mjs';

const fence = String.fromCharCode(96).repeat(3);

async function waitForEvent(caseApi, runId, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const events = await caseApi.events(runId);
    if (events.some(predicate)) return events;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('timed out waiting for event');
}

async function waitForStatus(caseApi, runId, status, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await caseApi.state(runId).catch(() => null);
    if (state && state.status === status) return state;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error('timed out waiting for status ' + status);
}

test('桥接模式：任务 done，session/new 参数、env 过滤、cursor 和标题正确', async (t) => {
  const caseApi = await createDshCase('bridge-basic', { config: { env: { DSH_FOO: '1', OTHER: '2' } } });
  t.after(() => caseApi.cleanup());
  await caseApi.profile({ dependencies: { 'dsh-bridge': 'file:x' }, dsh: { profile: { bundles: ['dsh-bridge'] } } });
  await caseApi.startWeb({
    presets: [{ id: 'standard', name: 'Standard' }],
    turns: [turnWithReport(reportObject(), [
      { kind: 'tool', callId: 'call-1', name: 'bash', input: { command: 'true' } },
      { kind: 'toolResult', callId: 'call-1', output: 'ok' },
    ])],
  });
  const started = await caseApi.startTask({
    env: { AGENT_COLLAB_TEST_IDLE_TIMEOUT_MS: '60000' },
  });
  const wait = await caseApi.waitTask(started.runId);
  assert.equal(wait.json.status, 'done', wait.stdout + wait.stderr);
  assert.equal(wait.summary.executor.transport, 'bridge');

  const snapshot = await caseApi.snapshot();
  assert.equal(snapshot.titles[0].title, '[collab] T001 demo');
  assert.equal(snapshot.created[0].preset, 'standard', 'agentPreset 为默认值时桥接应按默认值（standard）处理');
  assert.deepEqual(snapshot.created[0].agentOptions, { provider: 'fake', model: 'fake-model', reasoningEffort: 'high' });
  const env = snapshot.registeredEnv[0];
  assert.ok(env.variables.includes('DSH_AGENT_COLLAB_ROLE'));
  assert.ok(env.variables.includes('DSH_FOO'));
  assert.ok(!env.variables.includes('OTHER'));
  assert.equal(env.resolved.DSH_AGENT_COLLAB_ROLE, 'executor');
  assert.equal(env.resolved.DSH_FOO, '1');

  const events = await caseApi.events(started.runId);
  for (const type of ['tool_call', 'tool_result', 'text', 'turn_end']) {
    const event = events.find((item) => item.type === type);
    assert.ok(event, '缺少事件 ' + type);
    assert.ok(event.cursor && Number.isInteger(event.cursor.seq) && Number.isInteger(event.cursor.sub), type + ' 缺少 cursor');
  }
  const cursors = events.filter((item) => item.type === 'text' || item.type === 'tool_call' || item.type === 'tool_result' || item.type === 'turn_end').map((item) => item.cursor.seq);
  for (let index = 1; index < cursors.length; index += 1) assert.ok(cursors[index] >= cursors[index - 1], 'cursor 不单调');
  assert.ok(wait.summary.warnings.some((message) => message.includes('OTHER')), '被丢弃的 env 键应有一条 warning');
});

test('桥接模式：session/new 失败后任务 failed（executor_error），工作进程退出', async (t) => {
  const caseApi = await createDshCase('bridge-new-session-error');
  let workerPid = null;
  let workerGone = true;
  t.after(async () => {
    if (Number.isInteger(workerPid) && pidAlive(workerPid)) {
      try { process.kill(workerPid, 'SIGKILL'); } catch { /* 已退出。 */ }
      await waitForPidGone(workerPid, 2000);
    }
    await caseApi.cleanup();
  });
  await caseApi.profile({ dependencies: { 'dsh-bridge': 'file:x' }, dsh: { profile: { bundles: ['dsh-bridge'] } } });
  await caseApi.startWeb({ createError: 'session/new failed for test' });
  const started = await caseApi.startTask();
  const state = await waitForStatus(caseApi, started.runId, 'failed');
  workerPid = state.worker && Number.isInteger(state.worker.pid) ? state.worker.pid : started.workerPid;
  assert.equal(state.statusReason, 'executor_error');
  workerGone = await waitForPidGone(workerPid, 3000);
  const log = await fsp.readFile(path.join(await caseApi.runDir(started.runId), 'worker.log'), 'utf8');
  assert.match(log, /任务结束：failed（executor_error）/);
  assert.equal(workerGone, true, '任务 failed 后工作进程仍未退出（pid ' + workerPid + '）');
});

test('桥接模式：在 dsh Web 里停止的一轮记为 stopped_by_human', async (t) => {
  const caseApi = await createDshCase('bridge-human-stop');
  t.after(() => caseApi.cleanup());
  await caseApi.profile({ dependencies: { 'dsh-bridge': 'file:x' } });
  await caseApi.startWeb({ turns: [[{ kind: 'text', text: '开始' }, { kind: 'humanStop' }]] });
  const started = await caseApi.startTask();
  const wait = await caseApi.waitTask(started.runId);
  assert.equal(wait.json.status, 'stopped_by_human', wait.stdout + wait.stderr);
  assert.equal(wait.summary.turns[0].stoppedBy, 'human');
});

test('桥接模式：run cancel 后记为 cancelled', async (t) => {
  const caseApi = await createDshCase('bridge-cancel');
  t.after(() => caseApi.cleanup());
  await caseApi.profile({ dependencies: { 'dsh-bridge': 'file:x' } });
  await caseApi.startWeb({ turns: [[{ kind: 'text', text: '等待取消' }, { kind: 'waitCancel' }]] });
  const started = await caseApi.startTask();
  await waitForEvent(caseApi, started.runId, (event) => event.type === 'text');
  const cancel = await caseApi.runCli(['run', 'cancel', started.runId]);
  assert.equal(cancel.json.status, 'cancelled', cancel.stdout + cancel.stderr);
  const wait = await caseApi.waitTask(started.runId);
  assert.equal(wait.json.status, 'cancelled');
});

function splitReport() {
  const report = reportObject({ summary: 'attach 后的汇报' });
  const text = reportText(report);
  const middle = Math.floor(text.length / 2);
  return { report, text, a: text.slice(0, middle), b: text.slice(middle) };
}

test('attach：工作进程不在期间这一轮结束，finalText 按 A+B 计算且事件不缺不重', async (t) => {
  const caseApi = await createDshCase('attach-ended');
  t.after(() => caseApi.cleanup());
  await caseApi.profile({ dependencies: { 'dsh-bridge': 'file:x' } });
  const { report, a, b } = splitReport();
  await caseApi.startWeb({ turns: [[
    { kind: 'tool', callId: 'call-1', name: 'bash', input: { command: 'true' } },
    { kind: 'toolResult', callId: 'call-1', output: 'ok' },
    { kind: 'text', text: a },
    { kind: 'sleep', ms: 1500 },
    { kind: 'text', text: b },
    { kind: 'turnEnd' },
  ]] });
  const started = await caseApi.startTask();
  const before = await waitForEvent(caseApi, started.runId, (event) => event.type === 'text' && event.text === a);
  const state = await caseApi.state(started.runId);
  process.kill(state.worker.pid, 'SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const wait = await caseApi.waitTask(started.runId);
  assert.equal(wait.json.status, 'done', wait.stdout + wait.stderr);
  assert.deepEqual(wait.summary.report, report);

  const events = await caseApi.events(started.runId);
  assert.equal(events.filter((event) => event.type === 'text' && event.text === a).length, 1);
  assert.equal(events.filter((event) => event.type === 'text' && event.text === b).length, 1);
  for (let index = 1; index < events.length; index += 1) assert.equal(events[index].n, events[index - 1].n + 1, 'n 不连续');
});

test('attach：接上时这一轮仍在进行，以 turn_end 通知结束', async (t) => {
  const caseApi = await createDshCase('attach-running');
  t.after(() => caseApi.cleanup());
  await caseApi.profile({ dependencies: { 'dsh-bridge': 'file:x' } });
  const { report, a, b } = splitReport();
  await caseApi.startWeb({ turns: [[
    { kind: 'tool', callId: 'call-1', name: 'bash', input: { command: 'true' } },
    { kind: 'toolResult', callId: 'call-1', output: 'ok' },
    { kind: 'text', text: a },
    { kind: 'sleep', ms: 3000 },
    { kind: 'text', text: b },
    { kind: 'turnEnd' },
  ]] });
  const started = await caseApi.startTask();
  await waitForEvent(caseApi, started.runId, (event) => event.type === 'text' && event.text === a);
  const state = await caseApi.state(started.runId);
  process.kill(state.worker.pid, 'SIGKILL');
  const wait = await caseApi.waitTask(started.runId);
  assert.equal(wait.json.status, 'done', wait.stdout + wait.stderr);
  assert.deepEqual(wait.summary.report, report);
});

test('桥接断开：进行中的一轮以 failed 结束，statusReason 说明原因', async (t) => {
  const caseApi = await createDshCase('disconnect');
  t.after(() => caseApi.cleanup());
  await caseApi.profile({ dependencies: { 'dsh-bridge': 'file:x' } });
  await caseApi.startWeb({ turns: [[{ kind: 'text', text: '开始' }, { kind: 'sleep', ms: 5000 }, { kind: 'text', text: '结束' }]] });
  const started = await caseApi.startTask();
  await waitForEvent(caseApi, started.runId, (event) => event.type === 'text');
  const discovery = JSON.parse(await fsp.readFile(path.join(caseApi.dshHome, 'agent-collab', 'bridge-web.json'), 'utf8'));
  process.kill(discovery.pid, 'SIGTERM');
  const wait = await caseApi.waitTask(started.runId);
  const runDir = await caseApi.runDir(started.runId);
  // 断言失败时带上 state.json、worker.log 最后 40 行和最近事件：CI 上看得出是工作进程崩了
  // （worker.log 里有未捕获异常的堆栈）还是它没来得及写终态就被判定丢了。
  const diagnostics = await runDiagnostics(runDir);
  assert.equal(wait.json.status, 'failed', wait.stdout + wait.stderr + '\n' + diagnostics);
  assert.equal(wait.json.statusReason, 'dsh_disconnected', wait.stdout + wait.stderr + '\n' + diagnostics);
  const log = await fsp.readFile(path.join(runDir, 'worker.log'), 'utf8');
  assert.match(log, /dsh 连接断开/);
});

async function directAdapter(caseApi, events) {
  const config = {
    dsh: { home: caseApi.dshHome, profile: 'web', transport: 'auto', autoStartWeb: false, openBrowserOnStart: false, webArgs: [] },
    executors: { dsh: { command: caseApi.fake.link } },
    permissionPreset: 'workspace-write',
    unattendedApproval: 'deny',
    inheritEnv: 'designer',
    reasoningEffort: 'follow',
  };
  return createAdapter({
    config,
    onEvent: (event) => events.push(event),
    env: {},
    state: { repoRoot: caseApi.repo, executor: { transport: null } },
  });
}

test('attach 的 finalText 与不杀工作进程时算出的结果完全相同', async (t) => {
  const script = [[
    { kind: 'tool', callId: 'call-1', name: 'bash', input: { command: 'true' } },
    { kind: 'toolResult', callId: 'call-1', output: 'ok' },
    { kind: 'text', text: '第一段，' },
    { kind: 'sleep', ms: 800 },
    { kind: 'text', text: '第二段。' },
    { kind: 'turnEnd' },
  ]];

  const baseline = await createDshCase('finaltext-baseline');
  t.after(() => baseline.cleanup());
  await baseline.profile({ dependencies: { 'dsh-bridge': 'file:x' } });
  await baseline.startWeb({ turns: script });
  const baselineEvents = [];
  const baselineAdapter = await directAdapter(baseline, baselineEvents);
  const baselineStart = await baselineAdapter.start({ cwd: baseline.repo, runId: 'T001', title: 'x', brief: 'x', options: { permissionPreset: 'workspace-write', unattendedApproval: 'deny', agentPreset: 'agent-collab', reasoningEffort: 'follow' }, env: {} });
  const baselineResult = await baselineStart.turn;
  await baselineAdapter.close();
  assert.equal(baselineResult.finalText, '第一段，第二段。');

  const attachedCase = await createDshCase('finaltext-attach');
  t.after(() => attachedCase.cleanup());
  await attachedCase.profile({ dependencies: { 'dsh-bridge': 'file:x' } });
  await attachedCase.startWeb({ turns: script });
  const attachedEvents = [];
  const first = await directAdapter(attachedCase, attachedEvents);
  const firstStart = await first.start({ cwd: attachedCase.repo, runId: 'T001', title: 'x', brief: 'x', options: { permissionPreset: 'workspace-write', unattendedApproval: 'deny', agentPreset: 'agent-collab', reasoningEffort: 'follow' }, env: {} });
  firstStart.turn.catch(() => {});
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !attachedEvents.some((event) => event.type === 'text' && event.text === '第一段，')) await new Promise((resolve) => setTimeout(resolve, 20));
  const cursor = attachedEvents.filter((event) => event.cursor).at(-1).cursor;
  await first.close();
  const second = await directAdapter(attachedCase, []);
  const attached = await second.attach({ sessionId: firstStart.sessionId, sinceCursor: cursor });
  assert.equal(attached.attached, true);
  const attachedResult = attached.turn ? await attached.turn : attached.result;
  await second.close();
  assert.equal(attachedResult.finalText, baselineResult.finalText);
});

test('桥接 session/new 失败时适配器关闭连接', async (t) => {
  const caseApi = await createDshCase('bridge-new-session-socket');
  t.after(() => caseApi.cleanup());
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setNoDelay(true);
    const peer = new JsonRpcPeer({ readable: socket, writable: socket, name: 'fake-bridge-new-session-error' });
    peer.onRequest('initialize', () => ({ protocolVersion: 1, agentInfo: { name: 'x', version: '0' }, agentCapabilities: { promptCapabilities: { image: false } } }));
    peer.onRequest('session/new', () => { throw new Error('session/new failed for test'); });
    peer.onRequest('session/prompt', () => new Promise(() => {}));
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const file = path.join(caseApi.dshHome, 'agent-collab', 'bridge-web.json');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({
    v: 1, host: '127.0.0.1', port, token: 't', pid: process.pid, protocol: 1, protocolMin: 1,
    bridgeVersion: '0.0.0', dshVersion: '0.2.1', profile: 'web', startedAt: new Date().toISOString(),
  }));
  const config = { dsh: { home: caseApi.dshHome, profile: 'web', transport: 'bridge', autoStartWeb: false }, executors: { dsh: { command: caseApi.fake.link } }, permissionPreset: 'workspace-write', unattendedApproval: 'deny', inheritEnv: 'designer' };
  const adapter = createAdapter({ config, onEvent: () => {}, env: {}, state: { repoRoot: caseApi.repo, executor: {} } });
  try {
    await assert.rejects(adapter.start({ cwd: caseApi.repo, runId: 'T001', title: 'x', brief: 'x', options: { permissionPreset: 'workspace-write', unattendedApproval: 'deny', agentPreset: 'agent-collab' }, env: {} }), /session\/new failed for test/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(sockets.size, 0, 'session/new 失败后适配器没有关闭 TCP 连接');
  } finally {
    for (const socket of sockets) socket.destroy();
    await adapter.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});

test('桥接连接被对端重置时适配器关闭底层 socket，不留句柄', async (t) => {
  const caseApi = await createDshCase('disconnect-socket');
  t.after(() => caseApi.cleanup());
  await caseApi.profile({ dependencies: { 'dsh-bridge': 'file:x' } });
  let closed = false;
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    const peer = new JsonRpcPeer({ readable: socket, writable: socket, name: 'fake-bridge' });
    peer.onRequest('initialize', () => ({ protocolVersion: 1, agentInfo: { name: 'x', version: '0' }, agentCapabilities: { promptCapabilities: { image: false } } }));
    peer.onRequest('session/new', () => ({ sessionId: 'session-1', configOptions: [] }));
    peer.onRequest('session/prompt', () => {
      // 先触发 JsonRpcPeer 的 close（超长行），但不主动关闭 TCP 连接；适配器必须自己 close。
      setTimeout(() => socket.write('x'.repeat(17 * 1024 * 1024) + '\n'), 50);
      return new Promise(() => {});
    });
    socket.on('close', () => { closed = true; });
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  const file = path.join(caseApi.dshHome, 'agent-collab', 'bridge-web.json');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({
    v: 1, host: '127.0.0.1', port, token: 't', pid: process.pid, protocol: 1, protocolMin: 1,
    bridgeVersion: '0.0.0', dshVersion: '0.2.1', profile: 'web', startedAt: new Date().toISOString(),
  }));
  const config = { dsh: { home: caseApi.dshHome, profile: 'web', transport: 'bridge', autoStartWeb: false }, executors: { dsh: { command: caseApi.fake.link } }, permissionPreset: 'workspace-write', unattendedApproval: 'deny', inheritEnv: 'designer' };
  const adapter = createAdapter({ config, onEvent: () => {}, env: {}, state: { repoRoot: caseApi.repo, executor: {} } });
  try {
    const started = await adapter.start({ cwd: caseApi.repo, runId: 'T001', title: 'x', brief: 'x', options: { permissionPreset: 'workspace-write', unattendedApproval: 'deny', agentPreset: 'agent-collab' }, env: {} });
    await assert.rejects(started.turn, /连接断开|JSON-RPC|line exceeds/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(closed, true, '适配器没有调用 client.close()，底层 socket 仍在');
  } finally {
    await adapter.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
