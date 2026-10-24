// 本文件：S3 的卡死检测测试（AC7）：超过空闲阈值记为 stalled；等待审批期间不计时，审批结束后重新计时。

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  assertExit,
  assertTaskStatus,
  createContext,
  makeReport,
  readAttachments,
  readJson,
  runCli,
  startFakeExecutor,
  turnWithReport,
  waitForSessionId,
  waitPidGone,
} from './helpers/run-harness.mjs';

// 阈值和等待时长留出足够余量（阈值 800 ms，审批 2400 ms、续接前等 1200 ms），慢机器上也不至于把
// “还没收到第一个事件”误判成卡死，或把“等待期间”算进空闲时间。
const STALL_ENV = {
  AGENT_COLLAB_TEST_IDLE_TIMEOUT_MS: '800',
  AGENT_COLLAB_TEST_STALL_POLL_MS: '50',
  AGENT_COLLAB_TEST_CANCEL_POLL_MS: '50',
};
const ATTACH_ENV = { ...STALL_ENV, AGENT_COLLAB_TEST_ATTACH_GRACE_MS: '50', AGENT_COLLAB_TEST_WAIT_POLL_MS: '50' };

async function startTask(ctx, script, env) {
  const executor = await startFakeExecutor(ctx, script);
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, env });
  assertExit(start, 0);
  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env });
  await executor.stop();
  return {
    wait: wait.json,
    waitResult: wait,
    state: await readJson(path.join(start.json.runDir, 'state.json')),
    summary: await readJson(path.join(start.json.runDir, 'summary.json')),
  };
}

test('没有任何事件超过阈值时记为 stalled', async (t) => {
  const ctx = await createContext('stall');
  t.after(() => ctx.cleanup());
  const result = await startTask(ctx, {
    turns: [turnWithReport(makeReport(), { steps: [{ kind: 'sleep', ms: 4000 }] })],
  }, STALL_ENV);
  await assertTaskStatus(result.waitResult, 'stalled', ctx);
  assert.equal(result.state.status, 'stalled');
  assert.match(result.state.statusReason, /空闲超时/);
  assert.equal(result.summary.turns[0].stopReason, 'cancelled', '卡死时应调用适配器的 cancel');
  assert.ok(result.summary.warnings.some((item) => item.includes('空闲超时')));
});

test('等待审批期间超过阈值不算卡死', async (t) => {
  const ctx = await createContext('stall-approval');
  t.after(() => ctx.cleanup());
  const result = await startTask(ctx, {
    turns: [turnWithReport(makeReport(), {
      steps: [
        { kind: 'approval', approvalId: 'ap-slow', toolName: 'bash', callId: 'call-slow', reason: '慢审批', holdMs: 2400, outcome: 'allow' },
        { kind: 'sleep', ms: 80 },
      ],
    })],
  }, STALL_ENV);
  assert.equal(result.state.status, 'done', JSON.stringify(result.summary.warnings));
  assert.equal(result.summary.approvals.length, 1);
  assert.equal(result.summary.approvals[0].outcome, 'allow');
});

test('审批结束后重新计时：之后空闲超过阈值仍然记为 stalled', async (t) => {
  const ctx = await createContext('stall-after');
  t.after(() => ctx.cleanup());
  const result = await startTask(ctx, {
    turns: [turnWithReport(makeReport(), {
      steps: [
        { kind: 'approval', approvalId: 'ap-2', toolName: 'bash', callId: 'call-2', reason: '等待审批', holdMs: 1000, outcome: 'allow' },
        { kind: 'sleep', ms: 2000 },
      ],
    })],
  }, STALL_ENV);
  assert.equal(result.state.status, 'stalled');
  assert.equal(result.summary.approvals[0].outcome, 'allow');
});

test('停下超过阈值之后再 resume：续接不记为 stalled（FX3）', async (t) => {
  const ctx = await createContext('stall-resume');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, {
    turns: [
      turnWithReport(makeReport({ status: 'blocked' }), { steps: [{ kind: 'event', event: { type: 'text', text: '需要答复' } }] }),
      turnWithReport(makeReport({ status: 'done' }), {
        steps: [
          { kind: 'sleep', ms: 300 },
          { kind: 'event', event: { type: 'text', text: '继续做完了' } },
        ],
      }),
    ],
  });
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, env: STALL_ENV });
  assertExit(start, 0);
  const first = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env: STALL_ENV });
  await assertTaskStatus(first, 'blocked', ctx);

  // 设计端审阅的时间超过卡死阈值，之后再续接：这段时间不该被算成执行端空闲。
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const messagePath = path.join(ctx.root, 'answer.md');
  await fsp.writeFile(messagePath, '按问题单改\n');
  const resumed = await runCli(ctx, ['run', 'resume', start.json.runId, '--kind', 'answer', '--message', messagePath], { executor, env: STALL_ENV });
  assertExit(resumed, 0);

  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env: STALL_ENV });
  assertExit(wait, 0);
  await assertTaskStatus(wait, 'done', ctx);
  assert.equal(wait.json.statusReason, null);
  assert.equal(wait.summary.warnings.some((item) => item.includes('空闲超时')), false, JSON.stringify(wait.summary.warnings));
});

const ATTACH_STALL_ENV = {
  AGENT_COLLAB_TEST_IDLE_TIMEOUT_MS: '2000',
  AGENT_COLLAB_TEST_STALL_POLL_MS: '50',
  AGENT_COLLAB_TEST_CANCEL_POLL_MS: '50',
  AGENT_COLLAB_TEST_ATTACH_GRACE_MS: '50',
  AGENT_COLLAB_TEST_WAIT_POLL_MS: '50',
};

test('attach 接上之后还要过一会儿才有事件：不记为 stalled（FX3）', async (t) => {
  const ctx = await createContext('stall-attach');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, {
    turns: [turnWithReport(makeReport({ status: 'done' }), {
      steps: [
        { kind: 'event', event: { type: 'text', text: '开工' } },
        // 停在这里直到接上：这样“接上”一定发生在一轮进行中，且接上之后还要过 1.2 秒才有下一个事件
        // （小于阈值 2 秒；但如果没有在接上时重置 lastActivityAt，接上那一刻就已经超过阈值了）。
        { kind: 'wait_for_attach' },
        { kind: 'sleep', ms: 1200 },
        { kind: 'event', event: { type: 'text', text: '做完了' } },
      ],
    })],
  });
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, env: ATTACH_STALL_ENV });
  assertExit(start, 0);
  const runDir = start.json.runDir;
  const before = await waitForSessionId(runDir);
  process.kill(before.worker.pid, 'SIGKILL');
  await waitPidGone(before.worker.pid);

  // 工作进程不在的时间（约 2.5 秒）超过卡死阈值，再让 run wait 启动新工作进程接上；
  // 接上之后到下一个事件还有一段时间，没重置 lastActivityAt 的话这时就会被判卡死。
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env: ATTACH_STALL_ENV });
  assertExit(wait, 0);
  await assertTaskStatus(wait, 'done', ctx);
  assert.equal(wait.summary.warnings.some((item) => item.includes('空闲超时')), false, JSON.stringify(wait.summary.warnings));
  const attachments = await readAttachments(executor);
  assert.ok(
    attachments.some((item) => item.running === true),
    '没有接上进行中的一轮：' + JSON.stringify(attachments),
  );
});
