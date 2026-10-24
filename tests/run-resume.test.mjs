// 本文件：S3 的续接测试（AC10）：correction 和 answer 各自的上限、resend 不占上限、进行中的任务不能续接、prompt 文件和轮次计数、stoppedBy 为 human 时的状态。

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
  waitFor,
} from './helpers/run-harness.mjs';

async function startTask(ctx, script, extraArgs = []) {
  const executor = await startFakeExecutor(ctx, script);
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake', ...extraArgs], { executor });
  assert.equal(start.code, 0, start.stdout + start.stderr);
  return { executor, start, runId: start.json.runId, runDir: start.json.runDir };
}

async function writeMessage(ctx, name, text) {
  const file = path.join(ctx.root, name + '.md');
  await fsp.writeFile(file, text);
  return file;
}

test('correction 轮数到上限时 run resume 以 round_limit 拒绝', async (t) => {
  const ctx = await createContext('resume-correction');
  t.after(() => ctx.cleanup());
  const { executor, start, runId, runDir } = await startTask(ctx, {
    turns: [
      turnWithReport(makeReport({ status: 'partial' })),
      turnWithReport(makeReport({ status: 'partial' })),
      turnWithReport(makeReport({ status: 'done' })),
    ],
  }, ['--set', 'maxCorrectionRounds=1']);
  t.after(() => executor.stop());

  const first = await runCli(ctx, ['run', 'wait', runId, '--timeout', '20'], { executor });
  assert.equal(first.json.status, 'partial');

  const message1 = await writeMessage(ctx, 'correction-1', '第一处没做完\n');
  const resumed = await runCli(ctx, ['run', 'resume', runId, '--kind', 'correction', '--message', message1], { executor });
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.equal(resumed.json.turn, 2);
  assert.equal(resumed.json.status, 'starting');
  assert.ok(resumed.json.workerPid > 0);

  const second = await runCli(ctx, ['run', 'wait', runId, '--timeout', '20'], { executor });
  assert.equal(second.json.status, 'partial');

  const state = await readJson(path.join(runDir, 'state.json'));
  assert.equal(state.turn, 2);
  assert.equal(state.turnKind, 'correction');
  assert.deepEqual(state.counts, { correction: 1, answer: 0, resend: 0 });
  assert.deepEqual(state.turnKinds, { 1: 'brief', 2: 'correction' });
  const prompt = await fsp.readFile(path.join(runDir, 'prompt-2.md'), 'utf8');
  assert.equal(prompt, '第一处没做完\n');

  const message2 = await writeMessage(ctx, 'correction-2', '还有一处\n');
  const limited = await runCli(ctx, ['run', 'resume', runId, '--kind', 'correction', '--message', message2], { executor });
  assert.equal(limited.code, 3, limited.stdout);
  assert.equal(limited.json.error.code, 'round_limit');
});

test('answer 轮数单独计算，到上限时以 round_limit 拒绝', async (t) => {
  const ctx = await createContext('resume-answer');
  t.after(() => ctx.cleanup());
  const { executor, runId, runDir } = await startTask(ctx, {
    turns: [
      turnWithReport(makeReport({ status: 'blocked' })),
      turnWithReport(makeReport({ status: 'done' })),
    ],
  }, ['--set', 'maxCorrectionRounds=1']);
  t.after(() => executor.stop());

  const first = await runCli(ctx, ['run', 'wait', runId, '--timeout', '20'], { executor });
  assert.equal(first.json.status, 'blocked');

  const answer = await writeMessage(ctx, 'answer-1', '用 3000 端口\n');
  const resumed = await runCli(ctx, ['run', 'resume', runId, '--kind', 'answer', '--message', answer], { executor });
  assert.equal(resumed.code, 0, resumed.stdout);
  const second = await runCli(ctx, ['run', 'wait', runId, '--timeout', '20'], { executor });
  assert.equal(second.json.status, 'done');

  const state = await readJson(path.join(runDir, 'state.json'));
  assert.deepEqual(state.counts, { correction: 0, answer: 1, resend: 0 });

  const more = await writeMessage(ctx, 'answer-2', '再答一次\n');
  const limited = await runCli(ctx, ['run', 'resume', runId, '--kind', 'answer', '--message', more], { executor });
  assert.equal(limited.code, 3);
  assert.equal(limited.json.error.code, 'round_limit');
});

test('resend 不占 correction 的上限', async (t) => {
  const ctx = await createContext('resume-resend');
  t.after(() => ctx.cleanup());
  const { executor, runId, runDir } = await startTask(ctx, {
    turns: [
      { steps: [], end: { stopReason: 'end_turn', finalText: '没有汇报' } },
      turnWithReport(makeReport({ status: 'partial' })),
      turnWithReport(makeReport({ status: 'done' })),
    ],
  }, ['--set', 'maxCorrectionRounds=1']);
  t.after(() => executor.stop());

  const first = await runCli(ctx, ['run', 'wait', runId, '--timeout', '20'], { executor });
  assert.equal(first.json.status, 'partial');
  let state = await readJson(path.join(runDir, 'state.json'));
  assert.deepEqual(state.counts, { correction: 0, answer: 0, resend: 1 });
  assert.equal(state.turn, 2);

  // 上限是 1，但 resend 不算，所以这次 correction 应当被接受。
  const message = await writeMessage(ctx, 'correction', '把导出补上\n');
  const resumed = await runCli(ctx, ['run', 'resume', runId, '--kind', 'correction', '--message', message], { executor });
  assert.equal(resumed.code, 0, resumed.stdout);
  assert.equal(resumed.json.turn, 3);
  const second = await runCli(ctx, ['run', 'wait', runId, '--timeout', '20'], { executor });
  assert.equal(second.json.status, 'done');
  state = await readJson(path.join(runDir, 'state.json'));
  assert.deepEqual(state.counts, { correction: 1, answer: 0, resend: 1 });
  assert.deepEqual(state.turnKinds, { 1: 'brief', 2: 'resend', 3: 'correction' });
});

test('进行中的任务 run resume 以 not_resumable 拒绝', async (t) => {
  const ctx = await createContext('resume-running');
  t.after(() => ctx.cleanup());
  const { executor, runId, runDir } = await startTask(ctx, {
    turns: [turnWithReport(makeReport(), { steps: [{ kind: 'sleep', ms: 8000 }] })],
  });
  t.after(() => executor.stop());
  await waitFor(async () => {
    const state = await readJson(path.join(runDir, 'state.json')).catch(() => null);
    return state && state.status === 'running';
  }, { label: '任务进入 running' });

  const message = await writeMessage(ctx, 'correction', '改一下\n');
  const resumed = await runCli(ctx, ['run', 'resume', runId, '--kind', 'correction', '--message', message], { executor });
  assert.equal(resumed.code, 3, resumed.stdout);
  assert.equal(resumed.json.error.code, 'not_resumable');
  await runCli(ctx, ['run', 'cancel', runId], { executor });
});

test('stoppedBy 为 human 时记为 stopped_by_human，不自动重发汇报', async (t) => {
  const ctx = await createContext('resume-human');
  t.after(() => ctx.cleanup());
  const { executor, runId, runDir } = await startTask(ctx, {
    turns: [
      { steps: [{ kind: 'event', event: { type: 'text', text: '被打断了' } }], end: { stopReason: 'end_turn', endedBy: null, stoppedBy: 'human', finalText: '没有汇报块' } },
      turnWithReport(makeReport({ status: 'done' })),
    ],
  });
  t.after(() => executor.stop());

  const first = await runCli(ctx, ['run', 'wait', runId, '--timeout', '20'], { executor });
  assert.equal(first.json.status, 'stopped_by_human');
  const state = await readJson(path.join(runDir, 'state.json'));
  assert.equal(state.turn, 1);
  assert.deepEqual(state.counts, { correction: 0, answer: 0, resend: 0 });
  await assert.rejects(fsp.access(path.join(runDir, 'prompt-2.md')), '不应自动重发');
  const summary = await readJson(path.join(runDir, 'summary.json'));
  assert.equal(summary.status, 'stopped_by_human');

  // 停下之后仍然可以续接。
  const message = await writeMessage(ctx, 'correction', '继续\n');
  const resumed = await runCli(ctx, ['run', 'resume', runId, '--kind', 'correction', '--message', message], { executor });
  assert.equal(resumed.code, 0, resumed.stdout);
  const second = await runCli(ctx, ['run', 'wait', runId, '--timeout', '20'], { executor });
  assert.equal(second.json.status, 'done');
});
