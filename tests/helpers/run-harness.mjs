// 本文件：S3 测试的公共工具：临时仓库、临时 AGENT_COLLAB_HOME、假执行端进程和 CLI 调用。测试里统一从这里建环境，保证不碰真实的 ~/.agent-collab。

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('../..', import.meta.url));
export const binPath = path.join(rootDir, 'bin', 'collab.mjs');
export const fakeExecutorPath = path.join(rootDir, 'tests', 'fixtures', 'fake-executor.mjs');
export const fakeAdapterPath = path.join(rootDir, 'tests', 'fixtures', 'fake-adapter.mjs');

/** 跑一个进程，收集输出。 */
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

/** 在 dir 里建一个有初始提交的 git 仓库。 */
export async function initRepo(dir, env) {
  await fsp.mkdir(dir, { recursive: true });
  const git = (args) => run('git', args, { cwd: dir, env });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'test']);
  await git(['config', 'commit.gpgsign', 'false']);
  await fsp.writeFile(path.join(dir, 'README.md'), '# repo\n');
  await git(['add', '-A']);
  await git(['commit', '-qm', 'init']);
  return dir;
}

/** 每个用例一个临时根目录：repo、home 和假执行端的文件都放在里面。 */
export async function createContext(label = 'case') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-collab-s3-' + label + '-'));
  const repo = await initRepo(path.join(root, 'repo'));
  const home = path.join(root, 'home');
  await fsp.mkdir(home, { recursive: true });
  // 本用例启动过的假执行端都登记在 executors 上：用例失败时 t.after 的 cleanup 也会按 PID 结束它们，测试进程不会被 stdio 管道挂住。
  const ctx = {
    root,
    repo,
    home,
    executors: [],
    workerPids: [],
    async cleanup() {
      // 先结束工作进程，再结束假执行端，最后删临时目录。
      for (const pid of ctx.workerPids.splice(0)) await killPid(pid);
      await killLeftoverWorkers(home);
      await stopExecutors(ctx);
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
  return ctx;
}

/** 结束一个自己 spawn 的子进程（SIGKILL）；已经退出时直接返回。 */
export async function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(child.pid, 'SIGKILL');
  } catch {
    return;
  }
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 1000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** 按 PID 结束一个自己启动的进程（SIGKILL）；已经退出时忽略。 */
async function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // 进程已经退出。
  }
}

/** 结束 ctx 上登记的所有假执行端。 */
async function stopExecutors(ctx) {
  const list = (ctx.executors ?? []).splice(0);
  await Promise.all(list.map((child) => killChild(child)));
}

export async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

export async function pathExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(predicate, options = {}) {
  const timeout = options.timeout ?? 8000;
  const interval = options.interval ?? 50;
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('等待超时：' + (options.label ?? '条件未满足'));
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/** 启动假执行端，返回地址和记录文件路径。 */
export async function startFakeExecutor(ctx, script, options = {}) {
  const name = options.name ?? 'exec';
  const scriptPath = path.join(ctx.root, 'script-' + name + '.json');
  const recordPath = path.join(ctx.root, 'record-' + name + '.jsonl');
  const portFile = path.join(ctx.root, 'port-' + name + '.json');
  await fsp.writeFile(scriptPath, JSON.stringify(script, null, 2));
  await fsp.writeFile(recordPath, '');
  const child = spawn(process.execPath, [fakeExecutorPath, '--port-file', portFile, '--script', scriptPath, '--record', recordPath], {
    cwd: ctx.root,
    env: { ...process.env, TZ: 'UTC' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stdout.resume();
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  if (ctx.executors) ctx.executors.push(child);
  let port;
  try {
    // 端口文件由假执行端原子写入；这里仍然重试读，解析失败或文件还没出现都继续等，不依赖时序。
    port = await waitFor(async () => {
      try {
        const value = await readJson(portFile);
        return Number.isInteger(value.port) ? value.port : null;
      } catch {
        return null;
      }
    }, { label: '假执行端端口文件', timeout: 8000 });
  } catch (error) {
    await killChild(child);
    const index = ctx.executors ? ctx.executors.indexOf(child) : -1;
    if (index !== -1) ctx.executors.splice(index, 1);
    error.message += stderr.length > 0 ? '（假执行端错误：' + Buffer.concat(stderr).toString('utf8').trim() + '）' : '';
    throw error;
  }
  return {
    address: '127.0.0.1:' + port,
    recordPath,
    scriptPath,
    child,
    stderr,
    async stop() {
      const index = ctx.executors ? ctx.executors.indexOf(child) : -1;
      if (index !== -1) ctx.executors.splice(index, 1);
      await killChild(child);
    },
  };
}

/** 调用 bin/collab.mjs；env 里默认带上临时 AGENT_COLLAB_HOME、假适配器和假执行端地址。 */
export async function runCli(ctx, argv, options = {}) {
  const env = {
    ...process.env,
    TZ: 'UTC',
    AGENT_COLLAB_HOME: ctx.home,
    AGENT_COLLAB_TEST_ADAPTER: fakeAdapterPath,
    ...options.env,
  };
  if (options.executor) env.AGENT_COLLAB_FAKE_EXECUTOR = options.executor.address;
  const result = await run(process.execPath, [binPath, ...argv], { cwd: options.cwd ?? ctx.repo, env });
  const parsed = parseJsonOutput(result.stdout);
  // run start / run resume 会返回工作进程 pid：登记下来，用例失败时 cleanup 也能按 PID 结束它。
  if (parsed && Number.isInteger(parsed.workerPid)) ctx.workerPids.push(parsed.workerPid);
  return { ...result, json: parsed };
}

export function parseJsonOutput(stdout) {
  const lines = String(stdout ?? '').split('\n').filter((line) => line.trim() !== '');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      continue;
    }
  }
  return null;
}

/** 读 fake-executor 的记录文件。 */
export async function readRecord(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** 读 events.jsonl。 */
export async function readEvents(runDir) {
  try {
    const raw = await fsp.readFile(path.join(runDir, 'events.jsonl'), 'utf8');
    return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** 结束本用例启动过的所有工作进程（按 state.json 里的 pid，只杀自己 spawn 的）。 */
export async function killLeftoverWorkers(home) {
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
      const stateFile = path.join(runsDir, repoId, runId, 'state.json');
      const state = await readJson(stateFile).catch(() => null);
      const pid = state?.worker?.pid;
      if (!Number.isInteger(pid)) continue;
      try {
        process.kill(pid, 0);
      } catch {
        continue;
      }
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已经退出。
      }
    }
  }
}

/** 判断 PID 是否存活。 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** 等 PID 退出。 */
export async function waitPidGone(pid, timeout = 5000) {
  return waitFor(() => !pidAlive(pid), { timeout, label: '进程 ' + pid + ' 退出' });
}

/** 一份最小合法汇报。 */
export function makeReport(overrides = {}) {
  return {
    status: 'done',
    summary: '做完了',
    criteria: [{ id: 'AC1', met: true, evidence: '测试通过' }],
    commands: [{ command: 'npm test', exit_code: 0, result: '通过' }],
    files_changed: ['src/a.js'],
    deviations: [],
    blocked_checks: [],
    open_questions: [],
    human_inputs: [],
    ...overrides,
  };
}

/** 把汇报对象包成执行端的最后一条回复（唯一 json 代码块）。 */
export function reportText(report) {
  return ['做完了。', '', FENCE + 'json', JSON.stringify(report, null, 2), FENCE].join('\n');
}

const FENCE = String.fromCharCode(96).repeat(3);

/** 一轮执行端的脚本：产生一个文本事件，然后以给定的汇报结束。 */
export function turnWithReport(report, options = {}) {
  return {
    steps: options.steps ?? [{ kind: 'event', event: { type: 'text', text: '先说明一下' } }],
    end: {
      stopReason: options.stopReason ?? 'end_turn',
      endReason: options.endReason ?? null,
      stoppedBy: options.stoppedBy ?? null,
      finalText: options.finalText ?? reportText(report),
    },
  };
}
