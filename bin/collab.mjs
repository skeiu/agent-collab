#!/usr/bin/env node
// 本文件：开发模式的命令行启动器：加载本仓库 core/ 下的模块，把 run …、watch …、doctor 转过去；其他命令以用法错误退出。

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const binFile = fileURLToPath(import.meta.url);
const coreDir = path.resolve(path.dirname(binFile), '..', 'core');

function print(value) {
  process.stdout.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value) + '\n');
}

function usage(message) {
  print({ ok: false, error: { code: 'usage', message } });
  return 2;
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (!command) return usage('用法：collab <run|watch|doctor> …');
  if (command === 'run') {
    const module = await import(pathToFileURL(path.join(coreDir, 'run.mjs')).href);
    return module.runCommands(rest);
  }
  if (command === 'watch') {
    const module = await import(pathToFileURL(path.join(coreDir, 'watch.mjs')).href);
    return module.watchCommand(rest);
  }
  if (command === 'doctor') {
    const module = await import(pathToFileURL(path.join(coreDir, 'doctor.mjs')).href);
    return module.doctorCommand(rest);
  }
  return usage('命令 ' + command + ' 尚未实现（1a 开发模式只有 run、watch 和 doctor）');
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    process.stderr.write((error && error.stack ? error.stack : String(error)) + '\n');
    process.exitCode = 1;
  });
