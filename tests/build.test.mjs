// 本文件：构建脚本测试。验证 SKILL.md 的 --check 核对、桥接 .tgz 的打包内容、--out 参数和零依赖约定；构建步骤或包内容变化时更新。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildScript = path.join(repoRoot, 'scripts', 'build.mjs');
const packageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));

function tarEntries(file) {
  const result = spawnSync('tar', ['-tzf', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'tar -tzf 失败：' + result.stderr);
  return result.stdout.split(/\r?\n/).filter(Boolean).filter((entry) => !entry.endsWith('/')).sort();
}

test('scripts/build.mjs 把 dsh-bridge 打成 .tgz，--out 生效，包内没有多余文件', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'agent-collab-build-'));
  const outDir = path.join(workDir, 'out');
  try {
    const result = spawnSync(process.execPath, [buildScript, '--out', outDir], {
      cwd: workDir,
      encoding: 'utf8',
    });

    assert.equal(result.signal, null, 'build.mjs 被信号终止：' + result.signal);
    assert.equal(result.status, 0, '退出码应为 0，实际 ' + result.status + '；stderr：' + result.stderr);
    assert.match(result.stdout, /仓库根目录：/, '应打印定位到的仓库根目录');
    assert.match(result.stdout, /尚未实现/, '应继续报告其他未实现的步骤');
    assert.match(result.stdout, /已完成：打包桥接/, '应报告桥接打包步骤已完成');

    const tgz = path.join(outDir, 'dsh-bridge-' + packageJson.version + '.tgz');
    const entries = tarEntries(tgz);
    assert.deepEqual(entries, [
      'package/cordis.patch.yml',
      'package/lib/acp-server.js',
      'package/lib/atomic-write.js',
      'package/lib/dsh-api.js',
      'package/lib/index.js',
      'package/lib/jsonrpc.js',
      'package/package.json',
    ], '包内文件应为 package.json、cordis.patch.yml 和 lib/ 下的五个文件');

    const bridgePackage = JSON.parse(await readFile(path.join(repoRoot, 'dsh-bridge', 'package.json'), 'utf8'));
    assert.equal(bridgePackage.version, packageJson.version, '桥接版本应与仓库根目录一致');
    assert.equal('dependencies' in bridgePackage, false, '桥接包不应声明 dependencies');
    assert.deepEqual(bridgePackage.dsh, { bundle: { patch: './cordis.patch.yml' } });
    assert.deepEqual(Object.keys(bridgePackage.peerDependencies), ['@deepseek-ai/dsh']);
    assert.match(bridgePackage.peerDependencies['@deepseek-ai/dsh'], /^>=0\.2\.1(?:-[0-9A-Za-z.-]+)? <0\.3\.0$/);
    assert.deepEqual(bridgePackage.peerDependenciesMeta, { '@deepseek-ai/dsh': { optional: true } });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

async function copyBuildTree(dest) {
  const files = [
    'package.json',
    'scripts/build.mjs',
    'core/render-skill.mjs',
    'skills/collab/SKILL.template.md',
    'skills/collab/hosts/claude.md',
    'skills/collab/SKILL.md',
  ];
  for (const relative of files) {
    const target = path.join(dest, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(repoRoot, relative), target);
  }
}

test('build.mjs --check 一致时不写文件、不生成 dist；模板改动后退出码 1', async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'agent-collab-build-check-'));
  try {
    await copyBuildTree(workDir);
    const skill = path.join(workDir, 'skills', 'collab', 'SKILL.md');
    const before = await stat(skill, { bigint: true });
    const ok = spawnSync(process.execPath, [path.join(workDir, 'scripts', 'build.mjs'), '--check'], {
      cwd: workDir,
      encoding: 'utf8',
    });
    assert.equal(ok.signal, null, 'build.mjs 被信号终止：' + ok.signal);
    assert.equal(ok.status, 0, '退出码应为 0，实际 ' + ok.status + '；stdout：' + ok.stdout + '；stderr：' + ok.stderr);
    assert.match(ok.stdout, /一致/);
    const after = await stat(skill, { bigint: true });
    assert.equal(after.mtimeNs, before.mtimeNs, '--check 不应改写 SKILL.md');
    await assert.rejects(stat(path.join(workDir, 'dist')), (error) => error && error.code === 'ENOENT');

    const template = path.join(workDir, 'skills', 'collab', 'SKILL.template.md');
    const text = await readFile(template, 'utf8');
    await writeFile(template, text.replace('# agent-collab：设计端流程', '# agent-collab：设计端流程（改）'));
    const changed = spawnSync(process.execPath, [path.join(workDir, 'scripts', 'build.mjs'), '--check'], {
      cwd: workDir,
      encoding: 'utf8',
    });
    assert.equal(changed.status, 1, '模板改动后应退出 1；stdout：' + changed.stdout + '；stderr：' + changed.stderr);
    assert.match(changed.stdout + changed.stderr, /不一致/);

    await rm(skill, { force: true });
    const missing = spawnSync(process.execPath, [path.join(workDir, 'scripts', 'build.mjs'), '--check'], {
      cwd: workDir,
      encoding: 'utf8',
    });
    assert.equal(missing.status, 1, '文件不存在时应退出 1；stdout：' + missing.stdout + '；stderr：' + missing.stderr);
    assert.match(missing.stdout + missing.stderr, /不存在/);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
