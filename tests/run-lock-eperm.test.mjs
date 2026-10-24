// 本文件：仓库锁对 Windows“正在删除的文件”（EPERM）的单元测试：只对 win32 的 EPERM 重试、预算用完后的处理，以及读不出来的锁不能当成没有锁。core/rundir.mjs 的锁行为变化时更新。

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  LockHeldError,
  acquireLock,
  lockFileFor,
  readLock,
  releaseLock,
  retryOnEperm,
  updateLock,
} from '../core/rundir.mjs';

const SHORT_RETRY = { platform: 'win32', timeoutMs: 60, initialDelayMs: 5, maxDelayMs: 5, jitterMs: 0 };

function failure(code, message) {
  const error = new Error(code + ': ' + message);
  error.code = code;
  return error;
}

async function makeHome(label) {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'agent-collab-lock-eperm-' + label + '-'));
}

test('重试工具：Windows 上操作先抛几次 EPERM 再成功', async () => {
  const original = failure('EPERM', 'operation not permitted, open');
  let calls = 0;
  const value = await retryOnEperm(async () => {
    calls += 1;
    if (calls <= 2) throw original;
    return 'ok';
  }, SHORT_RETRY);
  assert.equal(value, 'ok');
  assert.equal(calls, 3);
});

test('重试工具：Windows 上一直 EPERM，预算用完后抛原错误并带 attempts/elapsedMs', async () => {
  const original = failure('EPERM', 'operation not permitted, open');
  let calls = 0;
  await assert.rejects(
    retryOnEperm(async () => {
      calls += 1;
      throw original;
    }, SHORT_RETRY),
    (error) => {
      assert.equal(error, original);
      assert.equal(typeof error.attempts, 'number');
      assert.equal(error.attempts, calls);
      assert.ok(error.attempts > 1, '应至少重试一次，实际 attempts=' + error.attempts);
      assert.ok(error.elapsedMs >= 60, 'elapsedMs 应达到注入的预算，实际 ' + error.elapsedMs);
      assert.ok(error.elapsedMs < 1000, '短预算用例应在 1 秒内结束，实际 ' + error.elapsedMs);
      return true;
    },
  );
  assert.ok(calls > 1, '应至少调用两次操作');
});

test('重试工具：非 Windows 平台第一次 EPERM 就抛出，不重试', async () => {
  const original = failure('EPERM', 'operation not permitted, open');
  let calls = 0;
  await assert.rejects(
    retryOnEperm(async () => {
      calls += 1;
      throw original;
    }, { ...SHORT_RETRY, platform: 'linux' }),
    (error) => {
      assert.equal(error, original);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('readLock：Windows 上 EPERM 重试用完后按“读不出来”处理', async (t) => {
  const home = await makeHome('read');
  try {
    const file = path.join(home, 'active.lock');
    let calls = 0;
    t.mock.method(fsp, 'readFile', async () => {
      calls += 1;
      throw failure('EPERM', 'operation not permitted, open');
    });
    const result = await readLock(file, SHORT_RETRY);
    assert.equal(result.state, 'unreadable');
    assert.equal(result.error.code, 'EPERM');
    assert.ok(calls > 1, 'Windows 上应重试，实际调用 ' + calls + ' 次');
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('acquireLock：Windows 上 link 和独占复制一直 EPERM 时抛 LockHeldError，error.data 为 null', async (t) => {
  const home = await makeHome('acquire');
  try {
    let linkCalls = 0;
    t.mock.method(fsp, 'link', async () => {
      linkCalls += 1;
      throw failure('EPERM', 'operation not permitted, link');
    });
    t.mock.method(fsp, 'copyFile', async () => {
      throw failure('EPERM', 'operation not permitted, copyfile');
    });
    await assert.rejects(
      acquireLock({ home, repoId: 'repo-eperm', runId: 'T001', pid: process.pid, ...SHORT_RETRY }),
      (error) => {
        assert.ok(error instanceof LockHeldError);
        assert.equal(error.code, 'lock_held');
        assert.equal(error.data, null);
        return true;
      },
    );
    assert.ok(linkCalls > 1, 'link 上的 EPERM 应重试，实际调用 ' + linkCalls + ' 次');
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('lockAgeMs：Windows 上 stat 一直 EPERM 时按“刚写入”处理，不按文件不存在处理', async (t) => {
  const home = await makeHome('age');
  try {
    const repoId = 'repo-age';
    const file = lockFileFor(home, repoId);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // 内容不是 JSON：readLock 直接算读不出来，随后用 lockAgeMs 判断宽限。
    await fsp.writeFile(file, 'not json');
    t.mock.method(fsp, 'stat', async () => {
      throw failure('EPERM', 'operation not permitted, stat');
    });
    const startedAt = Date.now();
    await assert.rejects(
      acquireLock({ home, repoId, runId: 'T001', pid: process.pid, ...SHORT_RETRY }),
      (error) => {
        assert.ok(error instanceof LockHeldError);
        assert.equal(error.data, null);
        return true;
      },
    );
    const elapsed = Date.now() - startedAt;
    // 若把 EPERM 当成“文件不存在”（age 为 null），会一直尝试打破旧锁，直到 15 秒总预算用完。
    assert.ok(elapsed < 5000, '应按“刚写入”立即拒绝，实际用了 ' + elapsed + ' ms');
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('读不出来的锁：updateLock 报错且不写出缺字段的锁，releaseLock 报错且文件还在', async (t) => {
  const home = await makeHome('unreadable');
  try {
    const file = path.join(home, 'active.lock');
    await fsp.writeFile(file, 'not json');
    await assert.rejects(updateLock(file, { phase: 'worker' }), (error) => error.code === 'lock_unreadable');
    assert.equal(await fsp.readFile(file, 'utf8'), 'not json', 'updateLock 不应覆盖读不出来的锁');
    await assert.rejects(releaseLock(file, 'T001'), (error) => error.code === 'lock_unreadable');
    assert.equal(await fsp.readFile(file, 'utf8'), 'not json', 'releaseLock 不应删除读不出来的锁');
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('读不出来的锁：active.lock 是目录时 updateLock 和 releaseLock 都报错，目录还在', { skip: process.platform === 'win32' }, async () => {
  const home = await makeHome('dir');
  try {
    const file = path.join(home, 'active.lock');
    await fsp.mkdir(file);
    const read = await readLock(file);
    assert.equal(read.state, 'unreadable');
    await assert.rejects(updateLock(file, { phase: 'worker' }), (error) => error.code === 'lock_unreadable');
    assert.equal((await fsp.stat(file)).isDirectory(), true, 'updateLock 后 active.lock 应还是目录');
    await assert.rejects(releaseLock(file, 'T001'), (error) => error.code === 'lock_unreadable');
    assert.equal((await fsp.stat(file)).isDirectory(), true, 'releaseLock 后 active.lock 应还是目录');
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('updateLock：锁已经不存在时什么都不写，返回 null', async () => {
  const home = await makeHome('missing');
  try {
    const file = path.join(home, 'active.lock');
    const result = await updateLock(file, { phase: 'worker' });
    assert.equal(result, null);
    await assert.rejects(fsp.access(file), '不应创建只有补丁字段的锁');
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});
