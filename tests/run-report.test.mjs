// 本文件：S3 的汇报提取测试（AC4、AC11）：合法汇报决定状态、不合法时自动重发一次、仍不合法记 report_invalid，summary 和 state 的字段与执行端事件对得上。

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  assertExit,
  assertTaskStatus,
  createContext,
  makeReport,
  readJson,
  runCli,
  startFakeExecutor,
  turnWithReport,
} from './helpers/run-harness.mjs';

async function startTask(ctx, script, options = {}) {
  const executor = await startFakeExecutor(ctx, script, { name: options.name });
  const briefPath = path.join(ctx.root, 'brief-' + (options.name ?? 'exec') + '.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor });
  assertExit(start, 0);
  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor });
  assertExit(wait, 0);
  await executor.stop();
  const runDir = start.json.runDir;
  return {
    runId: start.json.runId,
    runDir,
    wait: wait.json,
    waitResult: wait,
    state: await readJson(path.join(runDir, 'state.json')),
    summary: await readJson(path.join(runDir, 'summary.json')),
  };
}

test('汇报合法时任务状态取汇报的 status：done、partial、blocked', async (t) => {
  const ctx = await createContext('report-status');
  t.after(() => ctx.cleanup());
  for (const [index, status] of ['done', 'partial', 'blocked'].entries()) {
    const result = await startTask(ctx, { turns: [turnWithReport(makeReport({ status }))] }, { name: 'status-' + index });
    assert.equal(result.state.status, status, '第 ' + index + ' 个：' + JSON.stringify(result.summary.reportError));
    await assertTaskStatus(result.waitResult, status, ctx);
    assert.equal(result.summary.report.status, status);
    assert.equal(result.summary.reportError, null);
    assert.equal(result.summary.turns[0].report, 'valid');
  }
});

test('汇报不合法时自动要求重发一次，重发后合法就正常结束', async (t) => {
  const ctx = await createContext('report-resend');
  t.after(() => ctx.cleanup());
  const result = await startTask(ctx, {
    turns: [
      { steps: [{ kind: 'event', event: { type: 'text', text: '我改完了' } }], end: { stopReason: 'end_turn', stopReason2: null, finalText: '我改完了，但没有汇报块' } },
      turnWithReport(makeReport({ status: 'partial' })),
    ],
  }, { name: 'resend' });

  assert.equal(result.state.status, 'partial');
  assert.equal(result.state.turn, 2);
  assert.equal(result.state.turnKind, 'resend');
  assert.deepEqual(result.state.counts, { correction: 0, answer: 0, resend: 1 });
  const prompt = await fsp.readFile(path.join(result.runDir, 'prompt-2.md'), 'utf8');
  assert.match(prompt, /重发汇报/);
  assert.match(prompt, /REPORT_NO_CODE_BLOCK/);
  const firstReport = await readJson(path.join(result.runDir, 'report-1.json'));
  assert.equal(firstReport.error.kind, 'REPORT_NO_CODE_BLOCK');
  assert.equal(result.summary.turns.length, 2);
  assert.equal(result.summary.turns[0].report, 'invalid');
  assert.equal(result.summary.turns[1].report, 'valid');
  assert.equal(result.summary.turns[1].kind, 'resend');
  // 最近一轮合法：reportError 必须是 null，不能留着第 1 轮的错误。
  assert.equal(result.summary.reportError, null);
  assert.equal(result.summary.report.status, 'partial');
});

test('重发后仍不合法时记为 report_invalid，report-<n>.json 带 error.kind', async (t) => {
  const ctx = await createContext('report-invalid');
  t.after(() => ctx.cleanup());
  const broken = '还是没有 json 代码块';
  const result = await startTask(ctx, {
    turns: [
      { steps: [], end: { stopReason: 'end_turn', finalText: broken } },
      { steps: [], end: { stopReason: 'end_turn', finalText: broken } },
    ],
  }, { name: 'invalid' });

  assert.equal(result.state.status, 'report_invalid');
  assert.match(result.state.statusReason, /json|汇报|代码块/);
  await assertTaskStatus(result.waitResult, 'report_invalid', ctx);
  assert.equal(result.summary.turns.length, 2);
  for (const file of ['report-1.json', 'report-2.json']) {
    const value = await readJson(path.join(result.runDir, file));
    assert.equal(typeof value.error.kind, 'string', file + ' 缺少 error.kind');
    assert.equal(value.v, 1);
  }
  assert.equal(result.summary.report, null);
  const lastReport = await readJson(path.join(result.runDir, 'report-2.json'));
  assert.deepEqual(result.summary.reportError, lastReport.error, 'reportError 应是最后一轮的错误');
});

test('schema 不合法的汇报也算不合法', async (t) => {
  const ctx = await createContext('report-schema');
  t.after(() => ctx.cleanup());
  const bad = makeReport();
  delete bad.summary;
  const result = await startTask(ctx, {
    turns: [
      { steps: [], end: { stopReason: 'end_turn', finalText: '结果如下\n\n' + '\u0060\u0060\u0060json\n' + JSON.stringify(bad) + '\n\u0060\u0060\u0060' } },
      turnWithReport(makeReport()),
    ],
  }, { name: 'schema' });
  assert.equal(result.state.status, 'done');
  const first = await readJson(path.join(result.runDir, 'report-1.json'));
  assert.equal(first.error.kind, 'REPORT_SCHEMA_INVALID');
});

test('state.json 和 summary.json 含契约里的全部字段，汇总和执行端事件对得上（AC11）', async (t) => {
  const ctx = await createContext('summary');
  t.after(() => ctx.cleanup());
  const report = makeReport({
    status: 'done',
    human_inputs: [{ message: '顺便加上导出', handling: '已加导出' }],
  });
  const result = await startTask(ctx, {
    turns: [
      turnWithReport(report, {
        steps: [
          { kind: 'event', event: { type: 'tool_call', callId: 'c1', name: 'write', input: { file_path: 'src/a.js' } } },
          { kind: 'write', path: 'src/a.js', content: 'export const a = 1;\nexport default a;\n' },
          { kind: 'event', event: { type: 'tool_result', callId: 'c1', ok: true, output: 'ok' } },
          { kind: 'human_message', text: '顺便加上导出' },
          { kind: 'approval', approvalId: 'ap-1', toolName: 'bash', callId: 'call-9', reason: '要跑 npm test', holdMs: 120, outcome: 'allow' },
          { kind: 'question', callId: 'q-1', questions: [{ question: '用哪个端口？' }], holdMs: 80 },
          { kind: 'event', event: { type: 'usage', input: 100, output: 20, cacheRead: 5, cacheWrite: 0 } },
          { kind: 'event', event: { type: 'usage', input: 50, output: 10, cacheRead: 0, cacheWrite: 5 } },
          { kind: 'event', event: { type: 'text', text: '改好了' } },
        ],
      }),
    ],
  }, { name: 'summary' });

  const state = result.state;
  for (const key of ['v', 'runId', 'repoRoot', 'repoId', 'status', 'statusReason', 'turn', 'turnKind', 'counts', 'designer', 'executor', 'worker', 'cursor', 'lastEventN', 'lastActivityAt', 'waiting', 'protectedPaths', 'createdAt', 'updatedAt', 'endedAt']) {
    assert.ok(Object.hasOwn(state, key), 'state.json 缺少 ' + key);
  }
  for (const key of ['name', 'transport', 'sessionId', 'model', 'agentPreset']) {
    assert.ok(Object.hasOwn(state.executor, key), 'state.executor 缺少 ' + key);
  }
  assert.deepEqual(Object.keys(state.counts).sort(), ['answer', 'correction', 'resend']);
  assert.deepEqual(Object.keys(state.waiting).sort(), ['approvals', 'questions']);
  assert.deepEqual(Object.keys(state.designer).sort(), ['model', 'name']);

  const summary = result.summary;
  for (const key of ['v', 'runId', 'status', 'statusReason', 'repoRoot', 'designer', 'executor', 'createdAt', 'endedAt', 'durationMs', 'counts', 'turns', 'report', 'reportError', 'changes', 'violations', 'humanInputs', 'approvals', 'questions', 'usage', 'warnings', 'lastActivityAt']) {
    assert.ok(Object.hasOwn(summary, key), 'summary.json 缺少 ' + key);
  }
  const turn = summary.turns[0];
  for (const key of ['n', 'kind', 'startedAt', 'endedAt', 'stopReason', 'endReason', 'stoppedBy', 'report', 'reportFile', 'patchFile', 'usage']) {
    assert.ok(Object.hasOwn(turn, key), 'summary.turns[0] 缺少 ' + key);
  }
  assert.equal(turn.n, 1);
  assert.equal(turn.kind, 'brief');
  assert.equal(turn.stopReason, 'end_turn');
  assert.deepEqual(turn.usage, { input: 150, output: 30, cacheRead: 5, cacheWrite: 5 });
  assert.deepEqual(summary.usage, { input: 150, output: 30, cacheRead: 5, cacheWrite: 5 });
  assert.deepEqual(summary.humanInputs.map((item) => item.text), ['顺便加上导出']);
  assert.equal(summary.humanInputs[0].turn, 1);
  assert.equal(summary.approvals.length, 1);
  assert.equal(summary.approvals[0].approvalId, 'ap-1');
  assert.equal(summary.approvals[0].toolName, 'bash');
  assert.equal(summary.approvals[0].reason, '要跑 npm test');
  assert.equal(summary.approvals[0].outcome, 'allow');
  assert.ok(summary.approvals[0].askedAt && summary.approvals[0].decidedAt);
  assert.equal(summary.questions.length, 1);
  assert.equal(summary.questions[0].callId, 'q-1');
  assert.ok(summary.questions[0].askedAt && summary.questions[0].resolvedAt);
  assert.deepEqual(summary.changes.files, [{ path: 'src/a.js', change: 'A', added: 2, deleted: 0 }]);
  assert.equal(summary.report.status, 'done');
  assert.equal(summary.status, 'done');
  assert.ok(summary.durationMs >= 0);

  // 事件里没有第二轮的痕迹，账目和事件一致。
  const events = (await fsp.readFile(path.join(result.runDir, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const usageEvents = events.filter((event) => event.type === 'usage');
  assert.equal(usageEvents.length, 2);
  assert.equal(events.filter((event) => event.type === 'approval').length, 2);
  assert.equal(events.filter((event) => event.type === 'question').length, 2);
});

test('适配器事件自带的 n、turn、v、at 不能覆盖运行时分配的字段（RW7）', async (t) => {
  const ctx = await createContext('reserved');
  t.after(() => ctx.cleanup());
  const result = await startTask(ctx, {
    turns: [turnWithReport(makeReport(), {
      steps: [
        { kind: 'event', event: { type: 'text', text: '自带字段', n: 999, turn: 99, v: 7, at: '2000-01-01T00:00:00.000Z' } },
        { kind: 'event', event: { type: 'usage', input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } },
      ],
    })],
  }, { name: 'reserved' });

  const events = (await fsp.readFile(path.join(result.runDir, 'events.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  events.forEach((event, index) => assert.equal(event.n, index + 1, '序号应由运行时分配且连续'));
  const textEvent = events.find((event) => event.type === 'text' && event.text === '自带字段');
  assert.ok(textEvent, '没有找到自带字段的 text 事件');
  assert.equal(textEvent.n, events.indexOf(textEvent) + 1);
  assert.equal(textEvent.turn, 1);
  assert.equal(textEvent.v, 1);
  assert.notEqual(textEvent.at, '2000-01-01T00:00:00.000Z');
  assert.ok(Number.isFinite(Date.parse(textEvent.at)));
});
