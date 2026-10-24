// 本文件：改名重试的单元测试：core/platform.mjs 的 writePrivateFile 和 dsh-bridge 的 atomicWriteJson。两份实现都要覆盖“重试后成功”和“重试用尽抛原错误”，且不残留临时文件；平台可注入，Linux 上也能走 Windows 分支。

import assert from 'node:assert/strict';
import fsp, { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { writePrivateFile } from '../core/platform.mjs';
import { atomicWriteJson } from '../dsh-bridge/lib/atomic-write.js';

const writers = [
  {
    name: 'core/platform.mjs writePrivateFile',
    async write(file, value, options) {
      await writePrivateFile(file, value, options);
    },
    async read(file) {
      return readFile(file, 'utf8');
    },
  },
  {
    name: 'dsh-bridge atomicWriteJson',
    async write(file, value, options) {
      await atomicWriteJson(file, value, options);
    },
    async read(file) {
      return JSON.parse(await readFile(file, 'utf8'));
    },
  },
];

async function makeTemp() {
  return mkdtemp(path.join(os.tmpdir(), 'agent-collab-rename-'));
}

function failure(code, message) {
  const error = new Error(code + ': ' + message);
  error.code = code;
  return error;
}

for (const writer of writers) {
  test(writer.name + '：Windows 上 rename 前几次抛 EPERM 后重试成功，临时文件不残留', async (t) => {
    const root = await makeTemp();
    try {
      const file = path.join(root, 'config.json');
      const realRename = fsp.rename;
      let calls = 0;
      t.mock.method(fsp, 'rename', async (from, to) => {
        calls += 1;
        if (calls <= 3) throw failure('EPERM', 'operation not permitted, rename');
        return realRename(from, to);
      });
      await writer.write(file, 'content', { platform: 'win32' });
      assert.equal(await writer.read(file), 'content');
      assert.equal(calls, 4);
      assert.deepEqual(await readdir(root), ['config.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(writer.name + '：Windows 上重试用尽时抛出原错误并带 attempts/elapsedMs，临时文件不残留', async (t) => {
    const root = await makeTemp();
    try {
      const file = path.join(root, 'config.json');
      const original = failure('EBUSY', 'resource busy or locked, rename');
      let calls = 0;
      t.mock.method(fsp, 'rename', async () => {
        calls += 1;
        throw original;
      });
      await assert.rejects(writer.write(file, 'content', { platform: 'win32', timeoutMs: 200, jitterMs: 0 }), (error) => {
        assert.equal(error, original);
        assert.equal(typeof error.attempts, 'number');
        assert.equal(error.attempts, calls);
        assert.ok(error.attempts > 1, '应至少重试一次，实际 attempts=' + error.attempts);
        assert.equal(typeof error.elapsedMs, 'number');
        assert.ok(error.elapsedMs >= 200, 'elapsedMs 应达到注入的预算，实际 ' + error.elapsedMs);
        assert.ok(error.elapsedMs < 1000, '短预算用例应在 1 秒内结束，实际 ' + error.elapsedMs);
        return true;
      });
      assert.ok(calls > 1, '应至少调用两次 rename');
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(writer.name + '：非 Windows 平台不重试', async (t) => {
    const root = await makeTemp();
    try {
      const file = path.join(root, 'config.json');
      const original = failure('EPERM', 'operation not permitted, rename');
      let calls = 0;
      t.mock.method(fsp, 'rename', async () => {
        calls += 1;
        throw original;
      });
      await assert.rejects(writer.write(file, 'content', { platform: 'linux' }), (error) => {
        assert.equal(error, original);
        return true;
      });
      assert.equal(calls, 1);
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(writer.name + '：Windows 上其他错误码不重试', async (t) => {
    const root = await makeTemp();
    try {
      const file = path.join(root, 'config.json');
      const original = failure('ENOENT', 'no such file or directory, rename');
      let calls = 0;
      t.mock.method(fsp, 'rename', async () => {
        calls += 1;
        throw original;
      });
      await assert.rejects(writer.write(file, 'content', { platform: 'win32' }), (error) => {
        assert.equal(error, original);
        return true;
      });
      assert.equal(calls, 1);
      assert.deepEqual(await readdir(root), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
