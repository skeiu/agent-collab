// 本文件：S3 遗留的 lock_unreadable 测试（DA9）：按 PID 结束工作进程后收尾时锁读不出来，命令仍成功。

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  createContext,
  makeReport,
  runCli,
  startFakeExecutor,
  turnWithReport,
  waitFor,
  readJson,
} from './helpers/run-harness.mjs';

test('run cancel 按 PID 结束工作进程后，锁读不出来仍输出 ok true 并保留锁', async (t) => {
  const ctx = await createContext('cancel-lock-unreadable');
  t.after(() => ctx.cleanup());
  const env = { AGENT_COLLAB_TEST_CANCEL_TIMEOUT_MS: '700', AGENT_COLLAB_TEST_KILL_GRACE_MS: '500' };
  const executor = await startFakeExecutor(ctx, {
    ignoreCancel: true,
    turns: [turnWithReport(makeReport(), { steps: [{ kind: 'sleep', ms: 20000 }] })],
  });
  t.after(() => executor.stop());
  const briefPath = path.join(ctx.root, 'brief.md');
  await fsp.writeFile(briefPath, '# 任务\n');
  const start = await runCli(ctx, ['run', 'start', '--brief', briefPath, '--executor', 'fake'], { executor, env });
  assert.equal(start.code, 0, start.stdout);
  const statePath = path.join(start.json.runDir, 'state.json');
  await waitFor(async () => {
    const state = await readJson(statePath).catch(() => null);
    return state && state.status === 'running' && state.worker;
  }, { label: '任务进入 running' });

  const lockFile = path.join(path.dirname(start.json.runDir), 'active.lock');
  await fsp.rm(lockFile, { force: true });
  await fsp.mkdir(lockFile);

  const cancelled = await runCli(ctx, ['run', 'cancel', start.json.runId], { executor, env });
  assert.equal(cancelled.code, 0, cancelled.stdout + cancelled.stderr);
  assert.equal(cancelled.json.ok, true, cancelled.stdout);
  assert.equal(cancelled.json.status, 'cancelled');
  assert.match(cancelled.stderr, /锁未释放/);
  assert.match(cancelled.stderr, /旧锁/);
  const lockStat = await fsp.lstat(lockFile);
  assert.equal(lockStat.isDirectory(), true, '读不出来的锁不能被删掉');
  const state = await readJson(statePath);
  assert.equal(state.status, 'cancelled');
});
