// 本文件：dsh 适配器集成测试（DA8）：真实 dsh + 假 LLM，覆盖桥接在线、自动启动 Web 和 acp 退回。一条命令运行，最后一行 RESULT。

import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertTempHome,
  createSandbox,
  enablePnpm,
  findDsh,
  runDsh,
  startWeb,
  stopChild,
  waitFor,
} from './dsh-harness.mjs';
import { createFakeLlm } from '../fixtures/fake-llm.mjs';
import { buildAcpOverlay } from '../../core/adapters/dsh.mjs';
import { detectDsh } from '../../core/detect.mjs';

const runFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const binPath = path.join(repoRoot, 'bin', 'collab.mjs');

function fail(message) {
  throw new Error(message);
}

function unpack(result, label) {
  if (result.status !== 0) fail(label + ' 失败（退出码 ' + result.status + '）：' + (result.stderr || result.error || '').slice(-2000));
}

function reportObject(overrides = {}) {
  return {
    status: 'done',
    summary: '做完了',
    criteria: [{ id: 'AC1', met: true, evidence: '文件已写出' }],
    commands: [{ command: 'true', exit_code: 0, result: '通过' }],
    files_changed: ['out.txt'],
    deviations: [],
    blocked_checks: [],
    open_questions: [],
    human_inputs: [],
    ...overrides,
  };
}

function reportText(report = reportObject()) {
  return '完成。\n\n' + String.fromCharCode(96).repeat(3) + 'json\n' + JSON.stringify(report, null, 2) + '\n' + String.fromCharCode(96).repeat(3);
}

function writeConfig(home, value) {
  return fsp.mkdir(home, { recursive: true }).then(() => fsp.writeFile(path.join(home, 'config.json'), JSON.stringify(value, null, 2)));
}

async function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, env: process.env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('git ' + args.join(' ') + ' 失败：' + result.stderr);
}

async function makeRepo(root, name) {
  const repo = path.join(root, name);
  await fsp.mkdir(repo, { recursive: true });
  await git(['init', '-q', '-b', 'main'], repo);
  await git(['config', 'user.email', 'test@example.com'], repo);
  await git(['config', 'user.name', 'test'], repo);
  await git(['config', 'commit.gpgsign', 'false'], repo);
  await fsp.writeFile(path.join(repo, 'README.md'), '# repo\n');
  await git(['add', '-A'], repo);
  await git(['commit', '-qm', 'init'], repo);
  return repo;
}

async function runCli(env, cwd, args, timeout = 180000) {
  let result;
  try {
    result = await runFileAsync(process.execPath, [binPath, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    result = { code: error.code ?? 1, signal: error.signal ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '', error };
  }
  const code = result.code === undefined ? 0 : result.code;
  const lines = String(result.stdout ?? '').trim().split('\n');
  let json = null;
  for (const line of lines) {
    try { json = JSON.parse(line); } catch { /* 继续 */ }
  }
  return { status: code, signal: result.signal ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error ? String(result.error) : null, json };
}

async function runTask(env, repo, label, briefText) {
  const brief = path.join(repo, '..', 'brief-' + label + '.md');
  await fsp.writeFile(brief, briefText);
  const start = await runCli(env, repo, ['run', 'start', '--executor', 'dsh', '--brief', brief, '--title', label]);
  if (!start.json || !start.json.ok) fail(label + ' run start 失败：' + start.stdout + start.stderr);
  const wait = await runCli(env, repo, ['run', 'wait', start.json.runId], Number(process.env.ADAPTER_WAIT_MS ?? 240000));
  if (!wait.json) {
    let diagnostics = '';
    try {
      const runDir = start.json.runDir;
      diagnostics += '\nworker.log:\n' + (await fsp.readFile(path.join(runDir, 'worker.log'), 'utf8')).slice(-4000);
      diagnostics += '\nstate.json:\n' + (await fsp.readFile(path.join(runDir, 'state.json'), 'utf8')).slice(-4000);
      diagnostics += '\nevents.jsonl tail:\n' + (await fsp.readFile(path.join(runDir, 'events.jsonl'), 'utf8')).slice(-4000);
      const sessionsRoot = path.join(env.DSH_HOME, 'sessions');
      const files = [];
      async function walkSessions(dir) {
        const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walkSessions(full);
          else if (entry.name.endsWith('.zstd')) files.push(full);
        }
      }
      await walkSessions(sessionsRoot);
      files.sort();
      if (files.length > 0) {
        const { spawnSync } = await import('node:child_process');
        const session = spawnSync('zstdcat', [files.at(-1)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
        diagnostics += '\ndsh session tail:\n' + String(session.stdout ?? '').split('\n').slice(-30).join('\n');
      }
    } catch (error) {
      diagnostics += '\n读取诊断失败：' + error.message;
    }
    fail(label + ' run wait 没有 JSON：status=' + wait.status + ' signal=' + wait.signal + ' error=' + wait.error + ' stdout=' + wait.stdout.slice(-2000) + ' stderr=' + wait.stderr.slice(-2000) + ' runDir=' + JSON.stringify(start.json) + diagnostics);
  }
  let summary = null;
  if (wait.json.summaryFile) summary = JSON.parse(await fsp.readFile(wait.json.summaryFile, 'utf8'));
  return { start: start.json, wait: wait.json, summary, stdout: wait.stdout, stderr: wait.stderr };
}

async function checkDoctor(env, repo, label, expected) {
  const doctor = await runCli(env, repo, ['doctor', '--json'], 120000);
  if (doctor.status !== 0) fail(label + ' doctor 退出码 ' + doctor.status + '：' + doctor.stdout + doctor.stderr);
  const value = doctor.json;
  if (expected.webRunning !== undefined && value.dsh.webRunning !== expected.webRunning) fail(label + ' webRunning=' + value.dsh.webRunning + '，期望 ' + expected.webRunning);
  if (expected.bridge !== undefined && value.dsh.bridge.online !== expected.bridge) fail(label + ' bridge.online=' + value.dsh.bridge.online + '，期望 ' + expected.bridge);
  if (expected.installed !== undefined && value.dsh.bridge.installed !== expected.installed) fail(label + ' bridge.installed=' + value.dsh.bridge.installed + '，期望 ' + expected.installed);
  if (expected.preset === true) {
    const presets = value.dsh.agentPresets && value.dsh.agentPresets.available;
    if (!Array.isArray(presets) || !presets.includes('agent-collab')) fail(label + ' agentPresets 没有 agent-collab：' + JSON.stringify(value.dsh.agentPresets));
  }
  return value;
}

async function listFiles(dir) {
  const out = [];
  async function walk(current, prefix) {
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      out.push(prefix + entry.name + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) await walk(file, prefix + entry.name + '/');
    }
  }
  await walk(dir, '');
  return out;
}

async function hashes(dir) {
  const files = await listFiles(dir);
  const result = {};
  for (const file of files) {
    if (file.endsWith('/')) continue;
    const full = path.join(dir, file);
    const data = await fsp.readFile(full);
    const { createHash } = await import('node:crypto');
    result[file] = createHash('sha256').update(data).digest('hex');
  }
  return result;
}

async function main() {
  const box = createSandbox('adapter-dsh');
  let web = null;
  let autoWebPid = null;
  let fake = null;
  try {
    assertTempHome(box.env);
    const dsh = findDsh(box.env);
    enablePnpm(box.env, box.root);
    const packDir = path.join(box.root, 'packs');
    const build = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build.mjs'), '--out', packDir], { cwd: repoRoot, env: box.env, encoding: 'utf8' });
    unpack({ status: build.status, stderr: build.stderr }, '构建桥接 .tgz');
    const bridgeTgz = path.join(packDir, 'dsh-bridge-' + JSON.parse(await fsp.readFile(path.join(repoRoot, 'package.json'), 'utf8')).version + '.tgz');
    if (!(await fsp.access(bridgeTgz).then(() => true, () => false))) fail('构建产物不存在：' + bridgeTgz);

    const dshHome = box.home;
    const home = path.join(box.root, 'agent-home');
    await writeConfig(home, {
      dsh: { home: dshHome, profile: 'web', transport: 'auto', autoStartWeb: false, openBrowserOnStart: false, webArgs: ['--port', '0'] },
      permissionPreset: 'workspace-write',
      reasoningEffort: 'follow',
      unattendedApproval: 'deny',
      inheritEnv: 'designer',
    });

    // I1：Web 已开、桥接在线。
    const addBridge = runDsh(box.env, dsh, ['plugin', '--profile', 'web', 'add', bridgeTgz], { timeoutMs: 180000 });
    unpack(addBridge, 'dsh plugin add 桥接');
    const repo1 = await makeRepo(box.root, 'repo-i1');
    const out1 = path.join(repo1, 'out.txt');
    fake = await createFakeLlm({ responses: [
      { toolCalls: [{ name: 'bash', arguments: { command: 'printf \"%s\" hello > out.txt', description: '写 out.txt' } }] },
      { text: reportText() },
    ] });
    await fsp.mkdir(path.join(dshHome, 'profiles', 'web'), { recursive: true });
    await fsp.writeFile(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      fake:',
      '        displayName: Fake',
      '        api: openai-completions',
      '        baseURL: ' + fake.url,
      '        headers:',
      "          authorization: !!js \"'Bearer fake-key'\"",
      '        models:',
      '          - id: fake-model',
      '            name: Fake Model',
      '            contextWindow: 8192',
      '- id: agent-default-model',
      '  config:',
      '    provider: fake',
      '    model: fake-model',
      '',
    ].join('\n'));
    web = await startWeb(box.env, dsh, { cwd: repo1 });
    const discovery1 = path.join(dshHome, 'agent-collab', 'bridge-web.json');
    await waitFor(() => fsp.access(discovery1).then(() => true, () => false), 30000, 'I1 发现文件');
    const env1 = { ...box.env, AGENT_COLLAB_HOME: home, DSH_HOME: dshHome };
    const i1 = await runTask(env1, repo1, 'I1', '请写一个文件 out.txt，内容 hello，最后用 json 代码块汇报。');
    if (i1.wait.status !== 'done') fail('I1 状态不是 done：' + JSON.stringify(i1.wait) + i1.stderr);
    if (i1.summary.executor.transport !== 'bridge') fail('I1 transport 不是 bridge：' + JSON.stringify(i1.summary.executor));
    if (!(await fsp.access(out1).then(() => true, () => false))) fail('I1 没有写出 out.txt');
    await checkDoctor(env1, repo1, 'I1', { webRunning: true, bridge: true, installed: true, preset: true });
    console.log('[I1] Web 已开、桥接在线 → 任务 done，transport bridge，文件已写出，doctor 一致');

    // I2：Web 没开、profile 里装了桥接 → 自动启动。
    await stopChild(web.child);
    web = null;
    await waitFor(() => fsp.access(discovery1).then(() => false, () => true), 10000, 'I2 Web 停止');
    await writeConfig(home, {
      dsh: { home: dshHome, profile: 'web', transport: 'auto', autoStartWeb: true, openBrowserOnStart: false, webArgs: ['--port', '0'] },
      permissionPreset: 'workspace-write',
      reasoningEffort: 'follow',
      unattendedApproval: 'deny',
      inheritEnv: 'designer',
    });
    const repo2 = await makeRepo(box.root, 'repo-i2');
    const out2 = path.join(repo2, 'out.txt');
    await fake.close();
    fake = await createFakeLlm({ responses: [
      { toolCalls: [{ name: 'bash', arguments: { command: 'printf \"%s\" hello > out.txt', description: '写 out.txt' } }] },
      { text: reportText() },
    ] });
    await fsp.writeFile(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), (await fsp.readFile(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).replace(/baseURL: .*/, 'baseURL: ' + fake.url));
    const env2 = { ...box.env, AGENT_COLLAB_HOME: home, DSH_HOME: dshHome, AGENT_COLLAB_TEST_WEB_START_TIMEOUT_MS: '60000' };
    const i2 = await runTask(env2, repo2, 'I2', '请写一个文件 out.txt，内容 hello，最后用 json 代码块汇报。');
    if (i2.wait.status !== 'done') fail('I2 状态不是 done：' + JSON.stringify(i2.wait) + i2.stderr);
    if (i2.summary.executor.transport !== 'bridge') fail('I2 transport 不是 bridge：' + JSON.stringify(i2.summary.executor));
    if (!(await fsp.access(out2).then(() => true, () => false))) fail('I2 没有写出 out.txt');
    const discovery2 = JSON.parse(await fsp.readFile(discovery1, 'utf8'));
    autoWebPid = discovery2.pid;
    await checkDoctor(env2, repo2, 'I2', { webRunning: true, bridge: true, installed: true, preset: true });
    console.log('[I2] Web 没开、桥接已装 → 自动启动 Web，任务 done，doctor 一致');

    // 停掉自动启动的 Web。
    try { process.kill(autoWebPid, 'SIGTERM'); } catch { /* 已退出 */ }
    await waitFor(() => fsp.access(discovery1).then(() => false, () => true), 10000, 'I2 Web 停止');
    autoWebPid = null;

    // I3：profile 里没装桥接 → 退回 acp。
    const pkgFile = path.join(dshHome, 'profiles', 'web', 'package.json');
    const pkg = JSON.parse(await fsp.readFile(pkgFile, 'utf8'));
    delete pkg.dependencies['dsh-bridge'];
    pkg.dsh = { ...(pkg.dsh ?? {}), profile: { ...(pkg.dsh?.profile ?? {}), bundles: (pkg.dsh?.profile?.bundles ?? []).filter((name) => name !== 'dsh-bridge') } };
    await fsp.writeFile(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
    await fsp.writeFile(path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      fake:',
      '        displayName: Fake',
      '        api: openai-completions',
      '        baseURL: ' + fake.url,
      '        headers:',
      "          authorization: !!js \"'Bearer fake-key'\"",
      '        models:',
      '          - id: fake-model',
      '            name: Fake Model',
      '            contextWindow: 8192',
      '- id: agent-default-model',
      '  config:',
      '    provider: fake',
      '    model: fake-model',
      '',
    ].join('\n'));
    const acpProfile = path.join(dshHome, 'profiles', 'acp');
    const acpBefore = await hashes(acpProfile).catch(() => ({}));
    let webPatchHashBefore = null;
    const repo3 = await makeRepo(box.root, 'repo-i3');
    const out3 = path.join(repo3, 'out.txt');
    await fake.close();
    fake = await createFakeLlm({ responses: [
      { toolCalls: [{ name: 'bash', arguments: { command: 'printf \"%s\" hello > out.txt', description: '写 out.txt' } }] },
      { text: reportText() },
    ] });
    const webPatchFile = path.join(dshHome, 'profiles', 'web', 'cordis.patch.yml');
    await fsp.writeFile(webPatchFile, (await fsp.readFile(webPatchFile, 'utf8')).replace(/baseURL: .*/, 'baseURL: ' + fake.url));
    const webPatchHashBeforeNew = (await hashes(path.join(dshHome, 'profiles', 'web')))['cordis.patch.yml'];
    webPatchHashBefore = webPatchHashBeforeNew;
    const env3 = { ...box.env, AGENT_COLLAB_HOME: home, DSH_HOME: dshHome };
    const info3 = await detectDsh({ config: { dsh: { home: dshHome, profile: 'web' } }, env: env3 });
    if (!info3.ok) fail('I3 探测 dsh 失败：' + JSON.stringify(info3));
    const probe = await buildAcpOverlay({ dshInfo: info3, model: null, env: env3 });
    const probeText = await fsp.readFile(probe.file, 'utf8');
    await fsp.rm(probe.dir, { recursive: true, force: true }).catch(() => {});
    if (!probeText.includes('!!js')) fail('I3 覆盖层没有保留 !!js：' + probeText);
    const i3 = await runTask(env3, repo3, 'I3', '请写一个文件 out.txt，内容 hello，最后用 json 代码块汇报。');
    if (i3.wait.status !== 'done') {
      const runDir3 = i3.start.runDir;
      const log3 = await fsp.readFile(path.join(runDir3, 'worker.log'), 'utf8').catch(() => '');
      fail('I3 状态不是 done：' + JSON.stringify(i3.wait) + i3.stderr + JSON.stringify(i3.summary) + '\nworker.log:\n' + log3.slice(-5000));
    }
    if (i3.summary.executor.transport !== 'acp') fail('I3 transport 不是 acp：' + JSON.stringify(i3.summary.executor));
    if (!(await fsp.access(out3).then(() => true, () => false))) fail('I3 没有写出 out.txt');
    const fallbackWarning = (i3.summary.warnings ?? []).find((message) => message.includes('退回'));
    if (!fallbackWarning) fail('I3 没有退回 acp 的 warning');
    const acpAfter = await hashes(acpProfile).catch(() => ({}));
    for (const [file, hash] of Object.entries(acpBefore)) {
      if (acpAfter[file] !== hash) fail('I3 acp profile 文件被改了：' + file);
    }
    const webPatchHashAfter = (await hashes(path.join(dshHome, 'profiles', 'web')))['cordis.patch.yml'];
    if (webPatchHashAfter !== webPatchHashBefore) fail('I3 web profile 的 cordis.patch.yml 被改了');
    await checkDoctor(env3, repo3, 'I3', { webRunning: null, bridge: false, installed: false });
    console.log('[I3] profile 没装桥接 → 退回 acp，任务 done，web/acp profile 未被修改，doctor 一致');

    console.log('RESULT: 通过 — I1 桥接在线、I2 自动启动 Web、I3 退回 acp 都完成；每个场景 doctor 一致；临时目录和 dsh Web 已清理。');
  } finally {
    if (fake) await fake.close().catch(() => {});
    if (web) await stopChild(web.child).catch(() => {});
    if (autoWebPid) {
      try { process.kill(autoWebPid, 'SIGTERM'); } catch { /* 已退出 */ }
    }
    // 再按发现文件里的 pid 兜底（只结束自己启动的 Web）。
    try {
      const record = JSON.parse(await fsp.readFile(path.join(box.home, 'agent-collab', 'bridge-web.json'), 'utf8'));
      if (Number.isInteger(record.pid) && record.pid !== process.pid) process.kill(record.pid, 'SIGTERM');
    } catch { /* 没有发现文件 */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
    box.cleanup();
  }
}

main().catch((error) => {
  process.exitCode = 1;
  console.error(error && error.stack ? error.stack : String(error));
  console.log('RESULT: 不通过 — ' + (error && error.message ? error.message : String(error)));
});
