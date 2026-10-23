// 实验 18：dsh plugin add <tgz> 的 pnpm 来源，以及无依赖 tgz 能否离线安装。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assert, commandPath, createSandbox, findDsh, hasPnpm, installPlugin, makePlugin, runDsh } from '../_shared/harness.mjs';

const box = createSandbox('18');
try {
  const dsh = findDsh(box.env);
  const globalPnpm = commandPath(box.env, 'pnpm');
  const corepack = commandPath(box.env, 'corepack');
  console.log('[18] global pnpm on PATH: ' + (globalPnpm ? globalPnpm : '(none)'));
  console.log('[18] corepack on PATH: ' + (corepack ? corepack : '(none)'));
  assert(corepack, 'corepack is missing; cannot bootstrap pnpm');

  const tgz = makePlugin(box.root, box.env, {
    name: 'dsh-exp-18-offline',
    version: '1.0.0',
    main: fs.readFileSync(new URL('./plugin/index.js', import.meta.url), 'utf8'),
    patch: fs.readFileSync(new URL('./plugin/cordis.patch.yml', import.meta.url), 'utf8'),
  });

  // 用空 PATH 模拟“没有全局 pnpm”的机器，不依赖当前开发机是否装了 pnpm。
  const emptyBin = path.join(box.root, 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });
  const noPnpmEnv = { ...box.env, PATH: emptyBin };
  const withoutPnpm = installPlugin(noPnpmEnv, dsh, 'web', tgz);
  console.log('[18] dsh plugin add without pnpm: exit=' + withoutPnpm.status + ', stderr=' + JSON.stringify(withoutPnpm.stderr.trim().split('\n').slice(-2).join(' | ')));
  assert(withoutPnpm.status !== 0, 'dsh plugin add unexpectedly succeeded without pnpm');
  assert(withoutPnpm.stderr.includes('pnpm was not found'), 'missing-pnpm diagnostic is not the expected one');

  const bin = path.join(box.root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const enable = spawnSync(corepack, ['enable', '--install-directory', bin, 'pnpm'], { env: box.env, encoding: 'utf8', timeout: 30000 });
  assert(enable.status === 0, 'corepack enable failed: ' + enable.stderr);
  box.env.PATH = bin + path.delimiter + box.env.PATH;
  const version = spawnSync('pnpm', ['--version'], { env: box.env, encoding: 'utf8', timeout: 180000 });
  assert(version.status === 0, 'corepack pnpm shim failed: ' + version.stderr);
  const bootstrapNote = (version.stderr || '').split('\n').find((line) => /Downloading|Corepack|download/i.test(line)) || '(no download line captured)';
  console.log('[18] corepack pnpm shim version: ' + version.stdout.trim() + '; bootstrap: ' + bootstrapNote);

  box.env.npm_config_registry = 'http://127.0.0.1:9';
  const offline = installPlugin(box.env, dsh, 'web', tgz, ['--offline']);
  console.log('[18] dsh plugin add --offline with unreachable registry: exit=' + offline.status);
  if (offline.status !== 0) console.log('[18] stderr: ' + offline.stderr.slice(-1200));
  assert(offline.status === 0, 'offline install of a dependency-free tgz failed');
  const profile = JSON.parse(fs.readFileSync(path.join(box.home, 'profiles', 'web', 'package.json'), 'utf8'));
  const bundles = profile.dsh?.profile?.bundles ?? [];
  assert(bundles.includes('dsh-exp-18-offline'), 'profile did not select the installed bundle');
  console.log('[18] installed and selected bundle: ' + bundles.join(', '));

  console.log('RESULT: 部分成立 — dsh plugin 只调用 PATH 上的 pnpm（本机无全局 pnpm，dsh 本身不会用 corepack）；可用 corepack 生成 pnpm shim，但首次获取 pnpm 需要联网。pnpm 就绪后，无依赖 .tgz 在 registry 不可达且 --offline 下可以安装并选中。');
} finally {
  box.cleanup();
}
