// 本文件：测试用的假 dsh 安装：包目录 + lib/bin.js + PATH 上的 dsh 符号链接/包装 + 极简 YAML 库。只给单元测试使用。

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = path.dirname(fileURLToPath(import.meta.url));

/** 在 root 下建一个假 dsh 安装；options.yamlLibraries 可选 'js-yaml'、'yaml'，默认只有 js-yaml。返回入口、bin 目录和 shell 包装路径。 */
export async function installFakeDsh(root, options = {}) {
  const packageDir = path.join(root, 'node_modules', 'fake-dsh');
  const libDir = path.join(packageDir, 'lib');
  await fsp.mkdir(libDir, { recursive: true });
  await fsp.copyFile(path.join(fixtures, '..', 'fixtures', 'fake-dsh-cli.mjs'), path.join(libDir, 'bin.js'));
  await fsp.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({
    name: 'fake-dsh',
    version: '0.2.1',
    type: 'module',
    bin: { dsh: 'lib/bin.js' },
  }, null, 2) + '\n');

  const yamlLibraries = options.yamlLibraries ?? ['js-yaml'];
  if (yamlLibraries.includes('js-yaml')) {
    const yamlDir = path.join(packageDir, 'node_modules', 'js-yaml');
    await fsp.mkdir(yamlDir, { recursive: true });
    await fsp.writeFile(path.join(yamlDir, 'package.json'), JSON.stringify({ name: 'js-yaml', version: '4.1.0', main: 'index.js' }) + '\n');
    await fsp.writeFile(path.join(yamlDir, 'index.js'), [
      '// 测试用的极简 YAML 库：JSON 是 YAML 的子集，只验证接线。',
      'export const JSON_SCHEMA = { extend() { return JSON_SCHEMA; } };',
      'export class Type { constructor(tag, options) { this.tag = tag; this.options = options; } }',
      'export function load(text) { return JSON.parse(text); }',
      'export function dump(value) { return JSON.stringify(value); }',
      '',
    ].join('\n'));
  }
  if (yamlLibraries.includes('yaml')) {
    const yamlDir = path.join(packageDir, 'node_modules', 'yaml');
    await fsp.mkdir(yamlDir, { recursive: true });
    await fsp.writeFile(path.join(yamlDir, 'package.json'), JSON.stringify({ name: 'yaml', version: '2.5.0', main: 'index.js' }) + '\n');
    await fsp.writeFile(path.join(yamlDir, 'index.js'), [
      '// 测试用的极简 YAML 库：只有 parse/stringify，没有 !!js 类型。',
      'export function parse(text) { return JSON.parse(text); }',
      'export function stringify(value) { return JSON.stringify(value); }',
      '',
    ].join('\n'));
  }

  const binDir = path.join(root, 'bin');
  await fsp.mkdir(binDir, { recursive: true });
  const entry = path.join(libDir, 'bin.js');
  const link = path.join(binDir, 'dsh');
  try {
    await fsp.symlink(path.relative(binDir, entry), link);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const wrapper = path.join(binDir, 'dsh-wrapper');
  await fsp.writeFile(wrapper, [
    '#!/bin/sh',
    'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
    'exec node "$basedir/../node_modules/fake-dsh/lib/bin.js" "$@"',
    '',
  ].join('\n'), { mode: 0o755 });
  return { packageDir, entry, binDir, link, wrapper };
}
