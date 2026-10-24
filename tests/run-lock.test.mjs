// 本文件：S3 的仓库锁测试（AC5、D23）：同一仓库只能有一个任务、并发只成功一个、持锁进程不在时锁失效、run resume 重新拿锁。

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  createContext,
  makeReport,
  readJson,
  runCli,
  startFakeExecutor,
  turnWithReport,
} from './helpers/run-harness.mjs';

async function brief(ctx, name) {
  const file = path.join(ctx.root, name + '.md');
  await fsp.writeFile(file, '# 任务 ' + name + '\n');
  return file;
}

test('同一仓库第二次 run start 以 lock_held 拒绝，error.data 带现有任务', async (t) => {
  const ctx = await createContext('lock');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, {
    turns: [turnWithReport(makeReport(), { steps: [{ kind: 'sleep', ms: 2500 }] })],
  });
  t.after(() => executor.stop());

  const first = await runCli(ctx, ['run', 'start', '--brief', await brief(ctx, 'a'), '--executor', 'fake'], { executor });
  assert.equal(first.code, 0, first.stdout);

  const second = await runCli(ctx, ['run', 'start', '--brief', await brief(ctx, 'b'), '--executor', 'fake'], { executor });
  assert.equal(second.code, 3, second.stdout);
  assert.equal(second.json.ok, false);
  assert.equal(second.json.error.code, 'lock_held');
  assert.equal(second.json.error.data.runId, first.json.runId);
  assert.ok(
    ['starting', 'running', 'waiting_approval', 'waiting_question'].includes(second.json.error.data.status),
    'status 应为进行中，实际 ' + second.json.error.data.status,
  );

  const wait = await runCli(ctx, ['run', 'wait', first.json.runId, '--timeout', '20'], { executor });
  assert.equal(wait.json.status, 'done');
  // 任务停下后锁已释放，可以再派一个。
  const third = await runCli(ctx, ['run', 'start', '--brief', await brief(ctx, 'c'), '--executor', 'fake'], { executor });
  assert.equal(third.code, 0, third.stdout);
  await runCli(ctx, ['run', 'cancel', third.json.runId], { executor });
});

test('两个 run start 同时运行时只有一个成功', async (t) => {
  const ctx = await createContext('race');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, {
    turns: [turnWithReport(makeReport(), { steps: [{ kind: 'sleep', ms: 2000 }] })],
  });
  t.after(() => executor.stop());
  const briefA = await brief(ctx, 'race-a');
  const briefB = await brief(ctx, 'race-b');

  const [left, right] = await Promise.all([
    runCli(ctx, ['run', 'start', '--brief', briefA, '--executor', 'fake'], { executor }),
    runCli(ctx, ['run', 'start', '--brief', briefB, '--executor', 'fake'], { executor }),
  ]);
  const codes = [left.code, right.code].sort();
  assert.deepEqual(codes, [0, 3], JSON.stringify([left.stdout, right.stdout]));
  const winner = left.code === 0 ? left : right;
  const loser = left.code === 0 ? right : left;
  assert.equal(loser.json.error.code, 'lock_held');
  await runCli(ctx, ['run', 'cancel', winner.json.runId], { executor });
});

test('锁里的 pid 不存活时能拿到锁', async (t) => {
  const ctx = await createContext('stale');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, { turns: [turnWithReport(makeReport())] });
  t.after(() => executor.stop());

  // 先跑一个任务拿到仓库标识和锁文件的位置，再伪造一个死进程的锁。
  const first = await runCli(ctx, ['run', 'start', '--brief', await brief(ctx, 'stale-1'), '--executor', 'fake'], { executor });
  assert.equal(first.code, 0, first.stdout);
  await runCli(ctx, ['run', 'wait', first.json.runId, '--timeout', '20'], { executor });
  const lockFile = path.join(path.dirname(first.json.runDir), 'active.lock');
  await fsp.writeFile(lockFile, JSON.stringify({ v: 1, runId: 'T999', pid: 2147483647, phase: 'worker', createdAt: new Date().toISOString() }) + '\n');

  const second = await runCli(ctx, ['run', 'start', '--brief', await brief(ctx, 'stale-2'), '--executor', 'fake'], { executor });
  assert.equal(second.code, 0, second.stdout);
  const lock = JSON.parse(await fsp.readFile(lockFile, 'utf8'));
  assert.equal(lock.runId, second.json.runId);
  assert.ok(lock.pid > 0);
  await runCli(ctx, ['run', 'wait', second.json.runId, '--timeout', '20'], { executor });
  await assert.rejects(fsp.access(lockFile), '任务停下后锁应已释放');
});

test('本仓库别的任务在跑时 run resume 以 lock_held 拒绝', async (t) => {
  const ctx = await createContext('resume-held');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, {
    turns: [
      turnWithReport(makeReport({ status: 'partial' })),
      turnWithReport(makeReport(), { steps: [{ kind: 'sleep', ms: 2500 }] }),
    ],
  });
  t.after(() => executor.stop());

  const first = await runCli(ctx, ['run', 'start', '--brief', await brief(ctx, 'held-1'), '--executor', 'fake'], { executor });
  assert.equal(first.code, 0, first.stdout);
  const firstWait = await runCli(ctx, ['run', 'wait', first.json.runId, '--timeout', '20'], { executor });
  assert.equal(firstWait.json.status, 'partial');

  // 另一个任务占着本仓库的锁。
  const second = await runCli(ctx, ['run', 'start', '--brief', await brief(ctx, 'held-2'), '--executor', 'fake'], { executor });
  assert.equal(second.code, 0, second.stdout);

  const messageFile = path.join(ctx.root, 'correction.md');
  await fsp.writeFile(messageFile, '接着改\n');
  const resumed = await runCli(ctx, ['run', 'resume', first.json.runId, '--kind', 'correction', '--message', messageFile], { executor });
  assert.equal(resumed.code, 3, resumed.stdout);
  assert.equal(resumed.json.error.code, 'lock_held');
  assert.equal(resumed.json.error.data.runId, second.json.runId);

  await runCli(ctx, ['run', 'cancel', second.json.runId], { executor });
});

test('run resume 重新拿锁，期间其他 run start 被锁住', async (t) => {
  const ctx = await createContext('resume-lock');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, {
    turns: [
      turnWithReport(makeReport({ status: 'partial' })),
      turnWithReport(makeReport({ status: 'done' }), { steps: [{ kind: 'sleep', ms: 1500 }] }),
    ],
  });
  t.after(() => executor.stop());

  const first = await runCli(ctx, ['run', 'start', '--brief', await brief(ctx, 'resume-1'), '--executor', 'fake'], { executor });
  assert.equal(first.code, 0, first.stdout);
  const firstWait = await runCli(ctx, ['run', 'wait', first.json.runId, '--timeout', '20'], { executor });
  assert.equal(firstWait.json.status, 'partial');

  const messageFile = path.join(ctx.root, 'correction.md');
  await fsp.writeFile(messageFile, '第 2 步没做完，请补上\n');
  const resumed = await runCli(ctx, ['run', 'resume', first.json.runId, '--kind', 'correction', '--message', messageFile], { executor });
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.equal(resumed.json.turn, 2);

  const lockFile = path.join(path.dirname(first.json.runDir), 'active.lock');
  const lock = JSON.parse(await fsp.readFile(lockFile, 'utf8'));
  assert.equal(lock.runId, first.json.runId);
  assert.equal(lock.phase, 'worker');

  const blocked = await runCli(ctx, ['run', 'start', '--brief', await brief(ctx, 'resume-2'), '--executor', 'fake'], { executor });
  assert.equal(blocked.code, 3);
  assert.equal(blocked.json.error.code, 'lock_held');

  const secondWait = await runCli(ctx, ['run', 'wait', first.json.runId, '--timeout', '20'], { executor });
  assert.equal(secondWait.json.status, 'done');
});
