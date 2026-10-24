// 本文件：S3 的“杀掉工作进程后重新接上”测试（AC8，T23 的运行时部分）：run wait 启动新工作进程 attach，事件序号不跳号不重复，最后一行不完整时能恢复，接不上记 failed。

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  createContext,
  makeReport,
  readJson,
  readRecord,
  reportText,
  runCli,
  startFakeExecutor,
  turnWithReport,
  waitFor,
  waitPidGone,
} from './helpers/run-harness.mjs';

const ATTACH_ENV = { AGENT_COLLAB_TEST_ATTACH_GRACE_MS: '50', AGENT_COLLAB_TEST_WAIT_POLL_MS: '50' };

const LONG_TURN = {
  turns: [
    turnWithReport(makeReport(), {
      steps: [
        { kind: 'event', event: { type: 'text', text: '第一步' } },
        { kind: 'write', path: 'work.txt', content: '执行端写的\n' },
        { kind: 'sleep', ms: 400 },
        { kind: 'event', event: { type: 'tool_call', callId: 'c1', name: 'write', input: { file_path: 'work.txt' } } },
        { kind: 'sleep', ms: 400 },
        { kind: 'event', event: { type: 'tool_result', callId: 'c1', ok: true, output: 'ok' } },
        { kind: 'sleep', ms: 400 },
        { kind: 'event', event: { type: 'text', text: '最后一步' } },
      ],
    }),
  ],
};

async function readEvents(runDir) {
  let raw = '';
  try {
    raw = await fsp.readFile(path.join(runDir, 'events.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function stripCommon(event) {
  const { v, n, at, ...rest } = event;
  return rest;
}

test('杀掉工作进程后 run wait 接上，events.jsonl 不跳号不重复且和执行端记录一一对应', async (t) => {
  const ctx = await createContext('attach');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, LONG_TURN);
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, env: ATTACH_ENV });
  assert.equal(start.code, 0, start.stdout);

  const runDir = start.json.runDir;
  const statePath = path.join(runDir, 'state.json');
  await waitFor(async () => (await readEvents(runDir)).length >= 3, { label: '前几个事件' });
  const before = await readJson(statePath);
  assert.ok(before.worker && before.worker.pid, '工作进程 pid 没写进 state.json');
  process.kill(before.worker.pid, 'SIGKILL');
  await waitPidGone(before.worker.pid);

  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env: ATTACH_ENV });
  assert.equal(wait.code, 0, wait.stdout + wait.stderr);
  assert.equal(wait.json.status, 'done', JSON.stringify(wait.json));

  const events = await readEvents(runDir);
  events.forEach((event, index) => assert.equal(event.n, index + 1, '序号应从 1 连续递增'));
  const record = await readRecord(executor.recordPath);
  const adapterEvents = events.filter((event) => event.cursor !== undefined);
  assert.equal(adapterEvents.length, record.length, '事件条数和执行端记录不一致');
  for (let index = 0; index < record.length; index += 1) {
    const expected = { turn: record[index].turn, ...record[index].event, cursor: record[index].cursor };
    assert.deepEqual(stripCommon(adapterEvents[index]), expected, '第 ' + (index + 1) + ' 条事件内容不一致');
  }
  // 续接之后任务照常收尾。
  const state = await readJson(statePath);
  assert.equal(state.status, 'done');
  assert.equal(state.worker, null);
});

test('events.jsonl 最后一行不完整时也能恢复', async (t) => {
  const ctx = await createContext('attach-tail');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, LONG_TURN);
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, env: ATTACH_ENV });
  assert.equal(start.code, 0, start.stdout);
  const runDir = start.json.runDir;
  const eventsFile = path.join(runDir, 'events.jsonl');
  await waitFor(async () => (await readEvents(runDir)).length >= 2, { label: '前几个事件' });
  const stateBefore = await readJson(path.join(runDir, 'state.json'));
  process.kill(stateBefore.worker.pid, 'SIGKILL');
  await waitPidGone(stateBefore.worker.pid);

  // 模拟“刚写完半行就被杀掉”。
  await fsp.appendFile(eventsFile, '{"v":1,"n":999,');

  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env: ATTACH_ENV });
  assert.equal(wait.code, 0, wait.stdout + wait.stderr);
  assert.equal(wait.json.status, 'done', JSON.stringify(wait.json));

  const raw = await fsp.readFile(eventsFile, 'utf8');
  assert.ok(raw.endsWith('\n'), '事件文件应以换行结尾');
  const events = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  events.forEach((event, index) => assert.equal(event.n, index + 1, '截掉半行后序号应连续'));
});

test('接不上执行端会话时记为 failed（worker_lost）', async (t) => {
  const ctx = await createContext('attach-fail');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, { ...LONG_TURN, rejectAttach: true });
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, env: ATTACH_ENV });
  assert.equal(start.code, 0, start.stdout);
  const runDir = start.json.runDir;
  await waitFor(async () => (await readEvents(runDir)).length >= 2, { label: '前几个事件' });
  const before = await readJson(path.join(runDir, 'state.json'));
  process.kill(before.worker.pid, 'SIGKILL');
  await waitPidGone(before.worker.pid);

  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env: ATTACH_ENV });
  assert.equal(wait.code, 0, wait.stdout + wait.stderr);
  assert.equal(wait.json.status, 'failed');
  assert.equal(wait.json.statusReason, 'worker_lost');
  const summary = await readJson(path.join(runDir, 'summary.json'));
  assert.equal(summary.status, 'failed');
});

const finishedReport = makeReport({ status: 'partial' });
const FINISH_AFTER_KILL = {
  turns: [{
    steps: [
      { kind: 'event', event: { type: 'text', text: '开工' } },
      { kind: 'write', path: 'work.txt', content: '执行端写的\n' },
      { kind: 'sleep', ms: 1200 },
      { kind: 'event', event: { type: 'text', text: reportText(finishedReport) } },
    ],
    end: { stopReason: 'end_turn', endReason: null, stoppedBy: null, finalText: reportText(finishedReport) },
  }],
};

async function startAndKillWorker(ctx, executor, t) {
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, env: ATTACH_ENV });
  assert.equal(start.code, 0, start.stdout);
  const runDir = start.json.runDir;
  await waitFor(async () => (await readEvents(runDir)).some((event) => event.type === 'text' && event.text === '开工'), {
    label: '执行端开始工作',
  });
  const before = await readJson(path.join(runDir, 'state.json'));
  process.kill(before.worker.pid, 'SIGKILL');
  await waitPidGone(before.worker.pid);
  return { start, runDir };
}

test('工作进程不在期间这一轮已跑完：attach 带回 result，按正常一轮收尾（RW8）', async (t) => {
  const ctx = await createContext('attach-result');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, FINISH_AFTER_KILL);
  t.after(() => executor.stop());
  const { start, runDir } = await startAndKillWorker(ctx, executor, t);

  // 等假执行端把这一轮跑完（工作进程不在，事件只进了执行端的记录）。
  await waitFor(async () => (await readRecord(executor.recordPath)).some((entry) => entry.event.type === 'turn_end'), {
    label: '执行端跑完这一轮',
  });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env: ATTACH_ENV });
  assert.equal(wait.code, 0, wait.stdout + wait.stderr);
  assert.equal(wait.json.status, 'partial', JSON.stringify(wait.json));
  assert.equal(wait.json.statusReason, null);

  const state = await readJson(path.join(runDir, 'state.json'));
  assert.equal(state.status, 'partial');
  assert.equal(state.worker, null);
  const patch = await fsp.readFile(path.join(runDir, 'patch-1.diff'), 'utf8');
  assert.match(patch, /work\.txt/);
  const report = await readJson(path.join(runDir, 'report-1.json'));
  assert.equal(report.status, 'partial');
  const summary = await readJson(path.join(runDir, 'summary.json'));
  assert.equal(summary.status, 'partial');
  assert.equal(summary.report.status, 'partial');
  assert.deepEqual(summary.changes.files.map((item) => item.path), ['work.txt']);

  // 序号连续、内容与执行端记录一一对应。
  const events = await readEvents(runDir);
  events.forEach((event, index) => assert.equal(event.n, index + 1, '序号应从 1 连续递增'));
  const record = await readRecord(executor.recordPath);
  const adapterEvents = events.filter((event) => event.cursor !== undefined);
  assert.equal(adapterEvents.length, record.length, '事件条数和执行端记录不一致');
  for (let index = 0; index < record.length; index += 1) {
    const expected = { turn: record[index].turn, ...record[index].event, cursor: record[index].cursor };
    assert.deepEqual(stripCommon(adapterEvents[index]), expected, '第 ' + (index + 1) + ' 条事件内容不一致');
  }
});

test('attach 说这一轮已结束但不带 result 时仍记 failed（worker_lost）', async (t) => {
  const ctx = await createContext('attach-noresult');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, { ...FINISH_AFTER_KILL, attachNoResult: true });
  t.after(() => executor.stop());
  const { start, runDir } = await startAndKillWorker(ctx, executor, t);
  await waitFor(async () => (await readRecord(executor.recordPath)).some((entry) => entry.event.type === 'turn_end'), {
    label: '执行端跑完这一轮',
  });

  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env: ATTACH_ENV });
  assert.equal(wait.code, 0, wait.stdout + wait.stderr);
  assert.equal(wait.json.status, 'failed');
  assert.equal(wait.json.statusReason, 'worker_lost');
  const summary = await readJson(path.join(runDir, 'summary.json'));
  assert.equal(summary.status, 'failed');
  assert.equal(summary.statusReason, 'worker_lost');
});
