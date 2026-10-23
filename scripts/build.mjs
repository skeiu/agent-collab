// 本文件：仓库构建入口。定位仓库根目录，逐项执行构建步骤；当前只实现“打包桥接 .tgz”，其余两步仍报告尚未实现。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录：本文件位于 <仓库>/scripts/，因此上跳一层。 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeDir = path.join(repoRoot, 'dsh-bridge');

function parseArgs(argv) {
  const options = { out: path.join(repoRoot, 'dist') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0) throw new Error('--out requires a directory');
      options.out = path.resolve(value);
      index += 1;
    } else {
      throw new Error('unknown argument: ' + arg);
    }
  }
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function packBridge(outDir) {
  const rootManifest = readJson(path.join(repoRoot, 'package.json'));
  const bridgeManifest = readJson(path.join(bridgeDir, 'package.json'));
  if (bridgeManifest.version !== rootManifest.version) {
    throw new Error('dsh-bridge 版本 ' + bridgeManifest.version + ' 与仓库根目录版本 ' + rootManifest.version + ' 不一致');
  }
  fs.mkdirSync(outDir, { recursive: true });
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-collab-npm-'));
  let result;
  try {
    result = spawnSync(npmCommand, ['pack', '--json', '--pack-destination', outDir], {
      cwd: bridgeDir,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, npm_config_cache: cacheDir, npm_config_update_notifier: 'false' },
    });
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error('npm pack 失败（退出码 ' + result.status + '）：' + (result.stderr || '').trim());
  }
  let printed;
  try {
    printed = JSON.parse(result.stdout);
  } catch {
    throw new Error('npm pack 输出不是 JSON：' + result.stdout);
  }
  const filename = printed[0] && printed[0].filename;
  if (typeof filename !== 'string' || filename.length === 0) throw new Error('npm pack 没有报告产物文件名');
  return path.join(outDir, filename);
}

/**
 * 构建步骤清单。未实现的步骤只报告，不产出文件。
 * output 为相对仓库根目录或 --out 的产物位置。
 */
const steps = [
  {
    name: '生成 SKILL.md',
    output: 'skills/collab/SKILL.md',
    note: '由 SKILL.template.md 与 hosts/<设计端>.md 渲染（core/render-skill.mjs，PLAN.md §7.1）',
  },
  {
    name: '打包桥接 .tgz',
    output: 'dist/（dsh-bridge 打包成 .tgz）',
    note: 'dsh Web 插件随运行时分发（PLAN.md §9、§14）',
    run: packBridge,
  },
  {
    name: '组装运行时',
    output: 'dist/（core/ 的运行时副本）',
    note: '供安装时复制到 ~/.agent-collab/runtime/<版本>/（PLAN.md §7.2）',
  },
];

function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log('仓库根目录：' + repoRoot);
  console.log('构建步骤：共 ' + steps.length + ' 项。');
  for (const step of steps) {
    if (typeof step.run !== 'function') {
      console.log('- 尚未实现：' + step.name);
      console.log('    产物：' + step.output);
      console.log('    说明：' + step.note);
      continue;
    }
    const output = step.run(options.out);
    console.log('- 已完成：' + step.name);
    console.log('    产物：' + output);
  }
  console.log('构建结束。');
}

main();
