// 本文件：S3 的收尾顺序测试（protocol.md 5.3）：读到终态时 summary.json 一定已经存在、run wait 返回时工作进程已退出且锁已释放、收尾开始后到达的事件只记进 worker.log。

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
  readEvents,
  readJson,
  runCli,
  startFakeExecutor,
  turnWithReport,
  waitFor,
  waitForSessionId,
  waitPidGone,
} from './helpers/run-harness.mjs';

const SETTLED = ['done', 'partial', 'blocked', 'report_invalid', 'stalled', 'stopped_by_human', 'failed', 'cancelled'];

async function startTask(ctx, script, env, options = {}) {
  const executor = await startFakeExecutor(ctx, script, options);
  const briefPath = path.join(ctx.root, 'brief-' + (options.name ?? 'exec') + '.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, env });
  assert.equal(start.code, 0, start.stdout + start.stderr);
  return { executor, start, runDir: start.json.runDir };
}

/** 每 10 毫秒直接读一次 state.json：只要读到终态，summary.json 就必须已经存在。 */
async function pollUntilSettled(runDir, timeout = 20000) {
  const statePath = path.join(runDir, 'state.json');
  const summaryPath = path.join(runDir, 'summary.json');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await readJson(statePath).catch(() => null);
    if (state && SETTLED.includes(state.status)) {
      const summaryExists = await pathExists(summaryPath);
      return { status: state.status, summaryExists };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等待超时：20 秒内没读到终态');
}

test('读到终态时 summary.json 一定已经存在（不经过 run wait，每 10 ms 轮询 state.json）', async (t) => {
  const ctx = await createContext('finalize-order');
  t.after(() => ctx.cleanup());
  const report = makeReport({ status: 'partial' });
  // 工作进程写 summary.json 之前停 1.5 秒：终态先写、summary 后写时，这段时间里就能读到“有终态、没 summary”。
  const { executor, start, runDir } = await startTask(
    ctx,
    { turns: [turnWithReport(report, { steps: [{ kind: 'event', event: { type: 'text', text: '开工' } }] })] },
    { AGENT_COLLAB_TEST_SUMMARY_DELAY_MS: '1500' },
  );
  t.after(() => executor.stop());

  const seen = await pollUntilSettled(runDir);
  assert.equal(seen.status, 'partial');
  assert.equal(seen.summaryExists, true, '读到终态 ' + seen.status + ' 时 summary.json 还不存在');

  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor });
  assert.equal(wait.code, 0, wait.stdout + wait.stderr);
  await assertTaskStatus(wait, 'partial', ctx);
  assert.equal(wait.summary.status, 'partial');
});

test('run wait 返回时它启动的工作进程都已退出、仓库锁已释放', async (t) => {
  const ctx = await createContext('finalize-wait');
  t.after(() => ctx.cleanup());
  const report = makeReport({ status: 'partial' });
  const { executor, start, runDir } = await startTask(ctx, {
    turns: [turnWithReport(report, {
      steps: [
        { kind: 'event', event: { type: 'text', text: '开工' } },
        { kind: 'sleep', ms: 300 },
        { kind: 'event', event: { type: 'text', text: '做完了' } },
      ],
    })],
  }, {});
  t.after(() => executor.stop());

  await waitFor(async () => (await readEvents(runDir)).some((event) => event.type === 'text' && event.text === '开工'), {
    label: '执行端开始工作',
  });
  const before = await waitForSessionId(runDir);
  process.kill(before.worker.pid, 'SIGKILL');
  await waitPidGone(before.worker.pid);

  // 让 run wait 自己启动的那个工作进程在它的两次轮询之间收完尾，这个用例才抓得住“run wait 不等自己
  // 启动的工作进程”：run wait 启动新进程后要等满一个轮询间隔才再读 state.json，而终态里的 worker 是 null，
  // 所以它从头到尾读不到新工作进程的 pid，只有等 pendingSpawnPid 才等得到它退出。
  //   - WAIT_POLL_MS 2 秒：比“启动新工作进程 → 写自身 pid → 收尾写终态”这段长，下次轮询已经落在终态之后；
  //   - PAUSE_BEFORE_RELEASE_MS 2.5 秒：比轮询间隔长（读到终态时新工作进程还活着），又小于 run wait 对
  //     每个 pid 最多等的 3 秒（否则修复版也会在它退出之前超时返回）；
  //   - ATTACH_GRACE_MS 50 毫秒：一发现旧工作进程没了就启动新工作进程，不额外等。
  const env = {
    AGENT_COLLAB_TEST_WAIT_POLL_MS: '2000',
    AGENT_COLLAB_TEST_ATTACH_GRACE_MS: '50',
    AGENT_COLLAB_TEST_PAUSE_BEFORE_RELEASE_MS: '2500',
  };
  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env });
  assert.equal(wait.code, 0, wait.stdout + wait.stderr);
  await assertTaskStatus(wait, 'partial', ctx);

  // worker.log 里记过的每个工作进程 pid（被杀的、run wait 新启动的）都应已退出。
  const log = await fsp.readFile(path.join(runDir, 'worker.log'), 'utf8');
  const pids = [...new Set([...log.matchAll(/pid (\d+)/g)].map((match) => Number(match[1])))];
  assert.ok(pids.length >= 2, 'worker.log 里应记过至少两个工作进程的 pid，实际 ' + JSON.stringify(pids));
  for (const pid of pids) assert.equal(pidAlive(pid), false, 'run wait 返回后工作进程 ' + pid + ' 还活着');

  const lockFile = path.join(path.dirname(runDir), 'active.lock');
  const lock = await readJson(lockFile).catch(() => null);
  assert.ok(!lock || lock.runId !== start.json.runId, 'run wait 返回后仓库锁还没释放：' + JSON.stringify(lock));
});

test('收尾开始后到达的执行端事件只记进 worker.log，不写 events.jsonl 和 state.json', async (t) => {
  const ctx = await createContext('finalize-late');
  t.after(() => ctx.cleanup());
  const report = makeReport({ status: 'partial' });
  const triggerName = 'late-event.trigger';
  const { executor, start, runDir } = await startTask(
    ctx,
    {
      turns: [turnWithReport(report, { steps: [{ kind: 'event', event: { type: 'text', text: '开工' } }] })],
      // 一轮结束后等触发文件出现，再补发一条事件：等到收尾开始（status 事件已经写进 events.jsonl）才触发。
      afterTurnEnd: { triggerFile: triggerName, event: { type: 'text', text: 'LATE-EVENT-1' }, timeoutMs: 30000 },
    },
    { AGENT_COLLAB_TEST_SUMMARY_DELAY_MS: '3000' },
  );
  t.after(() => executor.stop());

  // 终态事件写完、summary.json 还没写的窗口里触发迟到事件。
  await waitFor(async () => (await readEvents(runDir)).some((event) => event.type === 'status' && event.to === 'partial'), {
    label: '终态 status 事件',
  });
  await fsp.writeFile(path.join(ctx.root, triggerName), 'go\n');

  // 第 4 条的断言在这里同样成立：读到终态时 summary.json 已经存在。
  const seen = await pollUntilSettled(runDir);
  assert.equal(seen.status, 'partial');
  assert.equal(seen.summaryExists, true, '读到终态时 summary.json 还不存在');

  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor });
  assert.equal(wait.code, 0, wait.stdout + wait.stderr);
  await assertTaskStatus(wait, 'partial', ctx);

  const events = await readEvents(runDir);
  assert.equal(
    events.some((event) => event.type === 'text' && event.text === 'LATE-EVENT-1'),
    false,
    '收尾开始后到达的事件不该写进 events.jsonl',
  );
  const log = await fsp.readFile(path.join(runDir, 'worker.log'), 'utf8');
  assert.match(log, /收尾已开始，收到事件（text）/, 'worker.log 里应记下这条迟到的事件');
  assert.equal(wait.summary.status, 'partial');
});
