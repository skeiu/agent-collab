// 本文件：dsh 适配器测试的公共环境：临时仓库、AGENT_COLLAB_HOME、DSH_HOME、假 dsh 安装和假桥接 Web。只给单元测试使用。

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installFakeDsh } from './fake-dsh-install.mjs';
import { killActiveWorkers, killChild, stopWebFromDiscovery, waitWorkersGone } from './pids.mjs';

export { assertExit } from './assert-exit.mjs';

const exec = promisify(execFile);
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const binPath = path.join(repoRoot, 'bin', 'collab.mjs');

export function reportObject(overrides = {}) {
  return {
    status: 'done',
    summary: '做完了',
    criteria: [{ id: 'AC1', met: true, evidence: '测试通过' }],
    commands: [{ command: 'true', exit_code: 0, result: '通过' }],
    files_changed: [],
    deviations: [],
    blocked_checks: [],
    open_questions: [],
    human_inputs: [],
    ...overrides,
  };
}

export function reportText(report = reportObject()) {
  return '完成。\n\n' + String.fromCharCode(96).repeat(3) + 'json\n' + JSON.stringify(report, null, 2) + '\n' + String.fromCharCode(96).repeat(3);
}

export function turnWithReport(report = reportObject(), extraSteps = []) {
  return [...extraSteps, { kind: 'text', text: reportText(report) }];
}

async function git(args, cwd) {
  await exec('git', args, { cwd, env: process.env });
}

export async function createDshCase(label, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-collab-dsh-' + label + '-'));
  const home = path.join(root, 'home');
  const dshHome = path.join(root, 'dsh-home');
  const repo = path.join(root, 'repo');
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(dshHome, { recursive: true });
  await fsp.mkdir(repo, { recursive: true });
  await git(['init', '-q', '-b', 'main'], repo);
  await git(['config', 'user.email', 'test@example.com'], repo);
  await git(['config', 'user.name', 'test'], repo);
  await git(['config', 'commit.gpgsign', 'false'], repo);
  await fsp.writeFile(path.join(repo, 'README.md'), '# repo\n');
  await git(['add', '-A'], repo);
  await git(['commit', '-qm', 'init'], repo);

  const fake = await installFakeDsh(root, options.fakeDsh ?? {});
  const record = path.join(root, 'dsh-record.jsonl');
  await fsp.writeFile(record, '');
  const stateFile = path.join(root, 'dsh-state.json');
  const config = {
    executors: { dsh: { command: fake.link } },
    dsh: { home: dshHome, profile: 'web', transport: 'auto', autoStartWeb: false, openBrowserOnStart: false, webArgs: [] },
    permissionPreset: 'workspace-write',
    unattendedApproval: 'deny',
    inheritEnv: 'designer',
    reasoningEffort: 'follow',
    ...options.config,
  };
  await fsp.writeFile(path.join(home, 'config.json'), JSON.stringify(config, null, 2));
  const webChildren = [];
  const env = {
    ...process.env,
    AGENT_COLLAB_HOME: home,
    DSH_HOME: dshHome,
    FAKE_DSH_REPO_ROOT: repoRoot,
    FAKE_DSH_RECORD: record,
    FAKE_DSH_STATE_FILE: stateFile,
    ...options.env,
  };
  const caseApi = {
    root,
    home,
    dshHome,
    repo,
    fake,
    record,
    stateFile,
    config,
    env,
    async profile(packageJson) {
      const dir = path.join(dshHome, 'profiles', 'web');
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify(packageJson, null, 2));
    },
    async writeWebPatch(text) {
      const dir = path.join(dshHome, 'profiles', 'web');
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'cordis.patch.yml'), text);
    },
    async startWeb(startOptions = {}) {
      const child = spawn(process.execPath, [fake.entry, '--profile', 'web', '--no-open', '--port', '0'], {
        env: {
          ...env,
          FAKE_DSH_TURNS: JSON.stringify(startOptions.turns ?? []),
          ...(startOptions.presets ? { FAKE_DSH_PRESETS: JSON.stringify(startOptions.presets) } : {}),
          ...(startOptions.defaultModel ? { FAKE_DSH_DEFAULT_MODEL: JSON.stringify(startOptions.defaultModel) } : {}),
          ...(startOptions.createError ? { FAKE_DSH_CREATE_ERROR: String(startOptions.createError) } : {}),
          ...(startOptions.webMode ? { FAKE_DSH_WEB_MODE: startOptions.webMode } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      webChildren.push(child);
      child.stderr.on('data', () => {});
      child.stdout.on('data', () => {});
      const file = path.join(dshHome, 'agent-collab', 'bridge-web.json');
      const deadline = Date.now() + (startOptions.timeout ?? 8000);
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error('fake dsh web exited early with code ' + child.exitCode);
        try {
          const recordValue = JSON.parse(await fsp.readFile(file, 'utf8'));
          if (recordValue.profile === 'web') return recordValue;
        } catch {
          // 继续等。
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('timed out waiting for fake dsh discovery file');
    },
    async stopWebs() {
      // 手里有句柄的：只结束还在运行的（句柄已退出时它的 PID 可能已经被别的进程复用）。
      for (const child of webChildren.splice(0)) await killChild(child, { signal: 'SIGTERM' });
      // 只有发现文件里的 PID 的（适配器自动启动的那个 Web）：发现文件还在、PID 存活时才结束。
      await stopWebFromDiscovery(path.join(dshHome, 'agent-collab', 'bridge-web.json'));
      await new Promise((resolve) => setTimeout(resolve, 300));
    },
    async runCli(args, runOptions = {}) {
      let result;
      try {
        result = await exec(process.execPath, [binPath, ...args], {
          cwd: runOptions.cwd ?? repo,
          env: { ...env, ...(runOptions.env ?? {}) },
          timeout: runOptions.timeout ?? 60000,
          maxBuffer: 20 * 1024 * 1024,
        });
      } catch (error) {
        result = { code: error.code ?? 1, signal: error.signal ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
      }
      if (result.code === undefined) result = { ...result, code: 0 };
      if (result.signal === undefined) result = { ...result, signal: null };
      let json = null;
      for (const line of String(result.stdout ?? '').trim().split('\n')) {
        try { json = JSON.parse(line); } catch { /* 继续 */ }
      }
      return { ...result, json };
    },
    async startTask({ title = 'demo', brief = 'do it', extraArgs = [], env: extraEnv = {} } = {}) {
      const briefFile = path.join(root, 'brief-' + Math.random().toString(36).slice(2) + '.md');
      await fsp.writeFile(briefFile, brief);
      const result = await caseApi.runCli(['run', 'start', '--executor', 'dsh', '--brief', briefFile, '--title', title, ...extraArgs], { env: extraEnv });
      if (!result.json || !result.json.ok) throw new Error('run start failed: ' + result.stdout + result.stderr);
      return result.json;
    },
    async waitTask(runId, options = {}) {
      const result = await caseApi.runCli(['run', 'wait', runId], { timeout: options.timeout ?? 60000, env: options.env });
      let summary = null;
      if (result.json && result.json.summaryFile) {
        try { summary = JSON.parse(await fsp.readFile(result.json.summaryFile, 'utf8')); } catch { /* 忽略 */ }
      }
      return { ...result, summary };
    },
    async state(runId) {
      const runDir = path.join(home, 'runs', (await fsp.readdir(path.join(home, 'runs')))[0], runId);
      return JSON.parse(await fsp.readFile(path.join(runDir, 'state.json'), 'utf8'));
    },
    async runDir(runId) {
      const repoId = (await fsp.readdir(path.join(home, 'runs')))[0];
      return path.join(home, 'runs', repoId, runId);
    },
    async events(runId) {
      const dir = await caseApi.runDir(runId);
      const text = await fsp.readFile(path.join(dir, 'events.jsonl'), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
    async snapshot() {
      return JSON.parse(await fsp.readFile(stateFile, 'utf8'));
    },
    async records() {
      const text = await fsp.readFile(record, 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    },
    async cleanup() {
      // 只结束仍在进行中的任务的工作进程；已经停下或结束的任务里，worker.pid 可能已经属于别的进程。
      // 然后等工作进程退出（有上限、只等不杀）：它可能在任务写下终态后还在收尾，Windows 上会占着运行目录。
      await killActiveWorkers(home);
      await waitWorkersGone(home);
      await caseApi.stopWebs();
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
  return caseApi;
}

export function eventTypes(events) {
  return events.map((event) => event.type);
}

export function findEvent(events, type, predicate = () => true) {
  return events.find((event) => event.type === type && predicate(event));
}
