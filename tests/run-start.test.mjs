// 本文件：S3 基本流程测试：run start 立即返回、工作进程独立存活、run wait / run status 的输出（AC1），防套娃和几类拒绝（AC6、AC12）。

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  assertTaskStatus,
  assertTaskStatusOneOf,
  createContext,
  makeReport,
  pidAlive,
  readJson,
  runCli,
  startFakeExecutor,
  turnWithReport,
} from './helpers/run-harness.mjs';

const RUNNING = new Set(['starting', 'running', 'waiting_approval', 'waiting_question']);

test('run start 立即返回，工作进程独立存活，run wait 在任务停下时返回', async (t) => {
  const ctx = await createContext('start');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, {
    turns: [
      turnWithReport(makeReport(), {
        steps: [
          { kind: 'write', path: 'src/a.js', content: 'export const a = 1;\n' },
          { kind: 'event', event: { type: 'tool_call', callId: 'c1', name: 'write', input: { file_path: 'src/a.js' } } },
          { kind: 'sleep', ms: 2000 },
        ],
      }),
    ],
  });
  t.after(() => executor.stop());

  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n写 src/a.js\n');

  const startedAt = Date.now();
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--title', '开始', '--executor', 'fake'], { executor });
  const elapsed = Date.now() - startedAt;
  assert.equal(start.code, 0, start.stderr);
  assert.equal(start.json.ok, true);
  await assertTaskStatus(start, 'starting', ctx);
  assert.match(start.json.runId, /^T\d{3,}$/);
  assert.ok(Number.isInteger(start.json.workerPid));
  // 假执行端第一轮要跑 2 秒，start 必须在这之前返回。
  assert.ok(elapsed < 1500, 'run start 用了 ' + elapsed + ' ms，等到了执行端结束');

  // CLI 退出后工作进程还活着，任务也还没结束。
  assert.ok(pidAlive(start.json.workerPid), '工作进程没有独立存活');
  const statusNow = await runCli(ctx, ['run', 'status', start.json.runId], { executor });
  assert.equal(statusNow.code, 0);
  await assertTaskStatusOneOf(statusNow, [...RUNNING], ctx, { value: statusNow.json.run.status, runDir: start.json.runDir });
  assert.equal(statusNow.json.workerAlive, true);

  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor });
  assert.equal(wait.code, 0, wait.stderr);
  assert.equal(wait.json.ok, true);
  await assertTaskStatus(wait, 'done', ctx);
  assert.equal(wait.json.statusReason, null);
  for (const key of ['summaryFile', 'patchFile', 'reportFile']) {
    assert.ok(wait.json[key], key + ' 为空');
    await fsp.access(wait.json[key]);
  }

  const runDir = start.json.runDir;
  const state = await readJson(path.join(runDir, 'state.json'));
  assert.equal(state.status, 'done');
  assert.equal(state.worker, null);
  assert.equal(state.lastEventN, (await fsp.readFile(path.join(runDir, 'events.jsonl'), 'utf8')).trim().split('\n').length);

  // 没有任务号时列出本仓库未“结束”的任务。
  const list = await runCli(ctx, ['run', 'status'], { executor });
  assert.equal(list.code, 0);
  assert.equal(list.json.runs.length, 1);
  assert.deepEqual(
    Object.keys(list.json.runs[0]).sort(),
    ['repoRoot', 'runId', 'status', 'turn', 'updatedAt', 'workerAlive'],
  );
  assert.equal(list.json.runs[0].runId, start.json.runId);

  const all = await runCli(ctx, ['run', 'status', '--all'], { executor });
  assert.equal(all.code, 0);
  assert.equal(all.json.runs.length, 1);
});

test('防套娃：AGENT_COLLAB_ROLE=executor 和 DSH_AGENT_COLLAB_ROLE=executor 都拒绝', async (t) => {
  const ctx = await createContext('role');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, { turns: [turnWithReport(makeReport())] });
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');

  for (const key of ['AGENT_COLLAB_ROLE', 'DSH_AGENT_COLLAB_ROLE']) {
    const result = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], {
      executor,
      env: { [key]: 'executor' },
    });
    assert.equal(result.code, 3, key + '：' + result.stdout);
    assert.equal(result.json.ok, false);
    assert.equal(result.json.error.code, 'executor_role');
  }
  // run resume 也拒绝。
  const resumed = await runCli(ctx, ['run', 'resume', 'T001', '--kind', 'correction', '--message', briefPath], {
    executor,
    env: { AGENT_COLLAB_ROLE: 'executor' },
  });
  assert.equal(resumed.code, 3);
  assert.equal(resumed.json.error.code, 'executor_role');
});

test('不是 git 仓库时 run start 以 not_git 拒绝', async (t) => {
  const ctx = await createContext('notgit');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, { turns: [turnWithReport(makeReport())] });
  t.after(() => executor.stop());
  const dir = path.join(ctx.root, 'plain');
  await fsp.mkdir(dir, { recursive: true });
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const result = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, cwd: dir });
  assert.equal(result.code, 3);
  assert.equal(result.json.error.code, 'not_git');
});

test('没有对应适配器时 run start 以 executor_unavailable 失败（退出码 1）', async (t) => {
  const ctx = await createContext('noadapter');
  t.after(() => ctx.cleanup());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const result = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'does-not-exist'], {
    env: { AGENT_COLLAB_TEST_ADAPTER: '' },
  });
  assert.equal(result.code, 1, result.stdout);
  assert.equal(result.json.error.code, 'executor_unavailable');
  assert.match(result.json.error.message, /does-not-exist/);
});

test('用法错误：没有 --executor 也没有 --designer、未知子命令、缺少任务号', async (t) => {
  const ctx = await createContext('usage');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, { turns: [turnWithReport(makeReport())] });
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');

  const missingExecutor = await runCli(ctx, ['run', 'start', '--brief', briefPath], { executor });
  assert.equal(missingExecutor.code, 2);
  assert.equal(missingExecutor.json.error.code, 'usage');

  const unknownCommand = await runCli(ctx, ['doctor'], { executor });
  assert.equal(unknownCommand.code, 2);
  assert.equal(unknownCommand.json.error.code, 'usage');
  assert.match(unknownCommand.json.error.message, /尚未实现/);

  const unknownSub = await runCli(ctx, ['run', 'nope'], { executor });
  assert.equal(unknownSub.code, 2);

  const missingRunId = await runCli(ctx, ['run', 'wait'], { executor });
  assert.equal(missingRunId.code, 2);

  const notFound = await runCli(ctx, ['run', 'wait', 'T999'], { executor });
  assert.equal(notFound.code, 4);
  assert.equal(notFound.json.error.code, 'run_not_found');
});

test('--designer 按 executorByDesigner 选执行端，并记下设计端', async (t) => {
  const ctx = await createContext('designer');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, { turns: [turnWithReport(makeReport())] });
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  await fsp.writeFile(path.join(ctx.home, 'config.json'), JSON.stringify({ executorByDesigner: { claude: 'fake' } }) + '\n');
  const result = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--designer', 'claude', '--designer-model', 'model-x', '--set', 'idleTimeoutMinutes=30'], { executor });
  assert.equal(result.code, 0, result.stdout);
  const state = await readJson(path.join(result.json.runDir, 'state.json'));
  assert.deepEqual(state.designer, { name: 'claude', model: 'model-x' });
  assert.equal(state.executor.name, 'fake');
  const wait = await runCli(ctx, ['run', 'wait', result.json.runId, '--timeout', '20'], { executor });
  await assertTaskStatus(wait, 'done', ctx);
});
