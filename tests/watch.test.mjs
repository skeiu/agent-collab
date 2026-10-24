// 本文件：S3 的 watch 测试（AC1 的 watch 部分）：行格式 \"[T001 08:00:00] 内容\"、只打印里程碑事件、任务停下后退出。

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  binPath,
  createContext,
  makeReport,
  readJson,
  run,
  runCli,
  startFakeExecutor,
  turnWithReport,
} from './helpers/run-harness.mjs';

const MILESTONES = ['status', 'tool_call', 'approval', 'question', 'human_message', 'turn_end', 'warning', 'error'];

async function watchLines(ctx, argv, env, executor) {
  const result = await run(process.execPath, [binPath, 'watch', ...argv], {
    cwd: ctx.repo,
    env: {
      ...process.env,
      TZ: 'UTC',
      AGENT_COLLAB_HOME: ctx.home,
      AGENT_COLLAB_TEST_ADAPTER: path.join(path.dirname(binPath), '..', 'tests', 'fixtures', 'fake-adapter.mjs'),
      AGENT_COLLAB_FAKE_EXECUTOR: executor.address,
      ...env,
    },
  });
  return { ...result, lines: result.stdout.split('\n').filter(Boolean) };
}

test('watch 按行格式打印里程碑事件，任务停下后退出', async (t) => {
  const ctx = await createContext('watch');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, {
    turns: [turnWithReport(makeReport(), {
      steps: [
        { kind: 'event', event: { type: 'text', text: '这段文字不该出现' } },
        { kind: 'event', event: { type: 'thinking', text: '这段思考也不该出现' } },
        { kind: 'event', event: { type: 'tool_call', callId: 'c1', name: 'write', input: { file_path: 'src/a.js' } } },
        { kind: 'event', event: { type: 'usage', input: 3, output: 4, cacheRead: 0, cacheWrite: 0 } },
        { kind: 'human_message', text: '顺便加个注释' },
        { kind: 'approval', approvalId: 'ap-1', toolName: 'bash', callId: 'call-1', reason: '跑测试', holdMs: 100, outcome: 'allow' },
        { kind: 'question', callId: 'q-1', questions: [{ question: '用哪个端口？' }], holdMs: 100 },
        { kind: 'sleep', ms: 200 },
      ],
    })],
  });
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor });
  assert.equal(start.code, 0, start.stdout);

  const watched = await watchLines(ctx, [start.json.runId], {}, executor);
  assert.equal(watched.code, 0, watched.stderr);
  assert.ok(watched.lines.length > 0, 'watch 没有任何输出');
  for (const line of watched.lines) {
    assert.match(line, /^\[T\d{3,} \d{2}:\d{2}:\d{2}\] .+$/, '行格式不对：' + line);
  }
  const text = watched.lines.join('\n');
  assert.match(text, /状态 starting → running/);
  assert.match(text, /工具 write：src\/a\.js/);
  assert.match(text, /审批 pending：bash/);
  assert.match(text, /审批 resolved：bash → allow/);
  assert.match(text, /提问 pending：用哪个端口？/);
  assert.match(text, /用户插话：顺便加个注释/);
  assert.match(text, /第 1 轮结束/);
  assert.doesNotMatch(text, /这段文字不该出现/);
  assert.doesNotMatch(text, /这段思考也不该出现/);
  assert.match(text, /状态 running → done/);

  // 时间和本地时区一致（测试里 TZ=UTC）。
  const events = (await fsp.readFile(path.join(start.json.runDir, 'events.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line));
  const firstStatus = events.find((event) => event.type === 'status');
  const printedAt = watched.lines[0].slice(start.json.runId.length + 2, start.json.runId.length + 10);
  assert.equal(printedAt, new Date(firstStatus.at).toISOString().slice(11, 19));

  // 只打印里程碑事件：行数和状态事件、工具调用等一致，text 不占行。
  const milestoneCount = events.filter((event) => MILESTONES.includes(event.type)).length;
  assert.equal(watched.lines.length, milestoneCount);

  // 任务已经停下，再 watch 一次会补打剩余的里程碑后立刻退出。
  const lastN = events[events.length - 1].n;
  const again = await watchLines(ctx, [start.json.runId, '--from', String(lastN)], {}, executor);
  assert.equal(again.code, 0);
  assert.equal(again.lines.length, 1, '从最后一个事件开始时只打印一行：' + again.lines.join('|'));
  assert.match(again.lines[0], /状态 running → done/);
});

test('watch 找不到任务时退出码 4', async (t) => {
  const ctx = await createContext('watch-missing');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, { turns: [turnWithReport(makeReport())] });
  t.after(() => executor.stop());
  const watched = await watchLines(ctx, ['T999'], {}, executor);
  assert.equal(watched.code, 4);
  const payload = JSON.parse(watched.lines[0]);
  assert.equal(payload.error.code, 'run_not_found');
});
