// 本文件：package.json 约定冒烟测试。确认零依赖，以及模块类型、engines 和 scripts 符合约定。

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));

test('package.json 不声明任何依赖', () => {
  const dependencyKeys = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  const declared = dependencyKeys.filter((key) => key in pkg);
  assert.deepEqual(declared, [], `package.json 不应声明依赖，实际声明了：${declared.join(', ')}`);
});

test('package.json 的模块类型、engines 和 scripts 符合约定', () => {
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines?.node, '>=20');
  assert.equal(pkg.scripts?.test, 'node --test');
  assert.equal(pkg.scripts?.build, 'node scripts/build.mjs');
});
