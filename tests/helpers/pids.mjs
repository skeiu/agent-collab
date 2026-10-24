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

/**
 * 自动启动或测试启动的假 dsh Web（手里只有发现文件里的 PID）：只在发现文件还在、且 PID 存活时才结束。
 * 假 dsh Web 正常退出时会删掉自己写的发现文件，所以“文件在”才说明它大概率还活着。
 */
export async function stopWebFromDiscovery(file, options = {}) {
  const readFile = options.readFile ?? ((target) => fsp.readFile(target, 'utf8'));
  const kill = options.kill ?? defaultKill;
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
  if (!pidAlive(pid, kill)) return false;
  try {
    kill(pid, options.signal ?? 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}
