// 本文件：平台相关的少量工具（AGENT_COLLAB_HOME、私有目录和文件、原子写、PID 存活）。平台差异集中在这里；行为变化时更新。

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

/** 原子写入私有文件（POSIX 0600）：同目录临时文件写完、fsync 后改名。 */
export async function writePrivateFile(file, data, options = {}) {
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
    await fsp.rename(tmp, file);
    if (process.platform !== 'win32') await fsp.chmod(file, 0o600);
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
  if (options.fsyncDir !== false && process.platform !== 'win32') {
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
