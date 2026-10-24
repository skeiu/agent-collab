// 本文件：S3 的“杀掉工作进程后重新接上”测试（AC8，T23 的运行时部分）：run wait 启动新工作进程 attach，事件序号不跳号不重复，最后一行不完整时能恢复，接不上记 failed。
// 本意是“接上进行中的一轮”的用例让假执行端停在一轮中间等 attach，并断言 attach 记录里 running 为 true，避免负载重时悄悄变成“接上时这一轮已结束”。

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  assertTaskStatus,
  createContext,
  makeReport,
  readAttachments,
  readJson,
  readRecord,
  readStartCount,
  reportText,
  runCli,
  startFakeExecutor,
  turnWithReport,
  waitFor,
  waitForSessionId,
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
        // 停在这里直到收到 attach：这样“接上”一定发生在一轮进行中，不靠时长估算（负载重时也不会退化成接上已结束的一轮）。
        { kind: 'wait_for_attach' },
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
  // 先等 sessionId 进 state.json，否则测的是“会话还没记下来”的情形，不是“接上已有会话”。
  const before = await waitForSessionId(runDir);
  assert.ok(before.worker && before.worker.pid, '工作进程 pid 没写进 state.json');
  process.kill(before.worker.pid, 'SIGKILL');
  await waitPidGone(before.worker.pid);

  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env: ATTACH_ENV });
  assert.equal(wait.code, 0, wait.stdout + wait.stderr);
  await assertTaskStatus(wait, 'done', ctx);

  // 必须真的接上“进行中的一轮”：假执行端停在一轮中间等 attach，接上之后才继续。
  const attachments = await readAttachments(executor);
  assert.ok(
    attachments.some((item) => item.running === true),
    '没有接上进行中的一轮：' + JSON.stringify(attachments),
  );

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
  const stateBefore = await waitForSessionId(runDir);
  process.kill(stateBefore.worker.pid, 'SIGKILL');
  await waitPidGone(stateBefore.worker.pid);

  // 模拟“刚写完半行就被杀掉”。
  await fsp.appendFile(eventsFile, '{"v":1,"n":999,');

  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env: ATTACH_ENV });
  assert.equal(wait.code, 0, wait.stdout + wait.stderr);
  await assertTaskStatus(wait, 'done', ctx);

  const attachments = await readAttachments(executor);
  assert.ok(
    attachments.some((item) => item.running === true),
    '没有接上进行中的一轮：' + JSON.stringify(attachments),
  );
  const raw = await fsp.readFile(eventsFile, 'utf8');
  assert.ok(raw.endsWith('\n'), '事件文件应以换行结尾');
  const events = raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  events.forEach((event, index) => assert.equal(event.n, index + 1, '截掉半行后序号应连续'));
});

// 接不上会话的用例不需要“停在 attach 上”（attach 会被拒绝），用一轮慢一点的执行端即可。
const SLOW_TURN = {
  turns: [turnWithReport(makeReport(), {
    steps: [
      { kind: 'event', event: { type: 'text', text: '先说明一下' } },
      { kind: 'sleep', ms: 4000 },
    ],
  })],
};

test('接不上执行端会话时记为 failed（worker_lost）', async (t) => {
  const ctx = await createContext('attach-fail');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, { ...SLOW_TURN, rejectAttach: true });
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, env: ATTACH_ENV });
  assert.equal(start.code, 0, start.stdout);
  const runDir = start.json.runDir;
  await waitFor(async () => (await readEvents(runDir)).length >= 2, { label: '前几个事件' });
  const before = await waitForSessionId(runDir);
  process.kill(before.worker.pid, 'SIGKILL');
  await waitPidGone(before.worker.pid);

  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env: ATTACH_ENV });
  assert.equal(wait.code, 0, wait.stdout + wait.stderr);
  await assertTaskStatus(wait, 'failed', ctx);
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
  // 先等 sessionId 写进 state.json，测的才是“接上已有会话”，不是第 1 条的情形。
  const before = await waitForSessionId(runDir);
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
  await assertTaskStatus(wait, 'partial', ctx);
  // 这个用例测的是“接上时这一轮已经结束”，和上面几个用例的路径正好相反。
  const attachments = await readAttachments(executor);
  assert.equal(attachments.length, 1, JSON.stringify(attachments));
  assert.equal(attachments[0].running, false, JSON.stringify(attachments));
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
  assert.equal(await readStartCount(executor), 1, '同一个任务只能开一次执行端会话');

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

/**
 * 汇报只放在 turn_end 的 finalText 里（没有对应的 text 事件）时，工作进程不在期间这一轮跑完、
 * 新工作进程再接上，也要按合法汇报收尾：假执行端让两条路径的最终文字一致（protocol.md 第 3 节）。
 */
const FINISH_AFTER_KILL_TEXT_ONLY = {
  turns: [{
    steps: [
      { kind: 'event', event: { type: 'text', text: '开工' } },
      { kind: 'sleep', ms: 1200 },
    ],
    end: { stopReason: 'end_turn', endReason: null, stoppedBy: null, finalText: reportText(finishedReport) },
  }],
};

test('这一轮已跑完时接上：汇报只在 turn_end 的 finalText 里也能收尾成 partial（CR1）', async (t) => {
  const ctx = await createContext('attach-text-only');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, FINISH_AFTER_KILL_TEXT_ONLY);
  t.after(() => executor.stop());
  const { start, runDir } = await startAndKillWorker(ctx, executor, t);

  // 等这一轮在工作进程不在的情况下跑完，再让 run wait 启动新工作进程接上（running: false 的路径）。
  await waitFor(async () => (await readRecord(executor.recordPath)).some((entry) => entry.event.type === 'turn_end'), {
    label: '执行端跑完这一轮',
  });

  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env: ATTACH_ENV });
  assert.equal(wait.code, 0, wait.stdout + wait.stderr);
  await assertTaskStatus(wait, 'partial', ctx);
  const report = await readJson(path.join(runDir, 'report-1.json'));
  assert.equal(report.status, 'partial');
  const attachments = await readAttachments(executor);
  assert.equal(attachments[0].running, false, JSON.stringify(attachments));
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
  await assertTaskStatus(wait, 'failed', ctx);
  assert.equal(wait.json.statusReason, 'worker_lost');
  const summary = await readJson(path.join(runDir, 'summary.json'));
  assert.equal(summary.status, 'failed');
  assert.equal(summary.statusReason, 'worker_lost');
});

/**
 * FX1：工作进程在 “start 已返回、sessionId 还没写进 state.json” 的窗口里被杀掉。
 * AGENT_COLLAB_TEST_PAUSE_AFTER_START_MS 让工作进程在 start 返回后停一下，露出这个窗口。
 */
const PAUSE_ENV = { ...ATTACH_ENV, AGENT_COLLAB_TEST_PAUSE_AFTER_START_MS: '2000' };

const PAUSED_TURN = {
  turns: [turnWithReport(makeReport(), {
    steps: [
      { kind: 'sleep', ms: 1500 },
      // 停在 attach 上：保证接上的时候这一轮还在进行中（负载重时也不会变成“接上已结束的一轮”）。
      { kind: 'wait_for_attach' },
      { kind: 'event', event: { type: 'text', text: '做完了' } },
    ],
  })],
};

test('sessionId 写进 state.json 之前杀掉工作进程：从 events.jsonl 的 session 事件恢复并接上，只开一次会话（FX1）', async (t) => {
  const ctx = await createContext('attach-session-event');
  t.after(() => ctx.cleanup());
  // 适配器在 start 期间自己发一条 session 事件：工作进程暂停时这条事件已经写进 events.jsonl，state.json 里还没有 sessionId。
  const executor = await startFakeExecutor(ctx, { ...PAUSED_TURN, emitSessionOnStart: true });
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, env: PAUSE_ENV });
  assert.equal(start.code, 0, start.stdout);
  const runDir = start.json.runDir;

  await waitFor(async () => (await readEvents(runDir)).some((event) => event.type === 'session'), { label: 'session 事件' });
  const paused = await readJson(path.join(runDir, 'state.json'));
  assert.equal(paused.executor.sessionId, null, '这时 sessionId 还不该在 state.json 里');
  assert.ok(paused.worker && paused.worker.pid, '工作进程 pid 没写进 state.json');
  process.kill(paused.worker.pid, 'SIGKILL');
  await waitPidGone(paused.worker.pid);

  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env: ATTACH_ENV });
  assert.equal(wait.code, 0, wait.stdout + wait.stderr);
  await assertTaskStatus(wait, 'done', ctx);
  assert.equal(await readStartCount(executor), 1, '同一个任务只能开一次执行端会话');
  const attachments = await readAttachments(executor);
  assert.ok(
    attachments.some((item) => item.running === true),
    '没有接上进行中的一轮：' + JSON.stringify(attachments),
  );

  const state = await readJson(path.join(runDir, 'state.json'));
  assert.equal(state.status, 'done');
  assert.equal(state.executor.sessionId, 'fake-session-1', '恢复出来的 sessionId 应写回 state.json');
});

test('sessionId 写进 state.json 之前杀掉工作进程且没有 session 事件：记为 failed（worker_lost），不再开会话（FX1）', async (t) => {
  const ctx = await createContext('attach-no-session');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, PAUSED_TURN);
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, env: PAUSE_ENV });
  assert.equal(start.code, 0, start.stdout);
  const runDir = start.json.runDir;

  await waitFor(async () => (await readStartCount(executor)) >= 1, { label: '假执行端收到 start' });
  const paused = await readJson(path.join(runDir, 'state.json'));
  assert.equal(paused.executor.sessionId, null, '这时 sessionId 还不该在 state.json 里');
  assert.ok(paused.worker && paused.worker.pid, '工作进程 pid 没写进 state.json');
  process.kill(paused.worker.pid, 'SIGKILL');
  await waitPidGone(paused.worker.pid);

  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env: ATTACH_ENV });
  assert.equal(wait.code, 0, wait.stdout + wait.stderr);
  await assertTaskStatus(wait, 'failed', ctx);
  assert.equal(wait.json.statusReason, 'worker_lost');
  assert.equal(await readStartCount(executor), 1, '找不到 sessionId 时不能再开第二个会话');
  assert.equal(wait.summary.status, 'failed');
  assert.equal(wait.summary.statusReason, 'worker_lost');
});

test('新工作进程在一次轮询间隔内就收尾：run wait 返回时 summary.json 已经可读（FX2）', async (t) => {
  const ctx = await createContext('wait-summary');
  t.after(() => ctx.cleanup());
  const report = makeReport({ status: 'partial' });
  const executor = await startFakeExecutor(ctx, {
    turns: [turnWithReport(report, {
      steps: [
        { kind: 'event', event: { type: 'text', text: '开工' } },
        { kind: 'sleep', ms: 300 },
        { kind: 'event', event: { type: 'text', text: reportText(report) } },
      ],
    })],
  });
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, env: ATTACH_ENV });
  assert.equal(start.code, 0, start.stdout);
  const runDir = start.json.runDir;
  await waitFor(async () => (await readEvents(runDir)).some((event) => event.type === 'text' && event.text === '开工'), {
    label: '执行端开始工作',
  });
  const before = await waitForSessionId(runDir);
  process.kill(before.worker.pid, 'SIGKILL');
  await waitPidGone(before.worker.pid);

  // 轮询间隔比新工作进程 attach 到收尾的时间还长：run wait 看不到中间过程，只能靠返回时的状态和文件。
  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], {
    executor,
    // 轮询间隔调到 1.5 秒：新工作进程从启动到写终态都在一次轮询间隔里完成，run wait 看不到它的 pid。
    // 新工作进程写 summary.json 前再停 2 秒（比轮询间隔长）：如果终态先写、summary 后写，
    // 下一次轮询就会落在“有终态、没 summary”的窗口里。
    env: { ...ATTACH_ENV, AGENT_COLLAB_TEST_WAIT_POLL_MS: '1500', AGENT_COLLAB_TEST_SUMMARY_DELAY_MS: '2000' },
  });
  assert.equal(wait.code, 0, wait.stdout + wait.stderr);
  await assertTaskStatus(wait, 'partial', ctx);
  // runCli 里统一断言 summary.json 可读；这里再核对内容。
  assert.equal(wait.summary.status, 'partial');
  assert.equal(wait.summary.report.status, 'partial');
});
