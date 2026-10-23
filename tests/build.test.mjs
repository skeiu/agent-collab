// 本文件：构建脚本冒烟测试。验证 scripts/build.mjs 能跑通并退出 0，且在任意工作目录下都能定位仓库。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildScript = path.join(repoRoot, 'scripts', 'build.mjs');

test('scripts/build.mjs 能跑通并退出 0', async () => {
  // 临时目录只放在 os.tmpdir() 下；用它当工作目录，确认脚本靠 import.meta.url 而非 cwd 定位仓库。
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'agent-collab-build-'));
  try {
    const result = spawnSync(process.execPath, [buildScript], {
      cwd: workDir,
      encoding: 'utf8',
    });

    assert.equal(result.signal, null, `build.mjs 被信号终止：${result.signal}`);
    assert.equal(result.status, 0, `退出码应为 0，实际 ${result.status}；stderr：${result.stderr}`);
    assert.match(result.stdout, /仓库根目录：/, '应打印定位到的仓库根目录');
    assert.match(result.stdout, /尚未实现/, '应逐项报告尚未实现的步骤');
    for (const step of ['SKILL.md', '.tgz', '运行时']) {
      assert.ok(result.stdout.includes(step), `输出应提到尚未实现的步骤：${step}`);
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
