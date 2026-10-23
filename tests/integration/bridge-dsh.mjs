// 本文件：桥接的集成测试。在临时 DSH_HOME 里装桥接和测试插件，用假 LLM 服务跑通发现文件、会话、审批、取消和重连补发；退出前清理所有自建进程和目录。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AcpClient } from '../../core/acp-client.mjs';
import {
  assertTempHome,
  createSandbox,
  enablePnpm,
  findDsh,
  runDsh,
  startWeb,
  stopChild,
  waitFor,
} from './dsh-harness.mjs';
import { createFakeLlm } from '../fixtures/fake-llm.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  throw new Error(message);
}

function unpack(result, label) {
  if (result.status !== 0) fail(label + ' 失败（退出码 ' + result.status + '）：' + (result.stderr || result.error || '').slice(-2000));
}

function pack(dir, destination, env) {
  fs.mkdirSync(destination, { recursive: true });
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['pack', '--json', '--pack-destination', destination], {
    cwd: dir,
    env,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  unpack({ status: result.status, stderr: result.stderr }, 'npm pack ' + path.basename(dir));
  const parsed = JSON.parse(result.stdout);
  if (!parsed[0] || typeof parsed[0].filename !== 'string') fail('npm pack 没有报告文件名：' + path.basename(dir));
  return path.join(destination, parsed[0].filename);
}

function profilePatch(fakeUrl) {
  return [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      fake:',
    '        displayName: Fake Provider',
    '        api: openai-completions',
    '        baseURL: ' + fakeUrl,
    '        headers:',
    '          authorization: Bearer fake-key',
    '        models:',
    '          - id: fake-model',
    '            name: Fake Model',
    '            contextWindow: 8192',
    '          - id: fake-model-2',
    '            name: Fake Model 2',
    '            contextWindow: 8192',
    '- id: agent-default-model',
    '  config:',
    '    provider: fake',
    '    model: fake-model',
    '',
  ].join('\n');
}

function sessionMeta(extra = {}) {
  return {
    runId: 'T001',
    title: '[collab] T001 桥接集成测试',
    agentPreset: null,
    permissionPreset: 'read-only',
    model: null,
    reasoningEffort: null,
    attachWorkspace: true,
    env: { DSH_AGENT_COLLAB_ROLE: 'executor' },
    ...extra,
  };
}

async function connectAndInitialize(discovery) {
  const client = await AcpClient.connectTcp({ host: discovery.host, port: discovery.port });
  await client.initialize({
    _meta: { agentCollab: { token: discovery.token, protocol: 1, protocolMin: 1, clientVersion: 'bridge-integration' } },
  });
  return client;
}

async function main() {
  const box = createSandbox('bridge-dsh');
  const responses = [
    { toolCalls: [{ name: 'bash', arguments: { command: 'printf "%s" "__ROLE_ENV__"', description: 'Print the injected role' } }] },
    { text: 'ROLE_OK' },
    { toolCalls: [{ name: 'write', arguments: { file_path: '', content: 'outside', sandbox_permissions: 'danger-full-access', justification: 'The integration test needs to write one file outside the workspace.' } }] },
    { text: 'WRITE_DONE' },
    { text: 'CANCEL_ME', delayMs: 2500 },
    { text: 'HUMAN_STOP_ME', delayMs: 2500 },
    { text: 'AFTER_RESUME' },
  ];
  responses[0].toolCalls[0].arguments.command = 'printf "%s" "$' + 'DSH_AGENT_COLLAB_ROLE"';
  const fake = await createFakeLlm({ responses });
  let web = null;
  let client = null;
  let passed = false;
  try {
    assertTempHome(box.env);
    const dsh = findDsh(box.env);
    enablePnpm(box.env, box.root);

    const outDir = path.join(box.root, 'packs');
    const build = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build.mjs'), '--out', outDir], {
      cwd: repoRoot,
      env: box.env,
      encoding: 'utf8',
    });
    unpack({ status: build.status, stderr: build.stderr }, '构建桥接 .tgz');
    const bridgeTgz = path.join(outDir, 'dsh-bridge-' + JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version + '.tgz');
    if (!fs.existsSync(bridgeTgz)) fail('构建产物不存在：' + bridgeTgz);

    const testPluginTgz = pack(path.join(repoRoot, 'tests', 'fixtures', 'dsh-test-plugin'), outDir, box.env);
    const addBridge = runDsh(box.env, dsh, ['plugin', '--profile', 'web', 'add', bridgeTgz], { timeoutMs: 180000 });
    unpack(addBridge, 'dsh plugin add 桥接');
    const addTestPlugin = runDsh(box.env, dsh, ['plugin', '--profile', 'web', 'add', testPluginTgz], { timeoutMs: 180000 });
    unpack(addTestPlugin, 'dsh plugin add 测试插件');

    const work = path.join(box.root, 'workspace');
    fs.mkdirSync(work, { recursive: true });
    const outside = path.join(box.root, 'outside.txt');
    responses[2].toolCalls[0].arguments.file_path = outside;
    fs.writeFileSync(path.join(box.home, 'profiles', 'web', 'cordis.patch.yml'), profilePatch(fake.url));

    web = await startWeb(box.env, dsh, { cwd: work });
    const discoveryFile = path.join(box.home, 'agent-collab', 'bridge-web.json');
    await waitFor(() => fs.existsSync(discoveryFile), 30000, '发现文件');
    const discovery = JSON.parse(fs.readFileSync(discoveryFile, 'utf8'));
    if (discovery.problem !== undefined) fail('发现文件带 problem：' + discovery.problem);
    if (discovery.dshVersion === undefined) fail('发现文件缺少 dshVersion');
    if (process.platform !== 'win32' && (fs.statSync(discoveryFile).mode & 0o777) !== 0o600) fail('发现文件权限不是 0600');

    const wrong = await AcpClient.connectTcp({ host: discovery.host, port: discovery.port });
    let wrongRejected = false;
    try {
      await wrong.initialize({ _meta: { agentCollab: { token: 'wrong', protocol: 1, protocolMin: 1, clientVersion: 'x' } } });
    } catch (error) {
      wrongRejected = error.code === -32001;
    }
    await wrong.close().catch(() => {});
    if (!wrongRejected) fail('错误令牌没有被 -32001 拒绝');

    client = await connectAndInitialize(discovery);
    const notifications = [];
    client.onNotification((method, params) => notifications.push({ method, params }));
    const created = await client.newSession({ cwd: work, mcpServers: [], _meta: { agentCollab: sessionMeta() } });
    if (created._meta.agentCollab.agentPreset !== 'agent-collab') fail('会话没有挂上 agent-collab 预设');
    if (created._meta.agentCollab.presetFallback !== null) fail('agent-collab 预设不应退回');
    if (created._meta.agentCollab.workspaceId === null) fail('会话没有挂到工作区');
    if (created._meta.agentCollab.permission.sandbox !== 'read-only') fail('权限不是 read-only');

    const observerFile = path.join(box.home, 'test-observer.json');
    const observer = await waitFor(() => {
      try {
        const data = JSON.parse(fs.readFileSync(observerFile, 'utf8'));
        const observed = data.sessions.find((item) => item.id === created.sessionId);
        const workspace = data.workspaces.find((item) => item.id === created._meta.agentCollab.workspaceId);
        return observed && workspace && workspace.sessionIds.includes(created.sessionId) ? data : null;
      } catch {
        return null;
      }
    }, 10000, '测试插件报告会话和工作区');
    const observed = observer.sessions.find((item) => item.id === created.sessionId);
    if (observed.preset !== 'agent-collab') fail('测试插件报告的预设不是 agent-collab');

    const rolePrompt = await client.promptText(created.sessionId, 'Check the role environment variable.', { timeoutMs: 120000 });
    if (rolePrompt._meta.agentCollab.endReason !== 'completed') fail('第一次 prompt 没有正常结束');
    const toolResultMessage = fake.requests[1] && fake.requests[1].body && fake.requests[1].body.messages.at(-1);
    if (!toolResultMessage || !String(toolResultMessage.content).includes('executor')) fail('DSH_AGENT_COLLAB_ROLE 没有被注入或工具结果没有回到模型');

    const switched = await client.setConfigOption({ sessionId: created.sessionId, configId: 'model', value: JSON.stringify(['fake', 'fake-model-2']) });
    if (!switched.configOptions.some((option) => option.id === 'model' && option.currentValue === JSON.stringify(['fake', 'fake-model-2']))) fail('session/set_config_option 没有切换到 fake-model-2');

    const approvalPrompt = await client.promptText(created.sessionId, 'Write the outside file.', { timeoutMs: 120000 });
    if (approvalPrompt._meta.agentCollab.endReason !== 'completed') fail('审批后 prompt 没有正常结束');
    if (!fake.requests[2] || !fake.requests[2].body || fake.requests[2].body.model !== 'fake-model-2') fail('切换模型后下一次请求没有使用 fake-model-2');
    await waitFor(() => fs.existsSync(outside), 5000, '审批后写出的文件');
    const statuses = notifications.filter((item) => item.method === '_agentCollab/status').map((item) => item.params);
    if (!statuses.some((item) => item.kind === 'approval_pending')) fail('没有收到 approval_pending');
    if (!statuses.some((item) => item.kind === 'approval_resolved' && item.outcome === 'allowed-once')) fail('没有收到 approval_resolved/allowed-once');
    if (!notifications.some((item) => item.method === 'session/update' && item.params.update.sessionUpdate === 'tool_call')) fail('没有收到 tool_call 通知');

    const cancelPromise = client.promptText(created.sessionId, 'Wait and be cancelled.', { timeoutMs: 120000 });
    await delay(400);
    client.cancel(created.sessionId);
    const cancelled = await cancelPromise;
    if (cancelled._meta.agentCollab.stoppedBy !== 'client') fail('session/cancel 的 stoppedBy 不是 client');
    if (cancelled._meta.agentCollab.endReason !== 'aborted') fail('session/cancel 的 endReason 不是 aborted');

    const humanPromise = client.promptText(created.sessionId, 'Wait for a human stop.', { timeoutMs: 120000 });
    await delay(300);
    fs.writeFileSync(path.join(box.home, 'test-control.json'), JSON.stringify({ action: 'cancel', sessionId: created.sessionId }));
    const humanStopped = await humanPromise;
    if (humanStopped._meta.agentCollab.stoppedBy !== 'human') fail('测试插件取消的 stoppedBy 不是 human');

    const seen = new Map();
    for (const item of notifications) {
      const meta = item.params && item.params._meta && item.params._meta.agentCollab;
      if (meta && Number.isInteger(meta.seq)) seen.set(meta.seq + ':' + meta.sub, item);
    }
    const firstSeq = Math.min(...[...seen.keys()].map((key) => Number(key.split(':')[0])));
    const sinceSeq = Math.max(1, firstSeq - 1);
    await client.close();
    client = null;
    await delay(200);
    client = await connectAndInitialize(discovery);
    const replayed = [];
    client.onNotification((method, params) => replayed.push({ method, params }));
    const resumed = await client.resumeSession({ sessionId: created.sessionId, cwd: work, mcpServers: [], _meta: { agentCollab: { sinceSeq } } });
    if (resumed._meta.agentCollab.alreadyLoaded !== true) fail('同进程重连后的 alreadyLoaded 不是 true');
    await delay(200);
    const replayKeys = new Map();
    for (const item of replayed) {
      const meta = item.params && item.params._meta && item.params._meta.agentCollab;
      if (meta && Number.isInteger(meta.seq)) {
        const key = meta.seq + ':' + meta.sub;
        if (replayKeys.has(key)) fail('补发事件重复：' + key);
        replayKeys.set(key, item);
      }
    }
    for (const [key] of seen) {
      const seq = Number(key.split(':')[0]);
      if (seq > sinceSeq && !replayKeys.has(key)) fail('补发缺少事件：' + key);
    }

    await client.closeSession({ sessionId: created.sessionId });
    await client.close();
    client = null;

    await stopChild(web.child);
    web = null;
    await waitFor(() => !fs.existsSync(discoveryFile), 10000, '退出后删除发现文件');
    passed = true;
    console.log('RESULT: 通过 — 临时 DSH_HOME 中完成插件安装、发现文件、会话、工具、审批、取消、Web 内停止和重连补发；退出后发现文件已删除。');
  } finally {
    if (client) await client.close().catch(() => {});
    if (web) await stopChild(web.child).catch(() => {});
    await fake.close().catch(() => {});
    box.cleanup();
  }
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(error && error.stack ? error.stack : String(error));
  console.log('RESULT: 不通过 — ' + (error && error.message ? error.message : String(error)));
});
