// 本文件：dsh 适配器 acp 退回模式的测试（DA6）：参数和环境、覆盖层、审批、续接和 worker_lost。

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { selectOverlayEntries } from '../core/adapters/dsh.mjs';
import { createDshCase, reportObject, reportText } from './helpers/dsh-case.mjs';

const webPatch = JSON.stringify([
  { id: 'llm-fake', config: { providers: { fake: { displayName: 'Fake', api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', models: [{ id: 'fake-model', name: 'Fake' }] } } } },
  { id: 'agent-default-model', config: { provider: 'fake', model: 'fake-model' } },
  { id: 'unrelated-entry', config: { x: 1 } },
]);

function acpScript(report = reportObject(), extra = {}) {
  return JSON.stringify({ updates: [reportText(report)], ...extra });
}

test('覆盖层挑选：只有服务商、只有默认模型、两者都有、无关条目、明确指定模型', () => {
  const provider = { id: 'llm-a', config: {} };
  const defaults = { id: 'agent-default-model', config: { provider: 'p', model: 'm' } };
  const unrelated = { id: 'other', config: {} };
  const onlyProvider = selectOverlayEntries([provider, unrelated], null);
  assert.deepEqual(onlyProvider.entries, [provider]);
  assert.match(onlyProvider.warning, /agent-default-model/);
  assert.equal(onlyProvider.acpModel, null);

  const onlyDefaults = selectOverlayEntries([defaults, unrelated], null);
  assert.deepEqual(onlyDefaults.entries, [defaults, { id: 'acp', config: { provider: 'p', model: 'm' } }]);
  assert.equal(onlyDefaults.acpModel.provider, 'p');

  const both = selectOverlayEntries([provider, defaults, unrelated], null);
  assert.deepEqual(both.entries, [provider, defaults, { id: 'acp', config: { provider: 'p', model: 'm' } }]);

  const explicit = selectOverlayEntries([provider, defaults], { provider: 'x', model: 'y' });
  assert.deepEqual(explicit.entries.at(-1), { id: 'acp', config: { provider: 'x', model: 'y' } });
});

test('acp 模式：只有 yaml 包没有 js-yaml 时任务 failed，不留覆盖层目录', async (t) => {
  const caseApi = await createDshCase('acp-only-yaml', {
    config: { dsh: { home: null, profile: 'web', transport: 'acp' } },
    fakeDsh: { yamlLibraries: ['yaml'] },
    env: { FAKE_ACP_SCRIPT: acpScript() },
  });
  t.after(() => caseApi.cleanup());
  await caseApi.writeWebPatch(webPatch);
  const started = await caseApi.startTask();
  const wait = await caseApi.waitTask(started.runId);
  assert.equal(wait.json.status, 'failed', wait.stdout + wait.stderr);
  assert.equal(wait.json.statusReason, 'overlay_yaml_unavailable', wait.stdout + wait.stderr);
  const overlays = await fsp.readdir(path.join(caseApi.home, 'overlays')).catch(() => []);
  assert.deepEqual(overlays.filter((name) => name.startsWith('dsh-acp-')), [], '失败时不应留下覆盖层目录');
});

test('acp 模式：没有 cordis.patch.yml 且找不到 js-yaml 时任务 failed，不留覆盖层目录', async (t) => {
  const caseApi = await createDshCase('acp-no-yaml-no-patch', {
    config: { dsh: { home: null, profile: 'web', transport: 'acp' }, model: 'fake/fake-model' },
    fakeDsh: { yamlLibraries: [] },
    env: { FAKE_ACP_SCRIPT: acpScript() },
  });
  t.after(() => caseApi.cleanup());
  const started = await caseApi.startTask();
  const wait = await caseApi.waitTask(started.runId);
  assert.equal(wait.json.status, 'failed', wait.stdout + wait.stderr);
  assert.equal(wait.json.statusReason, 'overlay_yaml_unavailable', wait.stdout + wait.stderr);
  const overlays = await fsp.readdir(path.join(caseApi.home, 'overlays')).catch(() => []);
  assert.deepEqual(overlays.filter((name) => name.startsWith('dsh-acp-')), [], '失败时不应留下覆盖层目录');
});

test('acp 模式：子进程参数、环境、覆盖层内容和 close 后删除', async (t) => {
  const caseApi = await createDshCase('acp-basic', {
    config: { dsh: { home: null, profile: 'web', transport: 'acp' }, inheritEnv: 'designer' },
    env: { FAKE_ACP_SCRIPT: acpScript(), DESIGNER_ONLY: 'designer' },
  });
  t.after(() => caseApi.cleanup());
  await caseApi.writeWebPatch(webPatch);
  const started = await caseApi.startTask();
  const wait = await caseApi.waitTask(started.runId);
  assert.equal(wait.json.status, 'done', wait.stdout + wait.stderr);
  assert.equal(wait.summary.executor.transport, 'acp');
  const records = await caseApi.records();
  assert.equal(records.length, 1);
  const record = records[0];
  assert.deepEqual(record.argv.slice(0, 2), ['--profile', 'acp']);
  assert.ok(record.argv.includes('--patch'));
  assert.equal(record.env.DSH_PERMISSION_MODE, 'workspace-write');
  assert.equal(record.env.AGENT_COLLAB_ROLE, 'executor');
  assert.equal(record.env.DSH_AGENT_COLLAB_ROLE, 'executor');
  assert.equal(record.env.DESIGNER_ONLY, 'designer');
  assert.equal(record.env.DSH_HOME, caseApi.dshHome);
  assert.match(record.patch, /llm-fake/);
  assert.match(record.patch, /agent-default-model/);
  assert.match(record.patch, /"id":"acp"/);
  assert.doesNotMatch(record.patch, /unrelated-entry/);
  const overlays = await fsp.readdir(path.join(caseApi.home, 'overlays')).catch(() => []);
  assert.deepEqual(overlays, [], 'close() 后覆盖层目录应删除');
});

test('acp 模式：inheritEnv 为 login-shell 时使用登录 shell 的环境', async (t) => {
  const caseApi = await createDshCase('acp-login-shell', {
    config: { dsh: { home: null, profile: 'web', transport: 'acp' }, inheritEnv: 'login-shell' },
    env: { FAKE_ACP_SCRIPT: acpScript() },
  });
  const shell = path.join(caseApi.root, 'fake-shell');
  await fsp.writeFile(shell, '#!/bin/sh\nexport LOGIN_ONLY=yes\nexec "' + process.execPath + '" -e \'process.stdout.write(JSON.stringify(process.env))\'\n', { mode: 0o755 });
  caseApi.env.SHELL = shell;
  t.after(() => caseApi.cleanup());
  await caseApi.writeWebPatch(webPatch);
  const started = await caseApi.startTask();
  const wait = await caseApi.waitTask(started.runId);
  assert.equal(wait.json.status, 'done', wait.stdout + wait.stderr);
  const record = (await caseApi.records())[0];
  assert.equal(record.env.LOGIN_ONLY, 'yes');
});

test('acp 模式：unattendedApproval 为 allow 和 deny 时审批应答和事件成对', async (t) => {
  for (const [mode, expected] of [['allow', 'allowed-once'], ['deny', 'rejected']]) {
    await t.test(mode, async () => {
      const caseApi = await createDshCase('acp-approval-' + mode, {
        config: { dsh: { home: null, profile: 'web', transport: 'acp' }, unattendedApproval: mode },
        env: { FAKE_ACP_SCRIPT: JSON.stringify({ updates: ['准备审批'], permission: { toolCall: { toolCallId: 'call-1', title: 'write' } }, afterPermission: reportText() }) },
      });
      try {
        await caseApi.writeWebPatch(webPatch);
        const started = await caseApi.startTask();
        const wait = await caseApi.waitTask(started.runId);
        assert.equal(wait.json.status, 'done', wait.stdout + wait.stderr);
        assert.equal(wait.summary.approvals.length, 1);
        assert.equal(wait.summary.approvals[0].outcome, expected);
        const events = await caseApi.events(started.runId);
        assert.equal(events.filter((event) => event.type === 'approval' && event.state === 'pending').length, 1);
        assert.equal(events.filter((event) => event.type === 'approval' && event.state === 'resolved').length, 1);
      } finally {
        await caseApi.cleanup();
      }
    });
  }
});

test('acp 模式：run resume 另起子进程，session/resume 后发消息', async (t) => {
  const blocked = reportObject({ status: 'blocked', summary: '需要答复' });
  const caseApi = await createDshCase('acp-resume', {
    config: { dsh: { home: null, profile: 'web', transport: 'acp' }, maxCorrectionRounds: 2 },
    env: { FAKE_ACP_SCRIPT: acpScript(blocked) },
  });
  t.after(() => caseApi.cleanup());
  await caseApi.writeWebPatch(webPatch);
  const started = await caseApi.startTask();
  const first = await caseApi.waitTask(started.runId);
  assert.equal(first.json.status, 'blocked', first.stdout + first.stderr);

  const message = path.join(caseApi.root, 'message.md');
  await fsp.writeFile(message, '请继续');
  const resumed = await caseApi.runCli(['run', 'resume', started.runId, '--kind', 'correction', '--message', message]);
  assert.equal(resumed.json.ok, true, resumed.stdout + resumed.stderr);
  const second = await caseApi.waitTask(started.runId);
  assert.equal(second.json.status, 'blocked', second.stdout + second.stderr);
  const records = await caseApi.records();
  assert.equal(records.filter((record) => record.profile === 'acp').length, 2, 'resume 应另起一个 acp 子进程');
});

test('acp 模式：工作进程被结束后 run wait 记为 failed（worker_lost）', async (t) => {
  const caseApi = await createDshCase('acp-worker-lost', {
    config: { dsh: { home: null, profile: 'web', transport: 'acp' } },
    env: { FAKE_ACP_SCRIPT: JSON.stringify({ updates: ['开始'], holdOpen: true, holdTimeoutMs: 5000 }) },
  });
  t.after(() => caseApi.cleanup());
  await caseApi.writeWebPatch(webPatch);
  const started = await caseApi.startTask();
  const deadline = Date.now() + 5000;
  let state = null;
  while (Date.now() < deadline) {
    state = await caseApi.state(started.runId).catch(() => null);
    if (state && state.executor && state.executor.sessionId) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.ok(state && state.executor.sessionId, '没有等到 sessionId');
  process.kill(state.worker.pid, 'SIGKILL');
  const wait = await caseApi.waitTask(started.runId);
  assert.equal(wait.json.status, 'failed', wait.stdout + wait.stderr);
  assert.equal(wait.json.statusReason, 'worker_lost');
});
