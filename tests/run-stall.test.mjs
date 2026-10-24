// 本文件：S3 的卡死检测测试（AC7）：超过空闲阈值记为 stalled；等待审批期间不计时，审批结束后重新计时。

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

const STALL_ENV = {
  AGENT_COLLAB_TEST_IDLE_TIMEOUT_MS: '300',
  AGENT_COLLAB_TEST_STALL_POLL_MS: '60',
  AGENT_COLLAB_TEST_CANCEL_POLL_MS: '60',
};

async function startTask(ctx, script, env) {
  const executor = await startFakeExecutor(ctx, script);
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, env });
  assert.equal(start.code, 0, start.stdout);
  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env });
  await executor.stop();
  return {
    wait: wait.json,
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
  assert.equal(result.wait.status, 'stalled');
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
        { kind: 'approval', approvalId: 'ap-slow', toolName: 'bash', callId: 'call-slow', reason: '慢审批', holdMs: 900, outcome: 'allow' },
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
        { kind: 'approval', approvalId: 'ap-2', toolName: 'bash', callId: 'call-2', reason: '等待审批', holdMs: 700, outcome: 'allow' },
        { kind: 'sleep', ms: 1200 },
      ],
    })],
  }, STALL_ENV);
  assert.equal(result.state.status, 'stalled');
  assert.equal(result.summary.approvals[0].outcome, 'allow');
});
