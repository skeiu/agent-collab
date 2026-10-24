// 本文件：基础版 doctor（docs/protocol.md 第 6 节）：只读探测 Node、git、仓库、dsh、桥接、预设和本仓库进行中的任务。检查项变化时更新。

import fs from 'node:fs';
import path from 'node:path';

import { AcpClient } from './acp-client.mjs';
import { loadConfig } from './config.mjs';
import { SUPPORTED_PROTOCOL, SUPPORTED_PROTOCOL_MIN, detectDsh } from './detect.mjs';
import { findRepoRoot, git, readHead } from './git.mjs';
import { isPidAlive, resolveAgentCollabHome } from './platform.mjs';
import { isRunningStatus, lockFileFor, readJson, readLock, repoIdFor } from './rundir.mjs';

const packageVersion = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function usageError(message) {
  return { ok: false, error: { code: 'usage', message }, exitCode: 2 };
}

function check(id, level, ok, message) {
  return { id, level, ok, message };
}

async function gitVersion() {
  try {
    const result = await git(['--version']);
    if (result.code !== 0) return { ok: false, version: null, message: result.stderr.trim() || ('退出码 ' + result.code) };
    return { ok: true, version: result.stdout.trim(), message: result.stdout.trim() };
  } catch (error) {
    return { ok: false, version: null, message: '运行 git 失败：' + (error && error.message ? error.message : String(error)) };
  }
}

async function dirtyPaths(repoRoot) {
  const result = await git(['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'], { cwd: repoRoot });
  if (result.code !== 0) return [];
  const parts = result.stdout.split('\0');
  const paths = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    let file = entry.slice(3);
    if (status[0] === 'R' || status[0] === 'C') {
      index += 1;
      if (parts[index]) file = parts[index];
    }
    if (file) paths.push(file);
  }
  return [...new Set(paths)].sort();
}

async function bridgePresets(info, env) {
  if (!info.discovery.online) return { ok: false, presets: null, error: '桥接不在线' };
  let client = null;
  try {
    client = await AcpClient.connectTcp({ host: info.discovery.record.host, port: info.discovery.record.port, permissionPolicy: 'deny' });
    const init = await client.initialize({
      clientInfo: { name: 'agent-collab-doctor', version: packageVersion },
      _meta: {
        agentCollab: {
          token: info.discovery.record.token,
          protocol: SUPPORTED_PROTOCOL,
          protocolMin: SUPPORTED_PROTOCOL_MIN,
          clientVersion: packageVersion,
        },
      },
    });
    const presets = init && init._meta && init._meta.agentCollab ? init._meta.agentCollab.agentPresets ?? null : null;
    return { ok: true, presets, error: null };
  } catch (error) {
    return { ok: false, presets: null, error: error && error.message ? error.message : String(error) };
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

async function activeRunFor({ home, repoRoot }) {
  if (!repoRoot) return null;
  const repoId = repoIdFor(repoRoot);
  const lock = await readLock(lockFileFor(home, repoId));
  if (lock.state !== 'ok' || typeof lock.lock.runId !== 'string' || !lock.lock.runId) return null;
  if (!isPidAlive(lock.lock.pid)) return null;
  const state = await readJson(path.join(home, 'runs', repoId, lock.lock.runId, 'state.json')).catch(() => null);
  if (state && !isRunningStatus(state.status)) return null;
  return { runId: lock.lock.runId, status: state ? state.status ?? null : null };
}

/** doctor 命令入口；返回进程退出码。 */
export async function doctorCommand(argv, io = {}, context = {}) {
  const out = io.out ?? ((value) => process.stdout.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value) + '\n'));
  const env = context.env ?? process.env;
  const cwd = context.cwd ?? process.cwd();
  let json = false;
  let deep = false;
  let repoOption = null;
  let designerOption = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') json = true;
    else if (arg === '--deep') deep = true;
    else if (arg === '--repo') {
      index += 1;
      if (argv[index] === undefined) return reportUsage(out, '--repo 缺少值');
      repoOption = argv[index];
    } else if (arg.startsWith('--repo=')) repoOption = arg.slice(7);
    else if (arg === '--designer') {
      index += 1;
      if (argv[index] === undefined || argv[index].length === 0) return reportUsage(out, '--designer 缺少值');
      designerOption = argv[index];
    } else if (arg.startsWith('--designer=')) {
      designerOption = arg.slice('--designer='.length);
      if (designerOption.length === 0) return reportUsage(out, '--designer 缺少值');
    } else return reportUsage(out, '未知参数 ' + arg);
  }
  if (deep) {
    const value = { ok: false, error: { code: 'usage', message: 'doctor --deep 1a 尚未实现，请去掉 --deep' } };
    out(value);
    return 2;
  }

  const home = context.home ?? resolveAgentCollabHome(env);
  const startDir = repoOption ? path.resolve(cwd, repoOption) : cwd;
  const repoRoot = await findRepoRoot(startDir);
  let config = null;
  let configProblem = null;
  let configErrors = [];
  try {
    const loaded = await loadConfig({ repoDir: repoRoot ?? null, env });
    config = loaded.config;
    configErrors = Array.isArray(loaded.errors) ? loaded.errors : [];
  } catch (error) {
    configProblem = error && error.message ? error.message : String(error);
  }

  const checks = [];
  if (configProblem) {
    checks.push(check('config', 'warn', false, '读取配置失败：' + configProblem));
  } else if (configErrors.length > 0) {
    const keys = configErrors.map((item) => item.keyPath).filter(Boolean);
    checks.push(check('config', 'warn', false, '项目配置有 ' + configErrors.length + ' 项未生效：' + keys.join(', ')));
  }
  const nodeVersion = process.versions.node;
  const nodeMajor = Number(String(nodeVersion).split('.')[0]);
  checks.push(check('node', 'error', Number.isFinite(nodeMajor) && nodeMajor >= 20, 'Node ' + nodeVersion + (nodeMajor >= 20 ? '' : '（需要 Node ≥ 20）')));

  const gitInfo = await gitVersion();
  checks.push(check('git', 'error', gitInfo.ok, gitInfo.ok ? gitInfo.message : 'git 不可用：' + gitInfo.message));

  let head = { head: null, branch: null };
  let dirty = [];
  if (repoRoot) {
    head = await readHead(repoRoot);
    dirty = await dirtyPaths(repoRoot);
  }
  checks.push(check('repo', 'error', Boolean(repoRoot), repoRoot ? 'git 仓库：' + repoRoot : '当前目录不是 git 仓库'));
  checks.push(check('worktree_clean', 'warn', dirty.length === 0, dirty.length === 0 ? '工作区干净' : '工作区有 ' + dirty.length + ' 个改动：' + dirty.slice(0, 5).join(', ')));

  const info = await detectDsh({ config, env, cwd: startDir });
  const dshOk = Boolean(info.ok);
  checks.push(check('dsh', 'error', dshOk, dshOk
    ? 'dsh ' + info.version + '：' + (info.entry.ok ? info.entry.file : '') + '（命令 ' + info.command.value + '）'
    : '找不到可用的 dsh：' + (info.entry.ok ? (info.versionReason ?? '读不到版本') : info.entry.reason)));

  const webRunning = info.webRunning;
  const webMessage = webRunning === true ? 'dsh Web 正在运行（pid ' + (info.discovery.record ? info.discovery.record.pid : '?') + '）'
    : webRunning === false ? 'dsh Web 没有在运行（profile 里装了桥接）'
      : '判断不了 dsh Web 是否在运行（profile 里没装桥接）';
  checks.push(check('dsh_web', 'info', webRunning !== null, webMessage));

  const presetsResult = info.discovery.online ? await bridgePresets(info, env) : { ok: false, presets: null, error: info.discovery.reason };
  const bridgeOk = Boolean(info.discovery.online && presetsResult.ok);
  const bridgeLevel = config && config.dsh && config.dsh.transport === 'bridge' ? 'error' : 'warn';
  checks.push(check('bridge', bridgeLevel, bridgeOk, bridgeOk
    ? '桥接在线：' + info.discovery.file + '（协议 ' + info.discovery.record.protocol + '，桥接 ' + info.discovery.record.bridgeVersion + '）'
    : '桥接不在线：' + (info.discovery.online ? (presetsResult.error ?? 'initialize 失败') : info.discovery.reason)));

  const available = presetsResult.presets && Array.isArray(presetsResult.presets.available) ? presetsResult.presets.available : [];
  const presetOk = Boolean(presetsResult.ok && available.includes('agent-collab'));
  const presetMessage = !presetsResult.ok
    ? '桥接不在线，无法检查 agent-collab 预设'
    : presetOk
      ? 'agent-collab 预设可用' + (presetsResult.presets && presetsResult.presets.agentCollabInSync === false ? '（与 standard 去掉 tool-ask-user 后不一致）' : '')
      : 'agent-collab 预设不可用（可用：' + (available.length > 0 ? available.join(', ') : '无') + '）';
  checks.push(check('agent_preset', 'warn', presetOk, presetMessage));

  const activeRun = await activeRunFor({ home, repoRoot });
  checks.push(check('active_run', 'warn', activeRun === null, activeRun === null ? '本仓库没有进行中的任务' : '本仓库有进行中的任务 ' + activeRun.runId + '（' + activeRun.status + '）'));

  const failedError = checks.find((item) => item.level === 'error' && !item.ok);
  const ok = !failedError;
  const dsh = {
    command: info.command.value,
    version: info.version,
    home: info.home.home,
    profile: info.profile,
    webRunning,
    bridge: {
      online: Boolean(info.discovery.online && presetsResult.ok),
      discoveryFile: info.discovery.file,
      protocol: info.discovery.record ? info.discovery.record.protocol ?? null : null,
      bridgeVersion: info.discovery.record ? info.discovery.record.bridgeVersion ?? null : null,
      problem: info.discovery.record && typeof info.discovery.record.problem === 'string' ? info.discovery.record.problem : null,
      installed: Boolean(info.installation.installed),
    },
    agentPresets: presetsResult.presets,
  };
  const designer = designerOption ?? null;
  let flow = null;
  if (!configProblem) {
    const mapping = config.executorByDesigner;
    const executor = designer === null
      ? null
      : (mapping && Object.prototype.hasOwnProperty.call(mapping, designer) ? mapping[designer] : null);
    flow = {
      designer,
      executor,
      confirmBeforeDispatch: config.confirmBeforeDispatch ?? null,
      maxCorrectionRounds: config.maxCorrectionRounds ?? null,
      commitOnAccept: config.commitOnAccept ?? null,
      warnSameAgentPair: config.warnSameAgentPair ?? null,
    };
  }
  const result = {
    ok,
    checks,
    git: {
      isRepo: Boolean(repoRoot),
      root: repoRoot,
      head: head.head,
      branch: head.branch,
      dirty,
    },
    dsh,
    activeRun,
    flow,
  };
  if (!ok) result.error = { code: 'doctor_failed', message: failedError.message };

  if (json) out(result);
  else {
    for (const item of checks) {
      const mark = item.ok ? 'OK' : item.level === 'error' ? 'FAIL' : item.level === 'warn' ? 'WARN' : 'INFO';
      out('[' + mark + '] ' + item.id + '：' + item.message);
    }
    out('[FLOW] flow：' + (flow === null ? 'null' : JSON.stringify(flow)));
  }
  return ok ? 0 : 1;
}

function reportUsage(out, message) {
  const value = { ok: false, error: { code: 'usage', message } };
  out(value);
  return 2;
}
