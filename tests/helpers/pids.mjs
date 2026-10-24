// 本文件：测试清理时结束进程的规则：只结束还应该活着的进程，避免 PID 已被复用时误杀别的测试进程。只给测试使用。

import fsp from 'node:fs/promises';
import path from 'node:path';

import { isRunningStatus } from '../../core/rundir.mjs';

/** 默认用 process.kill 发信号；测试里可以注入一个只记录调用的函数。 */
export function defaultKill(pid, signal) {
  return process.kill(pid, signal);
}

/** PID 是否存活：信号 0 只做检查，不结束进程。 */
export function pidAlive(pid, kill = defaultKill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** 自己 spawn、手里有 ChildProcess 句柄的进程：只在句柄的 exitCode、signalCode 都为 null 时结束。 */
export async function killChild(child, options = {}) {
  const kill = options.kill ?? defaultKill;
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  if (!Number.isInteger(child.pid) || child.pid <= 0) return false;
  try {
    kill(child.pid, options.signal ?? 'SIGKILL');
  } catch {
    return false;
  }
  if (typeof child.once !== 'function') return true;
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 1000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return true;
}

/** 任务是否还在进行中：只有这几种状态的工作进程才应该还活着。 */
export function isActiveTaskStatus(status) {
  return isRunningStatus(status);
}

/**
 * 运行时 spawn 的工作进程（测试手里只有 PID）：只在任务仍在进行中、state.json 里的 worker.pid 就是这个 PID、
 * 且 PID 存活时才结束。已经停下或结束的任务，工作进程按契约会自己退出，不结束它。
 */
export function killWorkerIfActive(state, options = {}) {
  const kill = options.kill ?? defaultKill;
  const pid = options.pid ?? (state && state.worker ? state.worker.pid : undefined);
  if (!state || !Number.isInteger(pid) || pid <= 0) return false;
  if (!state.worker || state.worker.pid !== pid) return false;
  if (!isActiveTaskStatus(state.status)) return false;
  if (!pidAlive(pid, kill)) return false;
  try {
    kill(pid, options.signal ?? 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/** 结束 home 下所有仍在进行中的任务的工作进程（逐个按 state.json 的 status 和 worker.pid 判断）。 */
export async function killActiveWorkers(home, options = {}) {
  const runsDir = path.join(home, 'runs');
  let repos = [];
  try {
    repos = await fsp.readdir(runsDir);
  } catch {
    return;
  }
  for (const repoId of repos) {
    let runs = [];
    try {
      runs = await fsp.readdir(path.join(runsDir, repoId));
    } catch {
      continue;
    }
    for (const runId of runs) {
      if (!/^T\d+$/.test(runId)) continue;
      let state = null;
      try {
        state = JSON.parse(await fsp.readFile(path.join(runsDir, repoId, runId, 'state.json'), 'utf8'));
      } catch {
        continue;
      }
      killWorkerIfActive(state, options);
    }
  }
}

/** 等 PID 退出；只等不杀，超时返回 false。 */
export async function waitForPidGone(pid, timeoutMs = 5000, options = {}) {
  const kill = options.kill ?? defaultKill;
  if (!Number.isInteger(pid) || pid <= 0) return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!pidAlive(pid, kill)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
}

/**
 * 自动启动或测试启动的假 dsh Web（手里只有发现文件里的 PID）：只在发现文件还在、且 PID 存活时才结束。
 * 假 dsh Web 正常退出时会删掉自己写的发现文件，所以“文件在”才说明它大概率还活着。
 *
 * Windows 上 process.kill(pid, 'SIGTERM') 是直接结束进程（TerminateProcess），假 Web 的退出处理
 * 和 'exit' 钩子都不会运行，发现文件会留下来。所以确认进程退出之后由这里删掉发现文件：
 * 这样“文件在”仍然说明它大概率还活着（RISKS.md R11），也不会按陈旧的发现文件去结束别人的进程。
 * 注入 kill 的单元测试没有真实进程，也不涉及文件系统，跳过等待和删除。
 */
export async function stopWebFromDiscovery(file, options = {}) {
  const readFile = options.readFile ?? ((target) => fsp.readFile(target, 'utf8'));
  const kill = options.kill ?? defaultKill;
  const manageDiscoveryFile = !options.kill;
  let record;
  try {
    record = JSON.parse(await readFile(file));
  } catch {
    return false;
  }
  const pid = record && record.pid;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // 用例会自己写发现文件来模拟各种情形（例如 doctor 用 pid: process.pid 冒充“活着的 Web”），
  // 测试进程自己永远不结束。
  if (pid === process.pid) return false;
  if (!pidAlive(pid, kill)) {
    // 进程已经不在：这是一份陈旧的发现文件，删掉，免得后面的清理按旧 PID 判断。
    if (manageDiscoveryFile) await removeFile(file);
    return false;
  }
  try {
    kill(pid, options.signal ?? 'SIGTERM');
  } catch {
    return false;
  }
  if (manageDiscoveryFile) {
    const gone = await waitForPidGone(pid, options.timeoutMs ?? 5000);
    if (gone) await removeFile(file);
  }
  return true;
}

async function removeFile(file) {
  try {
    await fsp.rm(file, { force: true });
  } catch {
    // 删不掉时留给下一次清理；这里不抛错。
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 等这次用例启动过的工作进程退出：读 state.json 里的 worker.pid 和 worker.log 里最后一条
 * “工作进程启动，pid N”。只等不杀（已经停下或结束的任务，工作进程按契约会自己退出），有上限。
 * 返回还在运行、等到超时的 PID 列表（为空表示都退出了）。
 */
export async function waitWorkersGone(home, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const kill = options.kill ?? defaultKill;
  const pids = [];
  const runsDir = path.join(home, 'runs');
  let repos = [];
  try {
    repos = await fsp.readdir(runsDir);
  } catch {
    return [];
  }
  for (const repoId of repos) {
    let runs = [];
    try {
      runs = await fsp.readdir(path.join(runsDir, repoId));
    } catch {
      continue;
    }
    for (const runId of runs) {
      if (!/^T\d+$/.test(runId)) continue;
      const runDir = path.join(runsDir, repoId, runId);
      try {
        const state = JSON.parse(await fsp.readFile(path.join(runDir, 'state.json'), 'utf8'));
        if (state && state.worker && Number.isInteger(state.worker.pid)) pids.push(state.worker.pid);
      } catch {
        // state.json 读不出来时只能看日志。
      }
      try {
        const log = await fsp.readFile(path.join(runDir, 'worker.log'), 'utf8');
        const matches = [...log.matchAll(/工作进程启动，pid (\d+)/g)];
        if (matches.length > 0) pids.push(Number(matches[matches.length - 1][1]));
      } catch {
        // 没有 worker.log。
      }
    }
  }
  const waiting = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const alive = waiting.filter((pid) => pidAlive(pid, kill));
    if (alive.length === 0) return [];
    if (Date.now() >= deadline) return alive;
    await sleep(50);
  }
}
