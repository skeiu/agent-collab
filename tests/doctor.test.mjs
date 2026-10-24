// 本文件：doctor 的测试（DA7）：检查项、level、webRunning、退出码、--deep 和只读。

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { repoIdFor } from '../core/rundir.mjs';
import { createDshCase } from './helpers/dsh-case.mjs';

async function writeConfig(caseApi, config) {
  await fsp.writeFile(path.join(caseApi.home, 'config.json'), JSON.stringify(config, null, 2));
}

function check(result, id) {
  assert.ok(result.json && Array.isArray(result.json.checks), 'doctor 输出没有 checks：' + result.stdout);
  const found = result.json.checks.find((item) => item.id === id);
  assert.ok(found, '缺少检查项 ' + id);
  return found;
}

async function fileList(dir) {
  const out = [];
  async function walk(current, prefix) {
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      out.push(prefix + entry.name + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) await walk(file, prefix + entry.name + '/');
    }
  }
  await walk(dir, '');
  return out;
}

test('一切正常：所有检查通过、退出码 0、doctor 不写文件', async (t) => {
  const caseApi = await createDshCase('doctor-ok');
  t.after(() => caseApi.cleanup());
  await caseApi.profile({ dependencies: { 'dsh-bridge': 'file:x' }, dsh: { profile: { bundles: ['dsh-bridge'] } } });
  await caseApi.startWeb({ presets: [{ id: 'standard', name: 'Standard' }, { id: 'agent-collab', name: 'Agent Collab' }] });
  const beforeDsh = await fileList(caseApi.dshHome);
  const beforeHome = await fileList(caseApi.home);
  const result = await caseApi.runCli(['doctor', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.json.ok, true);
  assert.equal(check(result, 'dsh').ok, true);
  assert.equal(check(result, 'dsh_web').ok, true);
  assert.equal(check(result, 'bridge').ok, true);
  assert.equal(check(result, 'agent_preset').ok, true);
  assert.equal(result.json.dsh.webRunning, true);
  assert.equal(result.json.dsh.bridge.installed, true);
  assert.deepEqual(result.json.dsh.agentPresets.available.sort(), ['agent-collab', 'standard']);
  assert.deepEqual(await fileList(caseApi.dshHome), beforeDsh);
  assert.deepEqual(await fileList(caseApi.home), beforeHome);
});

test('不是 git 仓库：repo 检查 error、顶层 ok false、退出码 1', async (t) => {
  const caseApi = await createDshCase('doctor-not-git');
  t.after(() => caseApi.cleanup());
  const result = await caseApi.runCli(['doctor', '--json'], { cwd: caseApi.root });
  assert.equal(result.code, 1);
  assert.equal(result.json.ok, false);
  assert.equal(check(result, 'repo').ok, false);
  assert.equal(result.json.git.isRepo, false);
  assert.equal(result.json.error.code, 'doctor_failed');
});

test('工作区有改动：worktree_clean 为 warn 且 ok false，顶层仍 ok', async (t) => {
  const caseApi = await createDshCase('doctor-dirty');
  t.after(() => caseApi.cleanup());
  await fsp.writeFile(path.join(caseApi.repo, 'README.md'), '# changed\n');
  const result = await caseApi.runCli(['doctor', '--json']);
  assert.equal(result.code, 0);
  assert.equal(result.json.ok, true);
  assert.equal(check(result, 'worktree_clean').level, 'warn');
  assert.equal(check(result, 'worktree_clean').ok, false);
  assert.ok(result.json.git.dirty.includes('README.md'));
});

test('找不到 dsh：dsh 检查 error、顶层 ok false、退出码 1', async (t) => {
  const caseApi = await createDshCase('doctor-no-dsh');
  t.after(() => caseApi.cleanup());
  await writeConfig(caseApi, { dsh: { home: null, profile: 'web', transport: 'auto' } });
  const result = await caseApi.runCli(['doctor', '--json'], { env: { PATH: '/usr/bin:/bin' } });
  assert.equal(result.code, 1);
  assert.equal(result.json.ok, false);
  assert.equal(check(result, 'dsh').ok, false);
  assert.equal(result.json.dsh.version, null);
});

test('桥接不在线：装了桥接时 webRunning 为 false；没装时为 null', async (t) => {
  const installed = await createDshCase('doctor-bridge-off');
  t.after(() => installed.cleanup());
  await installed.profile({ dependencies: { 'dsh-bridge': 'file:x' } });
  const installedResult = await installed.runCli(['doctor', '--json']);
  assert.equal(installedResult.code, 0);
  assert.equal(check(installedResult, 'bridge').ok, false);
  assert.equal(installedResult.json.dsh.webRunning, false);
  assert.equal(installedResult.json.dsh.bridge.installed, true);

  const missing = await createDshCase('doctor-bridge-missing');
  t.after(() => missing.cleanup());
  const missingResult = await missing.runCli(['doctor', '--json']);
  assert.equal(check(missingResult, 'bridge').ok, false);
  assert.equal(missingResult.json.dsh.webRunning, null);
  assert.equal(missingResult.json.dsh.bridge.installed, false);

  const plain = await missing.runCli(['doctor']);
  assert.equal(plain.code, 0, plain.stdout + plain.stderr);
  const lines = plain.stdout.trim().split('\n').filter(Boolean);
  assert.ok(lines.some((line) => line.startsWith('[INFO] dsh_web')), 'dsh_web 应为 INFO：' + plain.stdout);
  assert.ok(lines.some((line) => line.startsWith('[WARN] bridge')), 'bridge 应为 WARN：' + plain.stdout);
  assert.ok(lines.some((line) => line.startsWith('[OK] node')), '通过的项应为 OK：' + plain.stdout);
});

test('发现文件带 problem：bridge 不在线、webRunning 为 false', async (t) => {
  const caseApi = await createDshCase('doctor-problem');
  t.after(() => caseApi.cleanup());
  await caseApi.profile({ dependencies: { 'dsh-bridge': 'file:x' } });
  const dir = path.join(caseApi.dshHome, 'agent-collab');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'bridge-web.json'), JSON.stringify({
    v: 1, host: '127.0.0.1', port: 1234, token: 't', pid: process.pid, protocol: 1, protocolMin: 1,
    bridgeVersion: '0.0.0', dshVersion: '0.2.1', profile: 'web', startedAt: new Date().toISOString(), problem: '版本不支持',
  }));
  const result = await caseApi.runCli(['doctor', '--json']);
  assert.equal(check(result, 'bridge').ok, false);
  assert.match(check(result, 'bridge').message, /版本不支持/);
  assert.equal(result.json.dsh.webRunning, false);
  assert.equal(result.json.dsh.bridge.problem, '版本不支持');
});

test('agent-collab 预设不可用：agent_preset 为 warn 且 ok false', async (t) => {
  const caseApi = await createDshCase('doctor-preset');
  t.after(() => caseApi.cleanup());
  await caseApi.profile({ dependencies: { 'dsh-bridge': 'file:x' } });
  await caseApi.startWeb({ presets: [{ id: 'standard', name: 'Standard' }] });
  const result = await caseApi.runCli(['doctor', '--json']);
  assert.equal(result.code, 0);
  assert.equal(check(result, 'agent_preset').level, 'warn');
  assert.equal(check(result, 'agent_preset').ok, false);
  assert.match(check(result, 'agent_preset').message, /不可用/);
});

test('本仓库有进行中的任务：active_run 为 warn 且 ok false', async (t) => {
  const caseApi = await createDshCase('doctor-active');
  t.after(() => caseApi.cleanup());
  const repoId = repoIdFor(caseApi.repo);
  const runDir = path.join(caseApi.home, 'runs', repoId, 'T001');
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.writeFile(path.join(caseApi.home, 'runs', repoId, 'active.lock'), JSON.stringify({
    v: 1, runId: 'T001', pid: process.pid, phase: 'worker', createdAt: new Date().toISOString(),
  }));
  await fsp.writeFile(path.join(runDir, 'state.json'), JSON.stringify({ v: 1, runId: 'T001', status: 'running' }));
  const result = await caseApi.runCli(['doctor', '--json']);
  assert.equal(check(result, 'active_run').level, 'warn');
  assert.equal(check(result, 'active_run').ok, false);
  assert.deepEqual(result.json.activeRun, { runId: 'T001', status: 'running' });
});

test('transport 为 bridge 且桥接不在线：bridge 升为 error、顶层 ok false、退出码 1', async (t) => {
  const caseApi = await createDshCase('doctor-bridge-required', { config: { dsh: { home: null, profile: 'web', transport: 'bridge', autoStartWeb: false } } });
  t.after(() => caseApi.cleanup());
  const result = await caseApi.runCli(['doctor', '--json']);
  assert.equal(result.code, 1);
  assert.equal(result.json.ok, false);
  assert.equal(check(result, 'bridge').level, 'error');
  assert.equal(check(result, 'bridge').ok, false);
});

test('--deep 以用法错误退出 2；不带 --json 时每项一行', async (t) => {
  const caseApi = await createDshCase('doctor-deep');
  t.after(() => caseApi.cleanup());
  const deep = await caseApi.runCli(['doctor', '--deep']);
  assert.equal(deep.code, 2);
  assert.equal(deep.json.error.code, 'usage');
  const plain = await caseApi.runCli(['doctor']);
  assert.equal(plain.code, 0);
  const lines = plain.stdout.trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 8, plain.stdout);
  assert.ok(lines.every((line) => line.startsWith('[')), plain.stdout);
});

test('--designer 输出 flow，executor 跟随全局 executorByDesigner', async (t) => {
  const caseApi = await createDshCase('doctor-flow');
  t.after(() => caseApi.cleanup());
  const first = await caseApi.runCli(['doctor', '--json', '--designer=claude']);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.deepEqual(first.json.flow, {
    designer: 'claude',
    executor: 'dsh',
    confirmBeforeDispatch: 'risky',
    maxCorrectionRounds: 2,
    commitOnAccept: false,
    warnSameAgentPair: true,
  });

  await writeConfig(caseApi, { ...caseApi.config, executorByDesigner: { claude: 'other' } });
  const changed = await caseApi.runCli(['doctor', '--json', '--designer', 'claude']);
  assert.equal(changed.code, 0, changed.stdout + changed.stderr);
  assert.equal(changed.json.flow.executor, 'other');
});

test('项目配置只能收紧：全局 always、项目 never 时 flow 仍为 always', async (t) => {
  const caseApi = await createDshCase('doctor-flow-tighten');
  t.after(() => caseApi.cleanup());
  await writeConfig(caseApi, { ...caseApi.config, confirmBeforeDispatch: 'always' });
  await fsp.writeFile(path.join(caseApi.repo, '.agent-collab.json'), JSON.stringify({ confirmBeforeDispatch: 'never' }));
  const result = await caseApi.runCli(['doctor', '--json', '--designer', 'claude']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.json.flow.confirmBeforeDispatch, 'always');
  assert.equal(check(result, 'config').level, 'warn');
});

test('没有 --designer 时 flow 的 designer 和 executor 都是 null', async (t) => {
  const caseApi = await createDshCase('doctor-flow-null');
  t.after(() => caseApi.cleanup());
  const result = await caseApi.runCli(['doctor', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.json.flow.designer, null);
  assert.equal(result.json.flow.executor, null);
});

test('全局配置不是合法 JSON 时 flow 为 null、config 为 warn、顶层 ok 不变', async (t) => {
  const caseApi = await createDshCase('doctor-flow-bad-config');
  t.after(() => caseApi.cleanup());
  await fsp.writeFile(path.join(caseApi.home, 'config.json'), '{ not json');
  const result = await caseApi.runCli(['doctor', '--json'], {
    env: { PATH: caseApi.fake.binDir + path.delimiter + (process.env.PATH ?? '/usr/bin:/bin') },
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.flow, null);
  const configCheck = check(result, 'config');
  assert.equal(configCheck.level, 'warn');
  assert.equal(configCheck.ok, false);
  assert.match(configCheck.message, /配置/);
});
