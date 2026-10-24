// 本文件：运行目录、仓库标识、任务号和仓库锁（D23；docs/protocol.md 5.1、5.2）。run.mjs、worker.mjs、watch.mjs 共用；规则变化时更新。

import { constants as fsConstants } from 'node:fs';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ensurePrivateDir, isPidAlive, writePrivateFile } from './platform.mjs';

/** 仓库锁已被占用。 */
export class LockHeldError extends Error {
  constructor(message, data, options = {}) {
    super(message);
    this.name = 'LockHeldError';
    this.code = 'lock_held';
    this.data = data ?? null;
    if (options.cause) this.cause = options.cause;
  }
}

/** 锁文件读不出来：改写或释放锁时不能当成“没有锁”。 */
export class LockUnreadableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'LockUnreadableError';
    this.code = 'lock_unreadable';
    if (cause) this.cause = cause;
  }
}

/** 仓库标识：根目录名（非法字符换 _）加路径 SHA-256 前 8 位；Windows 先转小写再算哈希。 */
export function repoIdFor(repoRoot, platform = process.platform) {
  const resolved = path.resolve(repoRoot);
  const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
  const base = path.basename(resolved).replace(/[^A-Za-z0-9._-]/g, '_');
  const hash = crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8);
  return base + '-' + hash;
}

/** 所有仓库的运行目录根。 */
export function runsRoot(home) {
  return path.join(home, 'runs');
}

/** 某个仓库的运行目录。 */
export function repoRunsDir(home, repoId) {
  return path.join(runsRoot(home), repoId);
}

/** 某个任务的运行目录。 */
export function runDirFor(home, repoId, runId) {
  return path.join(repoRunsDir(home, repoId), runId);
}

/** 仓库锁文件路径。 */
export function lockFileFor(home, repoId) {
  return path.join(repoRunsDir(home, repoId), 'active.lock');
}

/** 任务号里的数字。 */
export function runIdNumber(runId) {
  const matched = /^T(\d+)$/.exec(String(runId ?? ''));
  return matched ? Number(matched[1]) : 0;
}

/** 数字转任务号：T 加至少三位数字。 */
export function formatRunId(number) {
  return 'T' + String(number).padStart(3, '0');
}

/** 列出某个仓库已有任务号，按数字升序。 */
export async function listRunIds(home, repoId) {
  let entries;
  try {
    entries = await fsp.readdir(repoRunsDir(home, repoId), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && /^T\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => runIdNumber(left) - runIdNumber(right));
}

/** 列出 AGENT_COLLAB_HOME 下所有仓库标识。 */
export async function listRepoIds(home) {
  let entries;
  try {
    entries = await fsp.readdir(runsRoot(home), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/** 读 JSON 文件；不存在时返回 null。 */
export async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** 原子写 JSON（0600）。 */
export async function writeJson(file, value) {
  await writePrivateFile(file, JSON.stringify(value, null, 2) + '\n');
  return value;
}

/**
 * 用 mkdir 分配任务号：取已有最大号加 1，目录已存在就再加 1，并发时不会重号。
 * 目录权限 0700。
 */
export async function allocateRunDir(home, repoId) {
  const repoDir = repoRunsDir(home, repoId);
  await ensurePrivateDir(repoDir);
  const existing = await listRunIds(home, repoId);
  let next = existing.reduce((max, runId) => Math.max(max, runIdNumber(runId)), 0) + 1;
  for (;;) {
    const runId = formatRunId(next);
    const runDir = path.join(repoDir, runId);
    try {
      await fsp.mkdir(runDir, { mode: 0o700 });
      if (process.platform !== 'win32') await fsp.chmod(runDir, 0o700);
      return { runId, runDir };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      next += 1;
    }
  }
}

/** Windows 上“文件正在删除”造成的 EPERM 重试：总预算 1 秒（protocol.md 5.2）。 */
const EPERM_RETRY_BUDGET_MS = 1000;
const EPERM_RETRY_INITIAL_DELAY_MS = 5;
const EPERM_RETRY_MAX_DELAY_MS = 50;
const EPERM_RETRY_JITTER_MS = 5;

function platformOf(options) {
  return (options && options.platform) || process.platform;
}

/**
 * 只对 Windows 上的 EPERM 重试：文件已被删除、但还有别的进程开着它时，打开、stat、link、
 * 独占创建都会得到 EPERM，要等最后一个句柄关掉（protocol.md 5.2“正在删除的文件”）。
 * 按总时长重试，默认预算 1 秒；超时仍失败时抛最后一次的原错误，并加上 attempts、elapsedMs。
 * 其他平台、其他错误码不重试。platform、timeoutMs、initialDelayMs、maxDelayMs、jitterMs 可注入，便于测试。
 */
export async function retryOnEperm(operation, options = {}) {
  const platform = platformOf(options);
  const timeoutMs = options.timeoutMs ?? EPERM_RETRY_BUDGET_MS;
  const initialDelayMs = options.initialDelayMs ?? EPERM_RETRY_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? EPERM_RETRY_MAX_DELAY_MS;
  const jitterMs = options.jitterMs ?? EPERM_RETRY_JITTER_MS;
  const startedAt = Date.now();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      return await operation();
    } catch (error) {
      if (platform !== 'win32' || !error || error.code !== 'EPERM') throw error;
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        if (typeof error === 'object') {
          error.attempts = attempts;
          error.elapsedMs = elapsedMs;
        }
        throw error;
      }
      const exponential = initialDelayMs * 2 ** (attempts - 1);
      const delay = Math.min(exponential, maxDelayMs);
      const jitter = jitterMs > 0 ? Math.random() * jitterMs : 0;
      const wait = Math.min(delay + jitter, timeoutMs - elapsedMs);
      if (wait > 0) await sleep(wait);
    }
  }
}

/**
 * 读锁：返回 { state: 'ok', lock, text } / { state: 'missing' } / { state: 'unreadable', error }。
 * 只有 ENOENT 算“没有锁”；内容不是 JSON 对象、文件正在删除（Windows 上 EPERM 重试用完）
 * 以及其他读取错误都算“读不出来”，由调用方决定怎么处理。
 */
export async function readLock(file, options = {}) {
  let text;
  try {
    text = await retryOnEperm(() => fsp.readFile(file, 'utf8'), options);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { state: 'missing' };
    return { state: 'unreadable', error };
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { state: 'unreadable', error: new Error('锁文件内容不是 JSON 对象'), text };
    }
    return { state: 'ok', lock: value, text };
  } catch (error) {
    return { state: 'unreadable', error, text };
  }
}

/** 锁文件内容读不出来时按“被占用”处理的宽限（毫秒）。 */
const LOCK_UNREADABLE_GRACE_MS = 5000;
/** 抢锁重试的总预算（毫秒）。 */
const LOCK_RETRY_BUDGET_MS = 15000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 锁文件的修改时间距今多少毫秒；文件不存在时返回 null。
 * Windows 上 EPERM 重试用完（文件正在删除）时按“刚写入”返回 0，不按不存在处理。
 */
async function lockAgeMs(file, options = {}) {
  try {
    return await retryOnEperm(async () => {
      const stat = await fsp.stat(file);
      return Math.max(0, Date.now() - stat.mtimeMs);
    }, options);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    if (error && error.code === 'EPERM' && platformOf(options) === 'win32') return 0;
    throw error;
  }
}

/** 把锁的内容写进同目录的临时文件；内容写完、fsync 之后才返回路径。 */
async function writeLockTemp(dir, payload) {
  const tmp = path.join(dir, '.active.lock.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex'));
  const handle = await fsp.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(payload, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return tmp;
}

const LOCK_LINK_FALLBACK_CODES = new Set(['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV']);

/**
 * 把临时文件链接成锁文件：link 是原子的，EEXIST 即“已被占用”，
 * 读的人不会看到空文件或写了一半的内容。文件系统不支持硬链接时退回独占复制。
 * link 和独占复制上的 EPERM 按“文件正在删除”重试；重试用完仍是 EPERM 时抛给调用方按被占用处理。
 */
async function linkLockFile(tmp, file, options = {}) {
  return retryOnEperm(async () => {
    try {
      await fsp.link(tmp, file);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      if (!LOCK_LINK_FALLBACK_CODES.has(error.code)) throw error;
      try {
        await fsp.copyFile(tmp, file, fsConstants.COPYFILE_EXCL);
        return true;
      } catch (copyError) {
        if (copyError.code === 'EEXIST') return false;
        throw copyError;
      }
    }
  }, options);
}

/** 锁目前的主人：锁里的 pid 活着就用它；否则看任务状态里的工作进程 pid（防 run start 退出、锁没来得及改写）。 */
async function lockHolderPid(home, repoId, lock) {
  if (Number.isInteger(lock.pid) && lock.pid > 0 && isPidAlive(lock.pid)) return lock.pid;
  if (typeof lock.runId === 'string' && lock.runId !== '') {
    const state = await readJson(path.join(runDirFor(home, repoId, lock.runId), 'state.json')).catch(() => null);
    const workerPid = state && state.worker ? state.worker.pid : null;
    if (Number.isInteger(workerPid) && workerPid > 0 && isPidAlive(workerPid)) return workerPid;
  }
  return null;
}

/** 锁里记录的任务处于什么状态；用于 lock_held 的 error.data。 */
async function lockStatus(home, repoId, runId) {
  if (typeof runId !== 'string') return null;
  const state = await readJson(path.join(runDirFor(home, repoId, runId), 'state.json')).catch(() => null);
  return state && typeof state.status === 'string' ? state.status : null;
}

/**
 * 抢“打破旧锁”的互斥文件；拿到返回路径，拿不到返回 null。
 * Windows 上独占创建遇到 EPERM（文件正在删除）重试用完时按没拿到处理。
 */
async function acquireBreakGuard(file, options = {}) {
  const guard = file + '.break';
  let handle;
  try {
    handle = await retryOnEperm(() => fsp.open(guard, 'wx', 0o600), options);
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const age = await lockAgeMs(guard, options);
      if (age !== null && age > LOCK_UNREADABLE_GRACE_MS) await fsp.unlink(guard).catch(() => {});
      return null;
    }
    if (error && error.code === 'EPERM' && platformOf(options) === 'win32') return null;
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ v: 1, pid: process.pid, at: new Date().toISOString() }) + '\n');
  } finally {
    await handle.close();
  }
  return guard;
}

/**
 * 删除一个确认已死的旧锁。先拿互斥文件，再重读并确认它还是刚才那份、仍然没人持有：
 * 两个进程同时判定旧锁已死时，先建好新锁的那个不会被另一个删掉。
 */
async function breakStaleLock(file, expectedText, isHeld, options = {}) {
  const guard = await acquireBreakGuard(file, options);
  if (!guard) return false;
  try {
    const current = await readLock(file, options);
    if (current.state === 'missing') return true;
    if (expectedText !== null && current.text !== expectedText) return false;
    if (current.state === 'ok' && (await isHeld(current.lock))) return false;
    if (current.state === 'unreadable') {
      const age = await lockAgeMs(file, options);
      if (age !== null && age < LOCK_UNREADABLE_GRACE_MS) return false;
    }
    try {
      await fsp.unlink(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return true;
  } finally {
    await fsp.unlink(guard).catch(() => {});
  }
}

/**
 * 拿仓库锁：先把完整内容写进临时文件，再 link 成 active.lock（EEXIST 即被占用）。
 * 锁里 pid 不存活时打破旧锁后重试；内容读不出来的锁在 5 秒宽限内按被占用处理。
 * Windows 上 EPERM 重试用完（文件正在删除）时按被占用处理：LockHeldError，error.data 为 null。
 */
export async function acquireLock({ home, repoId, runId, pid, phase = 'starting', ...options }) {
  const file = lockFileFor(home, repoId);
  await ensurePrivateDir(path.dirname(file));
  const payload = {
    v: 1,
    runId,
    pid,
    phase,
    createdAt: new Date().toISOString(),
  };
  const isHeld = async (lock) => (await lockHolderPid(home, repoId, lock)) !== null;
  const tmp = await writeLockTemp(path.dirname(file), payload);
  try {
    const deadline = Date.now() + LOCK_RETRY_BUDGET_MS;
    for (;;) {
      if (Date.now() > deadline) throw new LockHeldError('仓库锁竞争失败：' + file, null);
      let created;
      try {
        created = await linkLockFile(tmp, file, options);
      } catch (error) {
        if (error && error.code === 'EPERM' && platformOf(options) === 'win32') {
          throw new LockHeldError('仓库锁文件正在删除（EPERM），按被占用处理：' + file, null, { cause: error });
        }
        throw error;
      }
      if (created) return file;
      const observed = await readLock(file, options);
      if (observed.state === 'missing') continue;
      if (observed.state === 'unreadable') {
        const age = await lockAgeMs(file, options);
        if (age !== null && age < LOCK_UNREADABLE_GRACE_MS) {
          throw new LockHeldError('仓库锁内容不可读（' + Math.round(age) + ' ms 前写入），按被占用处理', null);
        }
      } else {
        const holder = await lockHolderPid(home, repoId, observed.lock);
        if (holder !== null) {
          const status = await lockStatus(home, repoId, observed.lock.runId);
          throw new LockHeldError(
            '本仓库已有进行中的任务 ' + String(observed.lock.runId ?? '') + '（pid ' + holder + '）',
            { runId: observed.lock.runId ?? null, status, pid: holder },
          );
        }
      }
      await breakStaleLock(file, observed.text ?? null, isHeld, options);
      await sleep(5 + Math.floor(Math.random() * 10));
    }
  } finally {
    try {
      await fsp.unlink(tmp);
    } catch {
      // 临时文件可能已经不存在。
    }
  }
}

/**
 * 改写锁的内容（run start 启动工作进程后改成工作进程的 pid）。
 * 锁的内容读不出来（不可解析、Windows 上正在删除）时报错，不写出缺字段的锁。
 * 文件已经不存在时什么都不写、返回 null：工作进程可能在 run start 改写之前就收完尾、释放了锁，
 * 这时再补一份只有补丁字段的锁会留下错误的占用记录。
 */
export async function updateLock(file, patch, options = {}) {
  const existing = await readLock(file, options);
  if (existing.state === 'missing') return null;
  if (existing.state !== 'ok') {
    throw new LockUnreadableError('仓库锁读不出来，不改写：' + file, existing.error);
  }
  const next = { ...existing.lock, ...patch, updatedAt: new Date().toISOString() };
  await writeJson(file, next);
  return next;
}

/**
 * 释放锁；只删除属于该任务的锁，避免误删别人的。
 * 锁存在但读不出来时报错，不返回 false；文件不存在时返回 false。
 */
export async function releaseLock(file, runId, options = {}) {
  const existing = await readLock(file, options);
  if (existing.state === 'missing') return false;
  if (existing.state === 'unreadable') {
    throw new LockUnreadableError('仓库锁读不出来，未释放：' + file, existing.error);
  }
  if (runId && existing.lock.runId && existing.lock.runId !== runId) return false;
  try {
    await fsp.unlink(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** 按任务号找运行目录：先看给定仓库，再在所有仓库里找；返回 { repoId, runDir } 或 { error }。 */
export async function findRun({ home, runId, repoRoot }) {
  if (repoRoot) {
    const repoId = repoIdFor(repoRoot);
    const runDir = runDirFor(home, repoId, runId);
    if (await pathExists(path.join(runDir, 'state.json'))) return { repoId, runDir };
  }
  const matches = [];
  for (const repoId of await listRepoIds(home)) {
    const runDir = runDirFor(home, repoId, runId);
    if (await pathExists(path.join(runDir, 'state.json'))) matches.push({ repoId, runDir });
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    return { error: { code: 'ambiguous_run', message: '任务号 ' + runId + ' 在多个仓库下都存在，请用 --repo 指定仓库' } };
  }
  return { error: { code: 'run_not_found', message: '找不到任务 ' + runId } };
}

async function pathExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

/** 判断任务是否处于“进行中”的状态。 */
export function isRunningStatus(status) {
  return status === 'starting' || status === 'running' || status === 'waiting_approval' || status === 'waiting_question';
}

/** 判断任务是否处于“结束”的状态（不能再续接）。 */
export function isEndedStatus(status) {
  return status === 'cancelled';
}

/** 判断任务是否已经“停下”或“结束”。 */
export function isSettledStatus(status) {
  return !isRunningStatus(status);
}
