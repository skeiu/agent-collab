// 本文件：测试发现规则的冒烟测试。确认 fixtures/ 和 integration/ 不会被 node --test 当成测试；测试目录结构变化时更新。

import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

function matchesNodeTestPattern(file) {
  const base = path.basename(file);
  const relative = path.relative(repoRoot, file).split(path.sep);
  if (relative.includes('test')) return true;
  return /(^test-.*|.*\.test|.*-test|.*_test)\.(c|m)?js$/.test(base) || /^test\.(c|m)?js$/.test(base);
}

test('tests/fixtures 和 tests/integration 下的文件不会被 node --test 发现', async () => {
  const files = await walk(repoRoot);
  const special = files.filter((file) => {
    const relative = path.relative(repoRoot, file).split(path.sep);
    return relative[0] === 'tests' && (relative[1] === 'fixtures' || relative[1] === 'integration');
  });
  assert.ok(special.length > 0, 'should find fixture and integration files');
  for (const file of special) {
    assert.equal(matchesNodeTestPattern(file), false, path.relative(repoRoot, file) + ' 会被 node --test 当成测试');
  }
});
