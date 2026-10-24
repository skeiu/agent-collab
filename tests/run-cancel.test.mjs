// 本文件：S3 的取消测试（AC9）：run cancel 让运行中的任务变成 cancelled、释放锁、之后不能 resume；工作进程不响应时按 PID 结束。

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  assertTaskStatus,
  createContext,
  makeReport,
  pathExists,
  pidAlive,
  readCommands,
  readJson,
  runCli,
  startFakeExecutor,
  turnWithReport,
  waitFor,
  waitPidGone,
} from './helpers/run-harness.mjs';

async function startLongTask(ctx, script, env = {}) {
  const executor = await startFakeExecutor(ctx, script);
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, env });
  assert.equal(start.code, 0, start.stdout);
  const statePath = path.join(start.json.runDir, 'state.json');
  await waitFor(async () => {
    const state = await readJson(statePath).catch(() => null);
    return state && state.status === 'running' && state.worker;
  }, { label: '任务进入 running' });
  return { executor, start, statePath };
}

test('run cancel：状态变成 cancelled、锁已释放、之后不能 resume', async (t) => {
  const ctx = await createContext('cancel');
  t.after(() => ctx.cleanup());
  const { executor, start, statePath } = await startLongTask(ctx, {
    turns: [turnWithReport(makeReport(), { steps: [{ kind: 'sleep', ms: 8000 }] })],
  });
  t.after(() => executor.stop());
  const workerPid = (await readJson(statePath)).worker.pid;

  const cancelled = await runCli(ctx, ['run', 'cancel', start.json.runId], { executor });
  assert.equal(cancelled.code, 0, cancelled.stdout + cancelled.stderr);
  await assertTaskStatus(cancelled, 'cancelled', ctx);

  const state = await readJson(statePath);
  assert.equal(state.status, 'cancelled');
  assert.equal(state.worker, null);
  assert.ok(state.endedAt);
  await waitPidGone(workerPid);
  assert.equal(pidAlive(workerPid), false);

  const lockFile = path.join(path.dirname(start.json.runDir), 'active.lock');
  await assert.rejects(fsp.access(lockFile), '取消后锁应已释放');

  const summary = await readJson(path.join(start.json.runDir, 'summary.json'));
  assert.equal(summary.status, 'cancelled');

  const messageFile = path.join(ctx.root, 'correction.md');
  await fsp.writeFile(messageFile, '继续做\n');
  const resumed = await runCli(ctx, ['run', 'resume', start.json.runId, '--kind', 'correction', '--message', messageFile], { executor });
  assert.equal(resumed.code, 3, resumed.stdout);
  assert.equal(resumed.json.error.code, 'not_resumable');
});

test('工作进程不响应取消时，run cancel 按 PID 结束它并记为 cancelled', async (t) => {
  const ctx = await createContext('cancel-kill');
  t.after(() => ctx.cleanup());
  const env = { AGENT_COLLAB_TEST_CANCEL_TIMEOUT_MS: '700', AGENT_COLLAB_TEST_KILL_GRACE_MS: '500' };
  const { executor, start, statePath } = await startLongTask(ctx, {
    ignoreCancel: true,
    turns: [turnWithReport(makeReport(), { steps: [
      { kind: 'write', path: 'src/killed.js', content: '第一行\n第二行\n' },
      { kind: 'sleep', ms: 20000 },
    ] })],
  }, env);
  t.after(() => executor.stop());
  const workerPid = (await readJson(statePath)).worker.pid;
  await waitFor(() => pathExists(path.join(ctx.repo, 'src', 'killed.js')), { label: '执行端写出文件' });

  const cancelled = await runCli(ctx, ['run', 'cancel', start.json.runId], { executor, env });
  assert.equal(cancelled.code, 0, cancelled.stdout + cancelled.stderr);
  await assertTaskStatus(cancelled, 'cancelled', ctx);

  const state = await readJson(statePath);
  assert.equal(state.status, 'cancelled');
  assert.match(state.statusReason, /PID/);
  await waitPidGone(workerPid, 3000);
  const lockFile = path.join(path.dirname(start.json.runDir), 'active.lock');
  await assert.rejects(fsp.access(lockFile), '取消后锁应已释放');
  const summary = await readJson(path.join(start.json.runDir, 'summary.json'));
  assert.equal(summary.status, 'cancelled');
  // changes 按工作进程的算法对基线重算，不能是空值。
  assert.deepEqual(summary.changes.files, [{ path: 'src/killed.js', change: 'A', added: 2, deleted: 0 }]);
});

test('run cancel 等待期间任务自己以 done 结束：不结束进程，summary 保留原结果（RW3）', async (t) => {
  const ctx = await createContext('cancel-done-race');
  t.after(() => ctx.cleanup());
  // 不依赖“这一轮跑得比工作进程的轮询快”：工作进程查 cancel.request 的间隔调到整个用例都等不到，
  // run cancel 自己的等待间隔单独调快，这样工作进程根本不会先看到取消，一定先以 done 收尾。
  const env = {
    AGENT_COLLAB_TEST_CANCEL_TIMEOUT_MS: '15000',
    AGENT_COLLAB_TEST_CANCEL_POLL_MS: '60000',
    AGENT_COLLAB_TEST_CANCEL_WAIT_POLL_MS: '50',
    AGENT_COLLAB_TEST_STALL_POLL_MS: '5000',
  };
  const { executor, start, statePath } = await startLongTask(ctx, {
    turns: [turnWithReport(makeReport(), {
      steps: [
        { kind: 'write', path: 'src/finished.js', content: 'done\n' },
        { kind: 'sleep', ms: 900 },
      ],
    })],
  }, env);
  t.after(() => executor.stop());
  const workerPid = (await readJson(statePath)).worker.pid;
  const summaryPath = path.join(start.json.runDir, 'summary.json');
  const reportPath = path.join(start.json.runDir, 'report-1.json');
  const reportBefore = await fsp.readFile(reportPath, 'utf8').catch(() => null);

  const cancelling = runCli(ctx, ['run', 'cancel', start.json.runId], { executor, env });
  // 取消还在等待时，任务自己以 done 停下；记下取消前的 summary。
  const summaryBefore = await waitFor(async () => {
    const value = await readJson(summaryPath).catch(() => null);
    return value && value.status === 'done' ? value : null;
  }, { label: '任务自己以 done 结束', timeout: 10000 });

  const cancelled = await cancelling;
  assert.equal(cancelled.code, 0, cancelled.stdout + cancelled.stderr);
  assert.deepEqual(cancelled.json, { ok: true, runId: start.json.runId, status: 'cancelled' });

  const state = await readJson(statePath);
  assert.equal(state.status, 'cancelled');
  assert.equal(state.statusReason, '设计端取消；取消前为 done');
  assert.equal(state.worker, null);
  await waitPidGone(workerPid, 3000);

  const summary = await readJson(summaryPath);
  assert.equal(summary.status, 'cancelled');
  assert.equal(summary.statusReason, '设计端取消；取消前为 done');
  assert.deepEqual(summary.changes, summaryBefore.changes);
  assert.deepEqual(summary.violations, summaryBefore.violations);
  assert.deepEqual(summary.report, summaryBefore.report);
  assert.deepEqual(summary.turns, summaryBefore.turns);
  if (reportBefore !== null) assert.equal(await fsp.readFile(reportPath, 'utf8'), reportBefore, 'report-1.json 不应被改动');
  // FX4：工作进程确实没有先看到 cancel.request（否则测的就不是“任务自己先结束”）。
  const events = (await fsp.readFile(path.join(start.json.runDir, 'events.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(
    events.some((event) => event.type === 'warning' && String(event.message).includes('cancel.request')),
    false,
    '工作进程不应看到 cancel.request',
  );
});

async function cancelSettledAndCheck(ctx, { executor, runDir, runId, expectedStatus }) {
  const summaryPath = path.join(runDir, 'summary.json');
  const summaryBefore = await readJson(summaryPath);
  assert.equal(summaryBefore.status, expectedStatus);
  const stateBefore = await readJson(path.join(runDir, 'state.json'));
  const commandsBefore = (await readCommands(executor)).length;
  const reportBefore = await fsp.readFile(path.join(runDir, 'report-1.json'), 'utf8').catch(() => null);

  const cancelled = await runCli(ctx, ['run', 'cancel', runId], { executor });
  assert.equal(cancelled.code, 0, cancelled.stdout + cancelled.stderr);
  assert.deepEqual(cancelled.json, { ok: true, runId, status: 'cancelled' });

  const state = await readJson(path.join(runDir, 'state.json'));
  assert.equal(state.status, 'cancelled');
  assert.match(state.statusReason, new RegExp('取消前为 ' + expectedStatus));
  for (const key of Object.keys(stateBefore)) {
    if (key === 'status' || key === 'statusReason' || key === 'endedAt') continue;
    assert.deepEqual(state[key], stateBefore[key], 'state.' + key + ' 被改动');
  }
  const summary = await readJson(summaryPath);
  assert.equal(summary.status, 'cancelled');
  assert.match(summary.statusReason, new RegExp('取消前为 ' + expectedStatus));
  for (const key of Object.keys(summaryBefore)) {
    if (key === 'status' || key === 'statusReason' || key === 'endedAt') continue;
    assert.deepEqual(summary[key], summaryBefore[key], 'summary.' + key + ' 被改动');
  }
  if (reportBefore !== null) {
    assert.equal(await fsp.readFile(path.join(runDir, 'report-1.json'), 'utf8'), reportBefore, 'report-1.json 不应被改动');
  }
  // “对停下的任务取消不应联系执行端”看命令记录，不看事件条数：执行端自己的这一轮可能还在跑，
  // 负载重时事件会晚到，数条数会误判。任何类型的命令都算联系执行端（发一条 attach 也算），不只看 cancel。
  const commandsAfter = await readCommands(executor);
  const newCommands = commandsAfter.slice(commandsBefore);
  assert.equal(commandsBefore > 0, true, '假执行端没有收到过命令，用例前提不成立');
  assert.deepEqual(
    newCommands,
    [],
    '对停下的任务取消不应联系执行端，但 run cancel 之后假执行端收到了新命令：' + JSON.stringify(newCommands),
  );

  const messageFile = path.join(ctx.root, 'resume-' + runId + '.md');
  await fsp.writeFile(messageFile, '继续做\n');
  const resumed = await runCli(ctx, ['run', 'resume', runId, '--kind', 'correction', '--message', messageFile], { executor });
  assert.equal(resumed.code, 3, resumed.stdout);
  assert.equal(resumed.json.error.code, 'not_resumable');

  const list = await runCli(ctx, ['run', 'status'], { executor });
  assert.equal(list.code, 0);
  assert.equal(list.json.runs.some((item) => item.runId === runId), false, '取消后 run status 不应再列出');
}

test('对 done 的任务 run cancel：直接记为 cancelled，之后不能 resume，status 不再列出（RW9）', async (t) => {
  const ctx = await createContext('cancel-done');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, { turns: [turnWithReport(makeReport({ status: 'done' }))] });
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor });
  assert.equal(start.code, 0, start.stdout);
  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor });
  await assertTaskStatus(wait, 'done', ctx);
  await cancelSettledAndCheck(ctx, { executor, runDir: start.json.runDir, runId: start.json.runId, expectedStatus: 'done' });
});

test('对 stalled 的任务 run cancel：直接记为 cancelled（RW9）', async (t) => {
  const ctx = await createContext('cancel-stalled');
  t.after(() => ctx.cleanup());
  const env = {
    AGENT_COLLAB_TEST_IDLE_TIMEOUT_MS: '300',
    AGENT_COLLAB_TEST_STALL_POLL_MS: '60',
    AGENT_COLLAB_TEST_CANCEL_POLL_MS: '60',
  };
  const executor = await startFakeExecutor(ctx, {
    turns: [turnWithReport(makeReport(), { steps: [{ kind: 'sleep', ms: 5000 }] })],
  });
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, env });
  assert.equal(start.code, 0, start.stdout);
  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env });
  await assertTaskStatus(wait, 'stalled', ctx);
  await cancelSettledAndCheck(ctx, { executor, runDir: start.json.runDir, runId: start.json.runId, expectedStatus: 'stalled' });
});

test('对 failed 的任务 run cancel：直接记为 cancelled（RW9）', async (t) => {
  const ctx = await createContext('cancel-failed');
  t.after(() => ctx.cleanup());
  const env = { AGENT_COLLAB_TEST_ATTACH_GRACE_MS: '50', AGENT_COLLAB_TEST_WAIT_POLL_MS: '50' };
  const executor = await startFakeExecutor(ctx, {
    rejectAttach: true,
    turns: [turnWithReport(makeReport(), {
      steps: [
        { kind: 'event', event: { type: 'text', text: '开始' } },
        { kind: 'sleep', ms: 3000 },
      ],
    })],
  });
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, env });
  assert.equal(start.code, 0, start.stdout);
  const runDir = start.json.runDir;
  await waitFor(async () => {
    const value = await readJson(path.join(runDir, 'state.json')).catch(() => null);
    return value && value.status === 'running' && value.worker && value.executor && value.executor.sessionId ? value : null;
  }, { label: '任务进入 running' });
  const before = await readJson(path.join(runDir, 'state.json'));
  process.kill(before.worker.pid, 'SIGKILL');
  await waitPidGone(before.worker.pid);
  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env });
  await assertTaskStatus(wait, 'failed', ctx);
  assert.equal(wait.json.statusReason, 'worker_lost');
  await cancelSettledAndCheck(ctx, { executor, runDir, runId: start.json.runId, expectedStatus: 'failed' });
});
