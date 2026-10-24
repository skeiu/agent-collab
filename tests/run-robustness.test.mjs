// 本文件：S3 的健壮性测试：state.json 写入失败不退出（记 warning 后继续）、run wait 超时、运行目录和文件的权限（AC13 的一部分）。

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

test('注入一次 state.json 写入失败，任务仍正常走到终态', async (t) => {
  const ctx = await createContext('state-write');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, {
    turns: [turnWithReport(makeReport(), {
      steps: [
        { kind: 'event', event: { type: 'text', text: '开始' } },
        { kind: 'sleep', ms: 150 },
      ],
    })],
  });
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');

  const env = { AGENT_COLLAB_TEST_STATE_WRITE_FAIL_ONCE: '1' };
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, env });
  assert.equal(start.code, 0, start.stdout);
  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor, env });
  assert.equal(wait.json.status, 'done', JSON.stringify(wait.json));

  const runDir = start.json.runDir;
  const events = (await fsp.readFile(path.join(runDir, 'events.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === 'warning' && event.message.includes('state.json 写入失败')), '缺少写入失败的 warning 事件');
  const summary = await readJson(path.join(runDir, 'summary.json'));
  assert.equal(summary.status, 'done');
  assert.ok(summary.warnings.some((item) => item.includes('state.json 写入失败')));
});

test('run wait 带 --timeout 时超时返回 timedOut: true，退出码 0', async (t) => {
  const ctx = await createContext('wait-timeout');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, {
    turns: [turnWithReport(makeReport(), { steps: [{ kind: 'sleep', ms: 5000 }] })],
  });
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor });
  assert.equal(start.code, 0, start.stdout);
  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '0.4'], { executor });
  assert.equal(wait.code, 0, wait.stdout);
  assert.equal(wait.json.ok, true);
  assert.equal(wait.json.timedOut, true);
  assert.equal(wait.json.runId, start.json.runId);
  await runCli(ctx, ['run', 'cancel', start.json.runId], { executor });
});

test('运行目录是 0700、文件是 0600', { skip: process.platform === 'win32' }, async (t) => {
  const ctx = await createContext('perms');
  t.after(() => ctx.cleanup());
  const executor = await startFakeExecutor(ctx, { turns: [turnWithReport(makeReport())] });
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor });
  assert.equal(start.code, 0, start.stdout);
  const wait = await runCli(ctx, ['run', 'wait', start.json.runId, '--timeout', '20'], { executor });
  assert.equal(wait.json.status, 'done');
  const runDir = start.json.runDir;
  const dirMode = (await fsp.stat(runDir)).mode & 0o777;
  assert.equal(dirMode, 0o700, '运行目录权限是 ' + dirMode.toString(8));
  for (const name of ['state.json', 'summary.json', 'events.jsonl', 'brief.md', 'patch-1.diff', 'report-1.json', 'baseline.json']) {
    const mode = (await fsp.stat(path.join(runDir, name))).mode & 0o777;
    assert.equal(mode, 0o600, name + ' 权限是 ' + mode.toString(8));
  }
});
