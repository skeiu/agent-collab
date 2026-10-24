// 本文件：dsh 的运行时探测（PLAN.md §4.3）：命令和入口解析、版本、DSH_HOME、发现文件和桥接安装情况。每项都可注入，便于测试；规则变化时更新。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isPidAlive } from './platform.mjs';

/** 本运行时支持的桥接协议范围（docs/protocol.md 通用约定）。 */
export const SUPPORTED_PROTOCOL = 1;
export const SUPPORTED_PROTOCOL_MIN = 1;

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgePackageFile = path.resolve(here, '..', 'dsh-bridge', 'package.json');

/** 读桥接包名；读不到时退回固定名称（测试环境里桥接包始终在仓库内）。 */
export function readBridgePackageName() {
  try {
    const value = JSON.parse(fs.readFileSync(bridgePackageFile, 'utf8'));
    if (typeof value.name === 'string' && value.name) return value.name;
  } catch {
    // 读不到时用默认名。
  }
  return 'dsh-bridge';
}

/** 探测失败：code 供适配器和 doctor 区分原因。 */
export class DshDetectError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'DshDetectError';
    this.code = options.code ?? 'dsh_detect_failed';
    if (options.cause) this.cause = options.cause;
    if (options.detail) this.detail = options.detail;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function splitPath(value, platform = process.platform) {
  return String(value ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
}

/** 从 npm 生成的 POSIX shell 包装里解析入口的相对路径；不是这种包装时返回 null。 */
export function parseNpmShellWrapper(text) {
  if (typeof text !== 'string') return null;
  const patterns = [
    /"\$basedir\/(\.\.\/[^"]+\.(?:js|mjs|cjs))"/,
    /"\$basedir\/([^"]+\.(?:js|mjs|cjs))"/,
    /'\$basedir\/(\.\.\/[^']+\.(?:js|mjs|cjs))'/,
    /'\$basedir\/([^']+\.(?:js|mjs|cjs))'/,
  ];
  for (const pattern of patterns) {
    const matched = pattern.exec(text);
    if (matched) return matched[1];
  }
  return null;
}

/** 从 npm 生成的 Windows .cmd 包装里解析入口的相对路径；纯函数，所有平台都可测。 */
export function parseNpmCmdWrapper(text) {
  if (typeof text !== 'string') return null;
  const patterns = [
    /(?:%dp0%|%~dp0)\\([^"\r\n]+\.(?:js|mjs|cjs))\b/i,
    /(?:%dp0%|%~dp0)\\("[^"]+\.(?:js|mjs|cjs)"[^"\r\n]*)/i,
  ];
  for (const pattern of patterns) {
    const matched = pattern.exec(text);
    if (matched) return matched[1].replace(/^"|"$/g, '');
  }
  return null;
}

async function isExecutable(file, platform) {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return false;
    if (platform === 'win32') return true;
    await fsp.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 在 PATH 上找命令；找不到返回 null。command 可以是绝对/相对路径。 */
export async function findCommand(command, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (typeof command !== 'string' || command.trim() === '') return null;
  const text = command.trim();
  const hasSeparator = text.includes('/') || text.includes('\\');
  const direct = hasSeparator || path.isAbsolute(text);
  if (direct) {
    const file = path.resolve(options.cwd ?? process.cwd(), text);
    return await isExecutable(file, platform) ? file : null;
  }
  const extensions = platform === 'win32'
    ? (String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean))
    : [''];
  for (const dir of splitPath(env.PATH, platform)) {
    if (await isExecutable(path.join(dir, text), platform)) return path.join(dir, text);
    if (platform === 'win32') {
      for (const extension of extensions) {
        const candidate = path.join(dir, text + extension);
        if (await isExecutable(candidate, platform)) return candidate;
      }
    }
  }
  return null;
}

/**
 * 解析 dsh 的入口 .js：跟随符号链接；识别 npm 生成的 shell / .cmd 包装。
 * 返回 { ok, file, how } 或 { ok:false, reason }。不猜。
 */
export async function resolveDshEntry(command, options = {}) {
  const platform = options.platform ?? process.platform;
  const found = await findCommand(command, options);
  if (!found) return { ok: false, reason: '在 PATH 上找不到 dsh 命令：' + String(command ?? '') };
  let file = found;
  let how = 'direct';
  try {
    const stat = await fsp.lstat(file);
    if (stat.isSymbolicLink()) {
      file = await fsp.realpath(file);
      how = 'symlink';
    }
  } catch (error) {
    return { ok: false, reason: '读不到命令文件：' + file + '（' + error.message + '）' };
  }
  if (/\.(?:js|mjs|cjs)$/i.test(file)) return { ok: true, file, how };
  let text = '';
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    return { ok: false, reason: '命令文件不是 .js，也读不出内容：' + file + '（' + error.message + '）' };
  }
  if (platform === 'win32' || /\.cmd$/i.test(found) || /^@echo off/im.test(text) || /%dp0%/i.test(text) || /%~dp0/i.test(text)) {
    const relative = parseNpmCmdWrapper(text);
    if (relative) return { ok: true, file: path.resolve(path.dirname(found), relative), how: 'cmd-wrapper' };
    return { ok: false, reason: 'Windows 包装里没有找到 %dp0% 指向的入口 .js：' + found };
  }
  const relative = parseNpmShellWrapper(text);
  if (relative) return { ok: true, file: path.resolve(path.dirname(found), relative), how: 'shell-wrapper' };
  if (/^#!.*\bnode\b/m.test(text)) {
    return { ok: false, reason: '命令文件是 Node 脚本，但无法确定它加载的入口 .js：' + found };
  }
  return { ok: false, reason: '无法从命令文件解析出入口 .js（不是 .js、符号链接或 npm 包装）：' + found };
}

/** 从入口文件向上找最近的 package.json；返回 { dir, manifest, file } 或 null。 */
export async function readPackageForEntry(entryFile, options = {}) {
  const fsApi = options.fs ?? fsp;
  let dir = path.dirname(path.resolve(entryFile));
  for (let depth = 0; depth < 12; depth += 1) {
    const file = path.join(dir, 'package.json');
    try {
      const manifest = JSON.parse(await fsApi.readFile(file, 'utf8'));
      if (isPlainObject(manifest)) return { dir, manifest, file };
    } catch {
      // 继续向上。
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function parseVersionOutput(text) {
  const first = String(text ?? '').trim().split(/\s+/)[0];
  return first || null;
}

/** 读 dsh 版本：入口所在包的 package.json，读不到时运行 --version。 */
export async function readDshVersion(entryFile, options = {}) {
  const pkg = await readPackageForEntry(entryFile, options);
  if (pkg && typeof pkg.manifest.version === 'string' && pkg.manifest.version) {
    return { version: pkg.manifest.version, source: 'package.json', package: pkg };
  }
  const runVersion = options.runVersion;
  if (typeof runVersion !== 'function') return { version: null, source: null, package: pkg ?? null, reason: '入口所在包没有 version，也没有提供 --version 探测函数' };
  try {
    const output = await runVersion(entryFile);
    const version = parseVersionOutput(output);
    if (!version) return { version: null, source: null, package: pkg ?? null, reason: 'dsh --version 没有输出版本' };
    return { version, source: '--version', package: pkg ?? null };
  } catch (error) {
    return { version: null, source: null, package: pkg ?? null, reason: 'dsh --version 失败：' + (error && error.message ? error.message : String(error)) };
  }
}

/** 默认的 --version 探测：用当前 Node 运行入口。 */
export function runDshVersion(entryFile, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entryFile, '--version'], {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      reject(new Error('超时 ' + timeoutMs + ' ms'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error('退出码 ' + code + (stderr ? '：' + stderr.trim().slice(-500) : '')));
    });
  });
}

/** 探测登录 shell 的环境；POSIX 上用 $SHELL -l -c，失败当作没有。Windows 上跳过。 */
export function probeLoginShellEnv(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (platform === 'win32') return { ok: false, reason: 'Windows 上不探测登录 shell', env: null };
  const shell = typeof env.SHELL === 'string' && env.SHELL.trim() ? env.SHELL : '/bin/sh';
  const timeoutMs = options.timeoutMs ?? 5000;
  const script = JSON.stringify(process.execPath) + ' -e ' + JSON.stringify('process.stdout.write(JSON.stringify(process.env))');
  return new Promise((resolve) => {
    const child = spawn(shell, ['-l', '-c', script], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      resolve({ ok: false, reason: '登录 shell 探测超时 ' + timeoutMs + ' ms', env: null, shell });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: '登录 shell 启动失败：' + error.message, env: null, shell });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      const text = stdout.trim();
      const start = text.indexOf('{');
      if (code !== 0 || start === -1) {
        resolve({ ok: false, reason: '登录 shell 探测失败（退出码 ' + code + '）' + (stderr ? '：' + stderr.trim().slice(-300) : ''), env: null, shell });
        return;
      }
      try {
        const parsed = JSON.parse(text.slice(start));
        resolve({ ok: true, env: parsed, shell });
      } catch (error) {
        resolve({ ok: false, reason: '登录 shell 输出不是 JSON：' + error.message, env: null, shell });
      }
    });
  });
}

/**
 * 解析 DSH_HOME：配置 dsh.home、当前环境 DSH_HOME、登录 shell 的 DSH_HOME、~/.dsh。
 * 返回 { home, source, loginShell }。
 */
export function resolveDshHome(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir;
  const configHome = options.configHome;
  if (typeof configHome === 'string' && configHome.trim() !== '') {
    return { home: path.resolve(configHome), source: 'config', loginShell: null };
  }
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '') {
    return { home: path.resolve(env.DSH_HOME), source: 'env', loginShell: null };
  }
  const login = options.loginShell ?? (platform === 'win32' ? { ok: false, reason: 'Windows 上不探测登录 shell' } : probeLoginShellEnv({ platform, env }));
  return Promise.resolve(login).then((probed) => {
    if (probed && probed.ok && typeof probed.env.DSH_HOME === 'string' && probed.env.DSH_HOME.trim() !== '') {
      return { home: path.resolve(probed.env.DSH_HOME), source: 'login-shell', loginShell: probed };
    }
    return { home: path.join(homedir(), '.dsh'), source: 'default', loginShell: probed ?? null };
  });
}

/** 读发现文件并判断在线；返回 { online, file, record, reason }。 */
export async function readDiscoveryFile(options = {}) {
  const home = options.home;
  const profile = options.profile ?? 'web';
  const file = path.join(home, 'agent-collab', 'bridge-' + profile + '.json');
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    return { online: false, file, record: null, reason: error.code === 'ENOENT' ? '发现文件不存在' : '读不到发现文件：' + error.message };
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch (error) {
    return { online: false, file, record: null, reason: '发现文件格式错误：' + error.message };
  }
  if (!isPlainObject(record)) return { online: false, file, record: null, reason: '发现文件格式错误：不是 JSON 对象' };
  const invalid = [];
  if (record.v !== 1) invalid.push('v');
  if (record.host !== '127.0.0.1') invalid.push('host');
  if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65535) invalid.push('port');
  if (typeof record.token !== 'string' || record.token === '') invalid.push('token');
  if (!Number.isInteger(record.pid) || record.pid <= 0) invalid.push('pid');
  if (!Number.isInteger(record.protocol)) invalid.push('protocol');
  if (!Number.isInteger(record.protocolMin)) invalid.push('protocolMin');
  if (typeof record.startedAt !== 'string') invalid.push('startedAt');
  if (invalid.length > 0) return { online: false, file, record, reason: '发现文件字段不完整或格式错误：' + invalid.join(', ') };
  if (typeof record.problem === 'string' && record.problem !== '') {
    return { online: false, file, record, reason: '桥接报告问题：' + record.problem };
  }
  const isAlive = options.isAlive ?? isPidAlive;
  if (!isAlive(record.pid)) return { online: false, file, record, reason: 'dsh Web 进程 ' + record.pid + ' 不在' };
  const supported = options.supported ?? { protocol: SUPPORTED_PROTOCOL, min: SUPPORTED_PROTOCOL_MIN };
  if (record.protocol < supported.min || record.protocolMin > supported.protocol) {
    return { online: false, file, record, reason: '协议范围没有交集（桥接 ' + record.protocolMin + '–' + record.protocol + '，运行时 ' + supported.min + '–' + supported.protocol + '）' };
  }
  return { online: true, file, record, reason: null };
}

/** 判断桥接是否装进 profile：看 package.json 的 dependencies。 */
export async function readBridgeInstallation(options = {}) {
  const home = options.home;
  const profile = options.profile ?? 'web';
  const name = options.bridgePackageName ?? readBridgePackageName();
  const file = path.join(home, 'profiles', profile, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    return { installed: false, file, packageName: name, reason: error.code === 'ENOENT' ? 'profile 还没初始化' : '读不到 profile package.json：' + error.message };
  }
  const dependencies = isPlainObject(manifest.dependencies) ? manifest.dependencies : {};
  const bundles = isPlainObject(manifest.dsh) && isPlainObject(manifest.dsh.profile) && Array.isArray(manifest.dsh.profile.bundles)
    ? manifest.dsh.profile.bundles
    : [];
  if (typeof dependencies[name] === 'string') {
    return { installed: true, file, packageName: name, field: 'dependencies', bundleListed: bundles.includes(name), reason: null };
  }
  return { installed: false, file, packageName: name, field: 'dependencies', bundleListed: bundles.includes(name), reason: 'profile 的 dependencies 里没有 ' + name };
}

/** 探测 dsh 的全部信息；doctor 和各适配器共用。 */
export async function detectDsh(options = {}) {
  const config = options.config ?? {};
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const dshConfig = isPlainObject(config.dsh) ? config.dsh : {};
  const executors = isPlainObject(config.executors) ? config.executors : {};
  const dshExecutor = isPlainObject(executors.dsh) ? executors.dsh : {};
  const configuredCommand = typeof dshExecutor.command === 'string' && dshExecutor.command.trim() !== '' ? dshExecutor.command.trim() : null;
  const command = configuredCommand ?? 'dsh';
  const commandSource = configuredCommand ? 'config' : 'path';
  const resolved = await resolveDshEntry(command, { env, platform, cwd: options.cwd });
  const profile = typeof dshConfig.profile === 'string' && dshConfig.profile ? dshConfig.profile : 'web';
  let versionInfo = { version: null, source: null, package: null, reason: resolved.ok ? null : resolved.reason };
  if (resolved.ok) {
    versionInfo = await readDshVersion(resolved.file, {
      env,
      runVersion: options.runVersion ?? ((entry) => runDshVersion(entry, { env })),
    });
  }
  const homeInfo = await resolveDshHome({
    configHome: dshConfig.home,
    env,
    platform,
    homedir: options.homedir,
    loginShell: options.loginShell,
  });
  const discovery = await readDiscoveryFile({
    home: homeInfo.home,
    profile,
    isAlive: options.isAlive,
    supported: options.supported,
  });
  const installation = await readBridgeInstallation({
    home: homeInfo.home,
    profile,
    bridgePackageName: options.bridgePackageName,
  });
  const webRunning = discovery.online ? true : (installation.installed ? false : null);
  return {
    ok: Boolean(resolved.ok && versionInfo.version),
    command: { value: command, source: commandSource },
    entry: resolved,
    package: versionInfo.package ?? null,
    version: versionInfo.version,
    versionSource: versionInfo.source,
    versionReason: versionInfo.reason ?? null,
    home: homeInfo,
    profile,
    discovery,
    installation,
    webRunning,
  };
}
