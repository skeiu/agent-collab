// 本文件：core/platform.mjs 的单元测试。覆盖 AGENT_COLLAB_HOME、私有权限、原子写和 PID 存活；平台行为变化时更新。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ensurePrivateDir, isPidAlive, resolveAgentCollabHome, writePrivateFile } from '../core/platform.mjs';

async function makeTemp() {
  return mkdtemp(path.join(os.tmpdir(), 'agent-collab-platform-'));
}

test('AGENT_COLLAB_HOME 生效，未设置时使用用户目录下的 .agent-collab', () => {
  const configured = path.join(os.tmpdir(), 'agent-collab-custom-home');
  const fakeHome = path.join(os.tmpdir(), 'agent-collab-example-home');
  assert.equal(resolveAgentCollabHome({ AGENT_COLLAB_HOME: configured }), path.resolve(configured));
  assert.equal(resolveAgentCollabHome({ AGENT_COLLAB_HOME: '' }, fakeHome), path.join(fakeHome, '.agent-collab'));
  assert.equal(resolveAgentCollabHome({}, fakeHome), path.join(fakeHome, '.agent-collab'));
});

test('ensurePrivateDir 创建 0700 的目录（Windows 跳过权限断言）', async () => {
  const root = await makeTemp();
  try {
    const dir = path.join(root, 'a', 'b');
    await ensurePrivateDir(dir);
    const info = await stat(dir);
    assert.ok(info.isDirectory());
    if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o700);
    await ensurePrivateDir(dir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writePrivateFile 原子写入 0600 文件，不留临时文件，可覆盖旧内容', async () => {
  const root = await makeTemp();
  try {
    const file = path.join(root, 'nested', 'config.json');
    await writePrivateFile(file, 'first');
    assert.equal(await readFile(file, 'utf8'), 'first');
    await writePrivateFile(file, 'second');
    assert.equal(await readFile(file, 'utf8'), 'second');
    const names = await readdir(path.dirname(file));
    assert.deepEqual(names, ['config.json']);
    if (process.platform !== 'win32') {
      const info = await stat(file);
      assert.equal(info.mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('isPidAlive 对当前进程为 true，对已退出的子进程为 false', async () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const pid = child.pid;
  await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(isPidAlive(pid), false);
});
