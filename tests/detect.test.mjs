// 本文件：dsh 探测的单元测试（DA1）：入口包装、DSH_HOME 优先级、发现文件、桥接安装判断。

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  parseNpmCmdWrapper,
  parseNpmShellWrapper,
  readBridgeInstallation,
  readDiscoveryFile,
  resolveDshEntry,
  resolveDshHome,
} from '../core/detect.mjs';
import { installFakeDsh } from './helpers/fake-dsh-install.mjs';

async function tempRoot(label) {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'agent-collab-detect-' + label + '-'));
}

async function writeDiscovery(home, profile, record) {
  const dir = path.join(home, 'agent-collab');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'bridge-' + profile + '.json');
  await fsp.writeFile(file, typeof record === 'string' ? record : JSON.stringify(record));
  return file;
}

function discoveryRecord(overrides = {}) {
  return {
    v: 1,
    host: '127.0.0.1',
    port: 12345,
    token: 'token',
    pid: 1234,
    protocol: 1,
    protocolMin: 1,
    bridgeVersion: '0.0.0',
    dshVersion: '0.2.1',
    profile: 'web',
    startedAt: '2026-10-24T00:00:00.000Z',
    ...overrides,
  };
}

test('POSIX 符号链接：解析出入口 .js，记录 how', async (t) => {
  const root = await tempRoot('symlink');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fake = await installFakeDsh(root);
  const resolved = await resolveDshEntry(fake.link, { platform: 'linux', env: process.env });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.how, 'symlink');
  // 适配器返回的是 realpath 解析后的入口；临时目录本身可能是符号链接（macOS 的 /var → /private/var，
  // Windows 的 8.3 短文件名），期望值也要按真实路径比较，不能拿未解析的路径。
  assert.equal(resolved.file, await fsp.realpath(fake.entry));
});

test('POSIX npm shell 包装：解析 $basedir 指向的入口', async (t) => {
  const root = await tempRoot('shell');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const fake = await installFakeDsh(root);
  const resolved = await resolveDshEntry(fake.wrapper, { platform: 'linux', env: process.env });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.how, 'shell-wrapper');
  assert.equal(resolved.file, fake.entry);
  assert.equal(parseNpmShellWrapper('#!/bin/sh\nexec "$basedir/../@deepseek-ai/dsh/lib/bin.js" "$@"\n'), '../@deepseek-ai/dsh/lib/bin.js');
});

test('Windows .cmd 包装：纯函数解析 %dp0% 指向的入口', async () => {
  const text = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\n:start\r\n"%dp0%\\..\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n';
  assert.equal(parseNpmCmdWrapper(text), '..\\@deepseek-ai\\dsh\\lib\\bin.js');
  assert.equal(parseNpmCmdWrapper('not a wrapper'), null);
});

test('DSH_HOME 四级优先顺序：配置、环境、登录 shell、默认值', async () => {
  const loginShell = { ok: true, env: { DSH_HOME: '/from/login-shell' }, shell: '/bin/sh' };
  // resolveDshHome 用 path.resolve 把结果转成当前平台的绝对路径：Windows 上 '/from/config' 会变成
  // D:\from\config，所以期望值也要用 path.resolve 算，不能写死 POSIX 路径。
  assert.deepEqual(
    await resolveDshHome({ configHome: '/from/config', env: { DSH_HOME: '/from/env' }, platform: 'linux', loginShell }),
    { home: path.resolve('/from/config'), source: 'config', loginShell: null },
  );
  assert.deepEqual(
    await resolveDshHome({ configHome: null, env: { DSH_HOME: '/from/env' }, platform: 'linux', loginShell }),
    { home: path.resolve('/from/env'), source: 'env', loginShell: null },
  );
  assert.deepEqual(
    await resolveDshHome({ configHome: null, env: {}, platform: 'linux', loginShell }),
    { home: path.resolve('/from/login-shell'), source: 'login-shell', loginShell },
  );
  assert.deepEqual(
    await resolveDshHome({ configHome: null, env: {}, platform: 'linux', homedir: () => path.join('fake', 'home'), loginShell: { ok: false, reason: 'no' } }),
    { home: path.join('fake', 'home', '.dsh'), source: 'default', loginShell: { ok: false, reason: 'no' } },
  );
  const windows = await resolveDshHome({ configHome: null, env: {}, platform: 'win32', homedir: () => 'C:\\Users\\me' });
  assert.equal(windows.source, 'default');
  assert.match(windows.home, /[.]dsh$/);
});

test('发现文件：不存在、pid 不存活、带 problem、格式错、协议无交集', async (t) => {
  const root = await tempRoot('discovery');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  await fsp.mkdir(home, { recursive: true });

  const missing = await readDiscoveryFile({ home, profile: 'web' });
  assert.equal(missing.online, false);
  assert.match(missing.reason, /不存在/);

  await writeDiscovery(home, 'web', discoveryRecord());
  const dead = await readDiscoveryFile({ home, profile: 'web', isAlive: () => false });
  assert.equal(dead.online, false);
  assert.match(dead.reason, /进程 1234 不在/);

  await writeDiscovery(home, 'web', discoveryRecord({ problem: 'dsh 版本不支持' }));
  const problem = await readDiscoveryFile({ home, profile: 'web', isAlive: () => true });
  assert.equal(problem.online, false);
  assert.match(problem.reason, /dsh 版本不支持/);

  await writeDiscovery(home, 'web', '{not json');
  const malformed = await readDiscoveryFile({ home, profile: 'web', isAlive: () => true });
  assert.equal(malformed.online, false);
  assert.match(malformed.reason, /格式错误/);

  await writeDiscovery(home, 'web', discoveryRecord({ protocol: 2, protocolMin: 2 }));
  const incompatible = await readDiscoveryFile({ home, profile: 'web', isAlive: () => true });
  assert.equal(incompatible.online, false);
  assert.match(incompatible.reason, /没有交集/);

  await writeDiscovery(home, 'web', discoveryRecord());
  const online = await readDiscoveryFile({ home, profile: 'web', isAlive: () => true });
  assert.equal(online.online, true);
  assert.equal(online.record.port, 12345);
});

test('桥接是否装进 profile：依赖里有和没有各一个用例', async (t) => {
  const root = await tempRoot('install');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const profileDir = path.join(home, 'profiles', 'web');
  await fsp.mkdir(profileDir, { recursive: true });
  await fsp.writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-bridge': 'file:x' }, dsh: { profile: { bundles: ['dsh-bridge'] } } }));
  const installed = await readBridgeInstallation({ home, profile: 'web' });
  assert.equal(installed.installed, true);
  assert.equal(installed.field, 'dependencies');
  assert.equal(installed.bundleListed, true);

  await fsp.writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ dependencies: { other: '1' } }));
  const missing = await readBridgeInstallation({ home, profile: 'web' });
  assert.equal(missing.installed, false);
  assert.match(missing.reason, /dependencies/);
});
