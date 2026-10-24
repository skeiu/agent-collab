// 本文件：桥接写入发现文件用的原子写和 Windows 改名重试。桥接包不能引用 core/，这里保留一份与 core/platform.mjs 相同的逻辑；行为变化时两边同步。

import fsp from 'node:fs/promises';
import path from 'node:path';

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
// 默认总预算 10 秒：Windows 上并发读取或扫描可能持续占着目标文件的句柄。
const RENAME_DEFAULT_TIMEOUT_MS = 10000;
const RENAME_INITIAL_DELAY_MS = 10;
const RENAME_MAX_DELAY_MS = 100;
const RENAME_JITTER_MS = 10;

/**
 * 改名；Windows 上目标文件正被读取或扫描时 rename 可能持续失败（EPERM、EACCES、EBUSY），
 * 按总时长重试：默认预算 10 秒，间隔从 10 ms 起逐次加倍、上限 100 ms，另加 0–10 ms 抖动。
 * 超时仍失败时在最后一次错误上附加 attempts 和 elapsedMs。其他平台、其他错误码不重试。
 * platform、timeoutMs、initialDelayMs、maxDelayMs、jitterMs 可注入，便于测试。
 */
export async function renameWithRetry(from, to, options = {}) {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? RENAME_DEFAULT_TIMEOUT_MS;
  const initialDelayMs = options.initialDelayMs ?? RENAME_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? RENAME_MAX_DELAY_MS;
  const jitterMs = options.jitterMs ?? RENAME_JITTER_MS;
  const startedAt = Date.now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      return await fsp.rename(from, to);
    } catch (error) {
      const retryable = platform === 'win32' && RENAME_RETRY_CODES.has(error && error.code);
      if (!retryable) throw error;
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        if (error && typeof error === 'object') {
          error.attempts = attempts;
          error.elapsedMs = elapsedMs;
        }
        throw error;
      }
      const exponential = initialDelayMs * 2 ** (attempts - 1);
      const delay = Math.min(exponential, maxDelayMs);
      const jitter = jitterMs > 0 ? Math.random() * jitterMs : 0;
      const wait = Math.min(delay + jitter, timeoutMs - elapsedMs);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/** 原子写入 JSON 文件：同目录临时文件写完、改名；失败时清理临时文件并抛原错误。 */
export async function atomicWriteJson(file, value, options = {}) {
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
    await renameWithRetry(temporary, file, options);
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
