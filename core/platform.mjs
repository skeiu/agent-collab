// 本文件：平台相关的少量工具（AGENT_COLLAB_HOME、私有目录和文件、原子写、PID 存活）。平台差异集中在这里；行为变化时更新。改名重试在桥接里有一份副本（dsh-bridge/lib/atomic-write.js），修改时同步。

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 解析 AGENT_COLLAB_HOME；未设置时为用户目录下的 .agent-collab。 */
export function resolveAgentCollabHome(env = process.env, homedir = os.homedir()) {
  const configured = env && env.AGENT_COLLAB_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured);
  return path.join(homedir, '.agent-collab');
}

/** 建只让本人读写的目录（POSIX 0700）；Windows 上跳过权限设置。 */
export async function ensurePrivateDir(dir) {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fsp.chmod(dir, 0o700);
  return dir;
}

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

/** 原子写入私有文件（POSIX 0600）：同目录临时文件写完、fsync 后改名。 */
export async function writePrivateFile(file, data, options = {}) {
  const platform = options.platform ?? process.platform;
  const dir = path.dirname(file);
  await ensurePrivateDir(dir);
  const suffix = crypto.randomBytes(8).toString('hex');
  const tmp = path.join(dir, '.' + path.basename(file) + '.tmp-' + process.pid + '-' + suffix);
  let handle;
  try {
    handle = await fsp.open(tmp, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(tmp, file, { ...options, platform });
    if (platform !== 'win32') await fsp.chmod(file, 0o600);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // 已经关闭。
      }
    }
    try {
      await fsp.unlink(tmp);
    } catch {
      // 临时文件可能尚未创建或已改名。
    }
    throw error;
  }
  if (options.fsyncDir !== false && platform !== 'win32') {
    try {
      const dirHandle = await fsp.open(dir, 'r');
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch {
      // 某些文件系统不支持目录 fsync；文件本身已经原子改名。
    }
  }
  return file;
}

/** 判断 PID 是否存活；没有权限查看时按存活处理。 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}
