// 本文件：桥接写入发现文件用的原子写和 Windows 改名重试。桥接包不能引用 core/，这里保留一份与 core/platform.mjs 相同的逻辑；行为变化时两边同步。

import fsp from 'node:fs/promises';
import path from 'node:path';

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
// 9 个退避间隔，加首次尝试共 10 次；合计约 1.1 秒。
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160, 200, 200, 200, 200];

/**
 * 改名；Windows 上目标文件正被读取时 rename 可能暂时失败（EPERM、EACCES、EBUSY），
 * 按退避间隔重试，最多 10 次。其他平台、其他错误码不重试。
 * platform 可注入，便于在非 Windows 平台上测试 Windows 分支。
 */
export async function renameWithRetry(from, to, options = {}) {
  const platform = options.platform ?? process.platform;
  const attempts = RENAME_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fsp.rename(from, to);
    } catch (error) {
      const retryable = platform === 'win32' && RENAME_RETRY_CODES.has(error && error.code);
      if (!retryable || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]));
    }
  }
}

/** 原子写入 JSON 文件：同目录临时文件写完、改名；失败时清理临时文件并抛原错误。 */
export async function atomicWriteJson(file, value, options = {}) {
  const platform = options.platform ?? process.platform;
  const directory = path.dirname(file);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fsp.chmod(directory, 0o700);
  } catch {
    // Windows 或没有权限位的文件系统。
  }
  const temporary = file + '.tmp-' + process.pid + '-' + Date.now();
  try {
    await fsp.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await renameWithRetry(temporary, file, { platform });
  } finally {
    try {
      await fsp.rm(temporary, { force: true });
    } catch {
      // 临时文件可能尚未创建或已改名。
    }
  }
  try {
    await fsp.chmod(file, 0o600);
  } catch {
    // Windows 或没有权限位的文件系统。
  }
  return file;
}
