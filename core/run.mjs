// 本文件：run 子命令和工作进程的入口（D20、D21、D23；docs/protocol.md 第 5、6 节）：start 立刻返回任务号、wait/status/resume/cancel 读写运行目录。命令行或运行目录规则变化时更新。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.mjs';
import { buildAdapterOptions, assertAdapterAvailable } from './executor.mjs';
import { changesBetween, checkViolations, findRepoRoot, snapshotWorktree } from './git.mjs';
import { EventLog, buildSummary } from './events.mjs';
import { isPidAlive, resolveAgentCollabHome, writePrivateFile } from './platform.mjs';
import {
  LockHeldError,
  acquireLock,
  allocateRunDir,
  findRun,
  isEndedStatus,
  isRunningStatus,
  isSettledStatus,
  listRepoIds,
  listRunIds,
  lockFileFor,
  readJson,
  readLock,
  releaseLock,
  repoIdFor,
  runDirFor,
  updateLock,
  writeJson,
} from './rundir.mjs';

const runFile = fileURLToPath(import.meta.url);
const WORKER_FLAG = '--worker';

/** 命令行错误：带 error.code 和退出码。 */
export class CliError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'CliError';
    this.code = options.code ?? 'error';
    this.exitCode = options.exitCode ?? 1;
    this.data = options.data ?? null;
    if (options.cause) this.cause = options.cause;
  }
}

function usageError(message) {
  return new CliError(message, { code: 'usage', exitCode: 2 });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envNumber(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function defaultIo() {
  return {
    out(value) {
      process.stdout.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value) + '\n');
    },
    err(line) {
      process.stderr.write(String(line) + '\n');
    },
  };
}

/** 解析 --name value / --name=value / --flag。spec: { name: {type: 'string'|'boolean', multiple} }。 */
export function parseArgs(argv, spec) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      options._.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }
    let name = arg.slice(2);
    let value = null;
    const equals = name.indexOf('=');
    if (equals !== -1) {
      value = name.slice(equals + 1);
      name = name.slice(0, equals);
    }
    const definition = spec[name];
    if (!definition) throw usageError('未知参数 --' + name);
    if (definition.type === 'boolean') {
      options[name] = true;
      continue;
    }
    if (value === null) {
      index += 1;
      value = argv[index];
      if (value === undefined) throw usageError('--' + name + ' 缺少值');
    }
    if (definition.multiple) {
      if (!Array.isArray(options[name])) options[name] = [];
      options[name].push(value);
    } else {
      options[name] = value;
    }
  }
  return options;
}

/** 把 a.b.c=v 写进对象。 */
function setPath(target, keyPath, value) {
  const parts = String(keyPath).split('.').filter(Boolean);
  if (parts.length === 0) throw usageError('--set 的键不能为空');
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
  return target;
}

function parseSets(list) {
  const task = {};
  for (const item of list ?? []) {
    const equals = item.indexOf('=');
    if (equals === -1) throw usageError('--set 需要“键=JSON 值”的形式：' + item);
    const key = item.slice(0, equals).trim();
    const raw = item.slice(equals + 1);
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    setPath(task, key, value);
  }
  return task;
}

function assertNotExecutor(env) {
  if (env.AGENT_COLLAB_ROLE === 'executor' || env.DSH_AGENT_COLLAB_ROLE === 'executor') {
    throw new CliError('当前进程是执行端（AGENT_COLLAB_ROLE 或 DSH_AGENT_COLLAB_ROLE 为 executor），不能再派发任务', {
      code: 'executor_role',
      exitCode: 3,
    });
  }
}

/** 启动工作进程：detached + unref，标准输出和错误写进 worker.log；Windows 上加 windowsHide。 */
export function spawnWorker(runDir) {
  const logFile = path.join(runDir, 'worker.log');
  const fd = fs.openSync(logFile, 'a', 0o600);
  try {
    const child = spawn(process.execPath, [runFile, WORKER_FLAG, runDir], {
      cwd: runDir,
      env: process.env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    return child;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 已经关闭。
    }
  }
}

/** 找任务：先看当前仓库，再在所有仓库里找同名任务号。 */
export async function locateRun({ home, runId, repoRoot }) {
  const found = await findRun({ home, runId, repoRoot });
  if (!found.error) return found;
  const exitCode = found.error.code === 'run_not_found' ? 4 : 1;
  throw new CliError(found.error.message, { code: found.error.code, exitCode });
}

async function resolveRepoRoot(options, cwd) {
  const dir = options.repo ? path.resolve(cwd, options.repo) : cwd;
  return findRepoRoot(dir);
}

async function cmdStart(argv, io, context) {
  const options = parseArgs(argv, {
    brief: { type: 'string' },
    title: { type: 'string' },
    designer: { type: 'string' },
    'designer-model': { type: 'string' },
    executor: { type: 'string' },
    protected: { type: 'string', multiple: true },
    image: { type: 'string', multiple: true },
    set: { type: 'string', multiple: true },
    repo: { type: 'string' },
  });
  const env = context.env ?? process.env;
  const cwd = context.cwd ?? process.cwd();
  assertNotExecutor(env);
  if (!options.brief) throw usageError('run start 需要 --brief <文件>');

  const repoRoot = await resolveRepoRoot(options, cwd);
  if (!repoRoot) throw new CliError('当前目录不是 git 仓库', { code: 'not_git', exitCode: 3 });

  const taskConfig = parseSets(options.set);
  const { config, errors: configErrors } = await loadConfig({ repoDir: repoRoot, taskConfig, env });
  const designer = options.designer ?? null;
  let executorName = options.executor ?? null;
  if (!executorName && designer) executorName = config.executorByDesigner?.[designer] ?? null;
  if (!executorName) {
    throw usageError('必须指定 --executor，或者用 --designer 指定设计端后由配置决定执行端');
  }
  await assertAdapterAvailable(executorName, env);

  const briefPath = path.resolve(cwd, options.brief);
  let brief;
  try {
    brief = await fsp.readFile(briefPath, 'utf8');
  } catch (error) {
    throw new CliError('读不到任务书文件：' + briefPath, { code: 'brief_unreadable', exitCode: 1, cause: error });
  }
  const images = (options.image ?? []).map((item) => path.resolve(cwd, item));
  const protectedPaths = [...new Set([...(config.protectedPaths ?? []), ...(options.protected ?? [])])];

  const home = await resolveHome(env, context);
  const repoId = repoIdFor(repoRoot);
  const lockFile = lockFileFor(home, repoId);
  await acquireLock({ home, repoId, runId: null, pid: process.pid, phase: 'starting' });

  let runId = null;
  let runDir = null;
  try {
    const allocated = await allocateRunDir(home, repoId);
    runId = allocated.runId;
    runDir = allocated.runDir;
    await updateLock(lockFile, { runId, phase: 'starting' });

    const createdAt = nowIso();
    await writePrivateFile(path.join(runDir, 'brief.md'), brief);
    const snapshot = await snapshotWorktree(repoRoot);
    const baseline = { v: 1, tree: snapshot.tree, head: snapshot.head, branch: snapshot.branch, createdAt };
    await writeJson(path.join(runDir, 'baseline.json'), baseline);

    const optionsForAdapter = buildAdapterOptions(config, executorName);
    const state = {
      v: 1,
      runId,
      repoRoot,
      repoId,
      status: 'starting',
      statusReason: null,
      turn: 1,
      turnKind: 'brief',
      turnKinds: { 1: 'brief' },
      counts: { correction: 0, answer: 0, resend: 0 },
      designer: { name: designer, model: options['designer-model'] ?? null },
      executor: {
        name: executorName,
        transport: null,
        sessionId: null,
        model: null,
        agentPreset: optionsForAdapter.agentPreset ?? null,
      },
      worker: null,
      cursor: null,
      lastEventN: 0,
      lastActivityAt: createdAt,
      waiting: { approvals: [], questions: [] },
      protectedPaths,
      title: options.title ?? null,
      images,
      taskConfig,
      createdAt,
      updatedAt: createdAt,
      endedAt: null,
    };
    await writeJson(path.join(runDir, 'state.json'), state);

    const child = spawnWorker(runDir);
    state.worker = { pid: child.pid ?? null, startedAt: nowIso() };
    state.updatedAt = nowIso();
    await writeJson(path.join(runDir, 'state.json'), state);
    await updateLock(lockFile, { pid: child.pid ?? null, phase: 'worker' });

    for (const warning of configErrors ?? []) {
      io.err('配置提示：' + (warning.message ?? String(warning)));
    }
    io.out({ ok: true, runId, runDir, status: 'starting', workerPid: child.pid ?? null });
    return 0;
  } catch (error) {
    await releaseLock(lockFile, runId);
    if (runDir) {
      try {
        await fsp.rm(runDir, { recursive: true, force: true });
      } catch {
        // 清理失败不影响错误上报。
      }
    }
    throw error;
  }
}

async function resolveHome(env, context) {
  if (context.home) return context.home;
  return resolveAgentCollabHome(env);
}

async function cmdWait(argv, io, context) {
  const options = parseArgs(argv, { timeout: { type: 'string' }, repo: { type: 'string' } });
  const env = context.env ?? process.env;
  const cwd = context.cwd ?? process.cwd();
  const runId = options._[0];
  if (!runId) throw usageError('run wait 需要任务号');
  const home = await resolveHome(env, context);
  const repoRoot = await resolveRepoRoot(options, cwd);
  const { runDir } = await locateRun({ home, runId, repoRoot });
  const statePath = path.join(runDir, 'state.json');
  const timeoutMs = options.timeout ? Number(options.timeout) * 1000 : null;
  if (options.timeout !== undefined && !Number.isFinite(timeoutMs)) throw usageError('--timeout 需要秒数');
  const deadline = timeoutMs === null ? Infinity : Date.now() + timeoutMs;
  const pollMs = envNumber(env, 'AGENT_COLLAB_TEST_WAIT_POLL_MS', 200);
  const attachGraceMs = envNumber(env, 'AGENT_COLLAB_TEST_ATTACH_GRACE_MS', 1500);
  let lastSpawnAt = Date.now();
  let pendingSpawnPid = null;
  let lastWorkerPid = null;

  for (;;) {
    const state = await readJson(statePath);
    if (!state) throw new CliError('找不到任务 ' + runId, { code: 'run_not_found', exitCode: 4 });
    if (state.worker && Number.isInteger(state.worker.pid)) lastWorkerPid = state.worker.pid;
    if (isSettledStatus(state.status)) {
      // 等工作进程真正退出：这时 summary.json 已经写完，调用方不会看到半成品，也不会留下后台进程。
      await waitForPidExit(state.worker?.pid ?? lastWorkerPid, 3000);
      return finishWait(io, runDir, state);
    }
    const workerAlive = Boolean(state.worker && isPidAlive(state.worker.pid));
    const spawnPending = Boolean(pendingSpawnPid && isPidAlive(pendingSpawnPid));
    if (!workerAlive && !spawnPending && Date.now() - lastSpawnAt > attachGraceMs) {
      lastSpawnAt = Date.now();
      const child = spawnWorker(runDir);
      pendingSpawnPid = child.pid ?? null;
      // 让新工作进程先写好自己的 pid，避免同一次 wait 里重复启动。
      await sleep(Math.min(pollMs, 50));
    }
    if (Date.now() >= deadline) {
      io.out({ ok: true, runId, status: state.status, timedOut: true });
      return 0;
    }
    await sleep(pollMs);
  }
}

function lastTurnFiles(runDir, turn) {
  const result = { summaryFile: path.join(runDir, 'summary.json'), patchFile: null, reportFile: null };
  if (Number.isInteger(turn) && turn > 0) {
    const patch = path.join(runDir, 'patch-' + turn + '.diff');
    const report = path.join(runDir, 'report-' + turn + '.json');
    result.patchFile = fs.existsSync(patch) ? patch : null;
    result.reportFile = fs.existsSync(report) ? report : null;
  }
  return result;
}

function finishWait(io, runDir, state) {
  const files = lastTurnFiles(runDir, Number(state.turn) || 0);
  io.out({
    ok: true,
    runId: state.runId,
    status: state.status,
    statusReason: state.statusReason ?? null,
    summaryFile: files.summaryFile,
    patchFile: files.patchFile,
    reportFile: files.reportFile,
  });
  return 0;
}

async function cmdStatus(argv, io, context) {
  const options = parseArgs(argv, { all: { type: 'boolean' }, repo: { type: 'string' } });
  const env = context.env ?? process.env;
  const cwd = context.cwd ?? process.cwd();
  const home = await resolveHome(env, context);
  const runId = options._[0];
  if (runId) {
    const repoRoot = await resolveRepoRoot(options, cwd);
    const { runDir } = await locateRun({ home, runId, repoRoot });
    const state = await readJson(path.join(runDir, 'state.json'));
    if (!state) throw new CliError('找不到任务 ' + runId, { code: 'run_not_found', exitCode: 4 });
    io.out({ ok: true, run: state, workerAlive: Boolean(state.worker && isPidAlive(state.worker.pid)) });
    return 0;
  }
  const repoIds = options.all ? await listRepoIds(home) : [];
  if (!options.all) {
    const repoRoot = await resolveRepoRoot(options, cwd);
    if (repoRoot) repoIds.push(repoIdFor(repoRoot));
  }
  const runs = [];
  for (const repoId of repoIds) {
    for (const id of await listRunIds(home, repoId)) {
      const runDir = runDirFor(home, repoId, id);
      const state = await readJson(path.join(runDir, 'state.json'));
      if (!state) continue;
      if (isEndedStatus(state.status)) continue;
      runs.push({
        runId: state.runId ?? id,
        repoRoot: state.repoRoot ?? null,
        status: state.status ?? null,
        turn: state.turn ?? null,
        updatedAt: state.updatedAt ?? null,
        workerAlive: Boolean(state.worker && isPidAlive(state.worker.pid)),
      });
    }
  }
  io.out({ ok: true, runs });
  return 0;
}

async function cmdResume(argv, io, context) {
  const options = parseArgs(argv, {
    message: { type: 'string' },
    kind: { type: 'string' },
    repo: { type: 'string' },
  });
  const env = context.env ?? process.env;
  const cwd = context.cwd ?? process.cwd();
  assertNotExecutor(env);
  const runId = options._[0];
  if (!runId) throw usageError('run resume 需要任务号');
  const kind = options.kind;
  if (kind !== 'correction' && kind !== 'answer') throw usageError('run resume 需要 --kind correction|answer');
  if (!options.message) throw usageError('run resume 需要 --message <文件>');
  const home = await resolveHome(env, context);
  const repoRoot = await resolveRepoRoot(options, cwd);
  const located = await locateRun({ home, runId, repoRoot });
  const runDir = located.runDir;
  const state = await readJson(path.join(runDir, 'state.json'));
  if (!state) throw new CliError('找不到任务 ' + runId, { code: 'run_not_found', exitCode: 4 });
  if (isRunningStatus(state.status) || isEndedStatus(state.status)) {
    throw new CliError('任务当前状态为 ' + state.status + '，不能续接', { code: 'not_resumable', exitCode: 3 });
  }
  const { config } = await loadConfig({ repoDir: state.repoRoot, taskConfig: state.taskConfig ?? {}, env });
  const counts = state.counts ?? { correction: 0, answer: 0, resend: 0 };
  const limit = Number(config.maxCorrectionRounds ?? 2);
  if ((counts[kind] ?? 0) >= limit) {
    throw new CliError(kind === 'correction' ? '返工轮次已到上限 ' + limit : '答复轮次已到上限 ' + limit, {
      code: 'round_limit',
      exitCode: 3,
    });
  }
  const messagePath = path.resolve(cwd, options.message);
  let message;
  try {
    message = await fsp.readFile(messagePath, 'utf8');
  } catch (error) {
    throw new CliError('读不到续接消息文件：' + messagePath, { code: 'message_unreadable', exitCode: 1, cause: error });
  }

  const lockFile = lockFileFor(home, located.repoId);
  await acquireLock({ home, repoId: located.repoId, runId, pid: process.pid, phase: 'starting' });
  const turn = (Number(state.turn) || 1) + 1;
  try {
    await writePrivateFile(path.join(runDir, 'prompt-' + turn + '.md'), message);
    state.turn = turn;
    state.turnKind = kind;
    state.turnKinds = { ...(state.turnKinds ?? {}), [turn]: kind };
    state.counts = { correction: 0, answer: 0, resend: 0, ...counts, [kind]: (counts[kind] ?? 0) + 1 };
    state.status = 'starting';
    state.statusReason = null;
    state.endedAt = null;
    state.worker = null;
    state.updatedAt = nowIso();
    await writeJson(path.join(runDir, 'state.json'), state);
    const child = spawnWorker(runDir);
    state.worker = { pid: child.pid ?? null, startedAt: nowIso() };
    state.updatedAt = nowIso();
    await writeJson(path.join(runDir, 'state.json'), state);
    await updateLock(lockFile, { pid: child.pid ?? null, phase: 'worker' });
    io.out({ ok: true, runId, turn, status: 'starting', workerPid: child.pid ?? null });
    return 0;
  } catch (error) {
    await releaseLock(lockFile, runId);
    throw error;
  }
}

/** 等一个进程退出；最多等 timeoutMs。 */
async function waitForPidExit(pid, timeoutMs) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) await sleep(25);
}

/** 用基线和工作区快照重算 changes 和 violations（工作进程没来得及写 summary 时用）。 */
async function computeChangesFromBaseline(state, runDir) {
  try {
    const baseline = await readJson(path.join(runDir, 'baseline.json'));
    if (!baseline) return { changes: null, violations: [] };
    const snapshot = await snapshotWorktree(state.repoRoot);
    const diff = await changesBetween(state.repoRoot, baseline.tree, snapshot.tree);
    const violations = await checkViolations({
      repoRoot: state.repoRoot,
      baseline,
      currentTree: snapshot.tree,
      protectedPaths: state.protectedPaths ?? [],
    });
    return { changes: { files: diff.files, stat: diff.stat }, violations };
  } catch {
    return { changes: null, violations: [] };
  }
}

/**
 * 对已经停下的任务取消（protocol.md 第 6 节 run cancel）：不结束任何进程，
 * state.json 和 summary.json 只改 status、statusReason、endedAt，其余字段保持不变。
 */
async function cancelSettledRun({ home, repoId, runDir, runId, statePath, previousStatus, workerPid }) {
  await waitForPidExit(workerPid, 5000);
  const state = await readJson(statePath);
  if (!state) throw new CliError('找不到任务 ' + runId, { code: 'run_not_found', exitCode: 4 });
  if (state.status === 'cancelled') return;
  const summaryPath = path.join(runDir, 'summary.json');
  let summary = await readJson(summaryPath).catch(() => null);
  if (!summary) {
    // 工作进程刚设完状态就退出、还没写 summary：按现有事件补一份，别让取消丢掉原来的结果。
    const events = await EventLog.open(path.join(runDir, 'events.jsonl'));
    const computed = await computeChangesFromBaseline(state, runDir);
    summary = await buildSummary({
      runDir,
      events: events.events,
      state,
      changes: computed.changes,
      violations: computed.violations,
      endedAt: state.endedAt ?? nowIso(),
    });
  }
  const endedAt = nowIso();
  const statusReason = '设计端取消；取消前为 ' + String(previousStatus ?? state.status);
  state.status = 'cancelled';
  state.statusReason = statusReason;
  state.endedAt = endedAt;
  await writeJson(statePath, state);
  summary.status = 'cancelled';
  summary.statusReason = statusReason;
  summary.endedAt = endedAt;
  await writeJson(summaryPath, summary);
  const lockFile = lockFileFor(home, repoId);
  const lock = await readLock(lockFile);
  if (lock && lock.runId === runId) await releaseLock(lockFile, runId);
}

async function cmdCancel(argv, io, context) {
  const options = parseArgs(argv, { repo: { type: 'string' } });
  const env = context.env ?? process.env;
  const cwd = context.cwd ?? process.cwd();
  const runId = options._[0];
  if (!runId) throw usageError('run cancel 需要任务号');
  const home = await resolveHome(env, context);
  const repoRoot = await resolveRepoRoot(options, cwd);
  const located = await locateRun({ home, runId, repoRoot });
  const runDir = located.runDir;
  const statePath = path.join(runDir, 'state.json');
  const summaryPath = path.join(runDir, 'summary.json');
  let state = await readJson(statePath);
  if (!state) throw new CliError('找不到任务 ' + runId, { code: 'run_not_found', exitCode: 4 });
  if (state.status === 'cancelled') {
    io.out({ ok: true, runId, status: 'cancelled' });
    return 0;
  }
  if (!isRunningStatus(state.status)) {
    // 任务已经停下：不需要工作进程，也不联系执行端。
    await cancelSettledRun({
      home,
      repoId: located.repoId,
      runDir,
      runId,
      statePath,
      previousStatus: state.status,
      workerPid: state.worker?.pid ?? null,
    });
    io.out({ ok: true, runId, status: 'cancelled' });
    return 0;
  }

  const workerPid = state.worker?.pid ?? null;
  await writeJson(path.join(runDir, 'cancel.request'), { v: 1, at: nowIso() });
  const timeoutMs = envNumber(env, 'AGENT_COLLAB_TEST_CANCEL_TIMEOUT_MS', 10000);
  const pollMs = envNumber(env, 'AGENT_COLLAB_TEST_CANCEL_POLL_MS', 100);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    state = (await readJson(statePath)) ?? state;
    if (state.status === 'cancelled') {
      await waitForPidExit(state.worker?.pid ?? workerPid, 3000);
      io.out({ ok: true, runId, status: 'cancelled' });
      return 0;
    }
    if (isSettledStatus(state.status)) {
      // 等待期间任务自己停下了（例如执行端刚好以 done 结束）：不结束任何进程，按“对停下的任务取消”处理。
      await cancelSettledRun({
        home,
        repoId: located.repoId,
        runDir,
        runId,
        statePath,
        previousStatus: state.status,
        workerPid: state.worker?.pid ?? workerPid,
      });
      io.out({ ok: true, runId, status: 'cancelled' });
      return 0;
    }
    await sleep(pollMs);
  }

  // 工作进程不响应：按 PID 结束它，自己收尾。
  const pid = state?.worker?.pid ?? workerPid;
  if (pid && isPidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // 进程可能已经退出。
    }
    const killDeadline = Date.now() + envNumber(env, 'AGENT_COLLAB_TEST_KILL_GRACE_MS', 2000);
    while (Date.now() < killDeadline && isPidAlive(pid)) await sleep(50);
    if (isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已经退出。
      }
    }
  }
  state = (await readJson(statePath)) ?? state;
  const endedAt = nowIso();
  state.status = 'cancelled';
  state.statusReason = '工作进程未响应，按 PID 结束';
  state.endedAt = endedAt;
  state.worker = null;
  state.updatedAt = endedAt;
  await writeJson(statePath, state);
  // changes、violations 按工作进程的算法对基线重算，不写空值。
  const computed = await computeChangesFromBaseline(state, runDir);
  const events = await EventLog.open(path.join(runDir, 'events.jsonl'));
  const summary = await buildSummary({
    runDir,
    events: events.events,
    state,
    changes: computed.changes,
    violations: computed.violations,
    endedAt,
  });
  await writeJson(summaryPath, summary);
  await releaseLock(lockFileFor(home, located.repoId), runId);
  io.out({ ok: true, runId, status: 'cancelled' });
  return 0;
}

const COMMANDS = {
  start: cmdStart,
  wait: cmdWait,
  status: cmdStatus,
  resume: cmdResume,
  cancel: cmdCancel,
};

function reportError(error, io) {
  if (error instanceof LockHeldError) {
    io.out({ ok: false, error: { code: error.code, message: error.message, data: error.data } });
    return 3;
  }
  const code = error && error.code && typeof error.code === 'string' ? error.code : 'error';
  const exitCode = error && Number.isInteger(error.exitCode) ? error.exitCode : 1;
  const payload = { ok: false, error: { code, message: error && error.message ? error.message : String(error) } };
  if (error && error.data) payload.error.data = error.data;
  io.out(payload);
  return exitCode;
}

/** run 子命令入口；返回进程退出码。 */
export async function runCommands(argv, io = defaultIo(), context = {}) {
  const [sub, ...rest] = argv;
  const handler = COMMANDS[sub];
  if (!handler) {
    io.out({ ok: false, error: { code: 'usage', message: '用法：collab run <start|wait|status|resume|cancel> …' } });
    return 2;
  }
  try {
    return await handler(rest, io, context);
  } catch (error) {
    if (error instanceof CliError || (error && error.code)) return reportError(error, io);
    io.err(error && error.stack ? error.stack : String(error));
    return reportError(error, io);
  }
}

/** 工作进程入口。 */
export async function runWorkerEntry(runDir) {
  const { runWorker } = await import('./worker.mjs');
  return runWorker({ runDir });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(runFile);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv[0] === WORKER_FLAG) {
    runWorkerEntry(argv[1])
      .then((code) => {
        process.exitCode = code ?? 0;
      })
      .catch((error) => {
        process.stderr.write((error && error.stack ? error.stack : String(error)) + '\n');
        process.exitCode = 1;
      });
  } else {
    runCommands(argv)
      .then((code) => {
        process.exitCode = code;
      })
      .catch((error) => {
        process.stderr.write((error && error.stack ? error.stack : String(error)) + '\n');
        process.exitCode = 1;
      });
  }
}

export { isSettledStatus, listRunIds, runDirFor };
