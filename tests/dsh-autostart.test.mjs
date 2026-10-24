// 本文件：dsh 适配器的自动启动 Web 和退回 acp 测试（DA5）。

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { createDshCase, reportObject, reportText } from './helpers/dsh-case.mjs';

function acpScript(report = reportObject()) {
  return JSON.stringify({ updates: [reportText(report)] });
}

function webRecords(records) {
  return records.filter((record) => record.profile === 'web');
}

test('没装桥接：不启动 Web，退回 acp，warning 说明原因', async (t) => {
  const caseApi = await createDshCase('fallback-missing', { env: { FAKE_ACP_SCRIPT: acpScript() } });
  t.after(() => caseApi.cleanup());
  const started = await caseApi.startTask();
  const wait = await caseApi.waitTask(started.runId);
  assert.equal(wait.json.status, 'done', wait.stdout + wait.stderr);
  assert.equal(wait.summary.executor.transport, 'acp');
  assert.equal(webRecords(await caseApi.records()).length, 0, '没装桥接时不能启动 Web');
  assert.ok(wait.summary.warnings.some((message) => message.includes('没有装桥接')));
  assert.ok(wait.summary.warnings.some((message) => message.includes('退回')));
});

test('autoStartWeb 为 true：只启动一次，参数含 --profile、--no-open 和 webArgs', async (t) => {
  const caseApi = await createDshCase('autostart', {
    config: { dsh: { home: null, profile: 'web', transport: 'auto', autoStartWeb: true, openBrowserOnStart: false, webArgs: ['--port', '0'] } },
    env: { FAKE_DSH_TURNS: JSON.stringify([[{ kind: 'text', text: reportText() }]]) },
  });
  t.after(() => caseApi.cleanup());
  await caseApi.profile({ dependencies: { 'dsh-bridge': 'file:x' } });
  const started = await caseApi.startTask();
  const wait = await caseApi.waitTask(started.runId);
  assert.equal(wait.json.status, 'done', wait.stdout + wait.stderr);
  assert.equal(wait.summary.executor.transport, 'bridge');
  const records = await caseApi.records();
  assert.equal(webRecords(records).length, 1, '只应启动一个 Web');
  const argv = webRecords(records)[0].argv;
  assert.ok(argv.includes('--profile') && argv.includes('--no-open') && argv.includes('--port') && argv.includes('0'));
});

test('autoStartWeb 为 false：不启动 Web，退回 acp', async (t) => {
  const caseApi = await createDshCase('autostart-off', { env: { FAKE_ACP_SCRIPT: acpScript() } });
  t.after(() => caseApi.cleanup());
  await caseApi.profile({ dependencies: { 'dsh-bridge': 'file:x' } });
  const started = await caseApi.startTask();
  const wait = await caseApi.waitTask(started.runId);
  assert.equal(wait.json.status, 'done', wait.stdout + wait.stderr);
  assert.equal(wait.summary.executor.transport, 'acp');
  assert.equal(webRecords(await caseApi.records()).length, 0);
});

test('启动的 Web 提前退出：退回 acp，warning 写明原因和 pid', async (t) => {
  const caseApi = await createDshCase('web-exit', {
    config: { dsh: { home: null, profile: 'web', transport: 'auto', autoStartWeb: true, openBrowserOnStart: false, webArgs: ['--port', '0'] } },
    env: { FAKE_ACP_SCRIPT: acpScript(), FAKE_DSH_WEB_MODE: 'exit', AGENT_COLLAB_TEST_WEB_START_TIMEOUT_MS: '2000' },
  });
  t.after(() => caseApi.cleanup());
  await caseApi.profile({ dependencies: { 'dsh-bridge': 'file:x' } });
  const started = await caseApi.startTask();
  const wait = await caseApi.waitTask(started.runId);
  assert.equal(wait.json.status, 'done', wait.stdout + wait.stderr);
  assert.equal(wait.summary.executor.transport, 'acp');
  const warning = wait.summary.warnings.find((message) => message.includes('提前退出'));
  assert.ok(warning, '缺少提前退出的 warning');
  assert.match(warning, /Web pid \d+/);
});

test('等发现文件超时：退回 acp，warning 写明原因和 pid，进程不结束', async (t) => {
  const caseApi = await createDshCase('web-timeout', {
    config: { dsh: { home: null, profile: 'web', transport: 'auto', autoStartWeb: true, openBrowserOnStart: false, webArgs: ['--port', '0'] } },
    env: { FAKE_ACP_SCRIPT: acpScript(), FAKE_DSH_WEB_MODE: 'no-discovery', AGENT_COLLAB_TEST_WEB_START_TIMEOUT_MS: '300' },
  });
  const leftover = [];
  t.after(async () => {
    for (const pid of leftover) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ }
    }
    await caseApi.cleanup();
  });
  await caseApi.profile({ dependencies: { 'dsh-bridge': 'file:x' } });
  const started = await caseApi.startTask();
  const wait = await caseApi.waitTask(started.runId);
  assert.equal(wait.json.status, 'done', wait.stdout + wait.stderr);
  assert.equal(wait.summary.executor.transport, 'acp');
  const warning = wait.summary.warnings.find((message) => message.includes('超时'));
  assert.ok(warning, '缺少超时的 warning');
  const matched = /Web pid (\d+)/.exec(warning);
  assert.ok(matched, 'warning 里没有 Web pid');
  leftover.push(Number(matched[1]));
});

test('两个仓库同时派发、都需要自动启动：只启动一个 Web', async (t) => {
  const caseApi = await createDshCase('two-repos', {
    config: { dsh: { home: null, profile: 'web', transport: 'auto', autoStartWeb: true, openBrowserOnStart: false, webArgs: ['--port', '0'] } },
    env: { FAKE_DSH_TURNS: JSON.stringify([[{ kind: 'text', text: reportText() }]]) },
  });
  t.after(() => caseApi.cleanup());
  await caseApi.profile({ dependencies: { 'dsh-bridge': 'file:x' } });
  const repo2 = path.join(caseApi.root, 'repo2');
  await fsp.mkdir(repo2, { recursive: true });
  const git = (await import('node:child_process')).execFile;
  const runGit = async (args) => new Promise((resolve, reject) => {
    git('git', args, { cwd: repo2, env: process.env }, (error) => (error ? reject(error) : resolve()));
  });
  await runGit(['init', '-q', '-b', 'main']);
  await runGit(['config', 'user.email', 'test@example.com']);
  await runGit(['config', 'user.name', 'test']);
  await runGit(['config', 'commit.gpgsign', 'false']);
  await fsp.writeFile(path.join(repo2, 'a.txt'), 'x');
  await runGit(['add', '-A']);
  await runGit(['commit', '-qm', 'init']);

  const brief1 = path.join(caseApi.root, 'brief1.md');
  const brief2 = path.join(caseApi.root, 'brief2.md');
  await fsp.writeFile(brief1, 'one');
  await fsp.writeFile(brief2, 'two');
  const [start1, start2] = await Promise.all([
    caseApi.runCli(['run', 'start', '--executor', 'dsh', '--brief', brief1, '--title', 'one']),
    caseApi.runCli(['run', 'start', '--executor', 'dsh', '--brief', brief2, '--title', 'two'], { cwd: repo2 }),
  ]);
  assert.equal(start1.json.ok, true, start1.stdout + start1.stderr);
  assert.equal(start2.json.ok, true, start2.stdout + start2.stderr);
  const wait1 = await caseApi.waitTask(start1.json.runId);
  const wait2 = await caseApi.waitTask(start2.json.runId);
  assert.equal(wait1.json.status, 'done', wait1.stdout + wait1.stderr);
  assert.equal(wait2.json.status, 'done', wait2.stdout + wait2.stderr);
  assert.equal(webRecords(await caseApi.records()).length, 1, '两个任务只能启动一个 Web');
});

test('transport 为 bridge 而桥接不可用：任务 failed，原因里有 executor_unavailable', async (t) => {
  const caseApi = await createDshCase('bridge-unavailable', { config: { dsh: { home: null, profile: 'web', transport: 'bridge', autoStartWeb: false } } });
  t.after(() => caseApi.cleanup());
  const started = await caseApi.startTask();
  const wait = await caseApi.waitTask(started.runId);
  assert.equal(wait.json.status, 'failed', wait.stdout + wait.stderr);
  assert.equal(wait.json.statusReason, 'executor_unavailable');
  assert.ok(wait.summary.warnings.some((message) => message.includes('executor_unavailable')));
});
