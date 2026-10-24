// 本文件：断言 CLI 退出码的统一写法：失败信息带退出码、信号、stdout 和 stderr，进程被外部结束时能看出来。只给测试使用。

import assert from 'node:assert/strict';

/** 断言命令的退出码；失败时把退出码、信号和完整输出写进断言信息。 */
export function assertExit(result, expected = 0) {
  const value = result || {};
  if (value.code === expected) return value;
  const stdout = String(value.stdout == null ? '' : value.stdout);
  const stderr = String(value.stderr == null ? '' : value.stderr);
  const head = '退出码不符：期望 ' + expected + '，实际 ' + String(value.code)
    + (value.signal ? '（进程被信号 ' + value.signal + ' 结束）' : '');
  const empty = stdout === '' && stderr === '' ? '\n没有任何输出（进程可能被外部结束）' : '';
  assert.fail([head + empty, 'stdout：\n' + stdout, 'stderr：\n' + stderr].join('\n'));
}
