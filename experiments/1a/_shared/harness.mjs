// 1a 实验共用脚手架：临时 DSH_HOME、dsh/pnpm 定位、被测 dsh Web 启停和测试插件打包。只在 experiments/1a/*/run.mjs 中导入。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

export function createSandbox(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-collab-1a-' + label + '-'));
  const home = path.join(root, 'dsh-home');
  fs.mkdirSync(home, { recursive: true });
  const userHome = path.join(root, 'home');
  fs.mkdirSync(userHome, { recursive: true });
  const env = {
    ...process.env,
    HOME: userHome,
    DSH_HOME: home,
    COREPACK_HOME: path.join(root, 'corepack'),
    npm_config_cache: path.join(root, 'npm-cache'),
    PNPM_HOME: path.join(root, 'pnpm-home'),
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    XDG_DATA_HOME: path.join(root, 'xdg-data'),
    // pnpm 12 把 store 操作锁建在 XDG_RUNTIME_DIR 下；不重定向就会写到临时目录之外。
    XDG_RUNTIME_DIR: path.join(root, 'xdg-runtime'),
  };
  fs.mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  env.PATH = [process.env.PATH ?? '', path.dirname(process.execPath)].filter(Boolean).join(path.delimiter);
  return {
    root,
    home,
    env,
    cleanup() {
      const real = fs.realpathSync(root);
      const tmp = fs.realpathSync(os.tmpdir());
      if (!real.startsWith(tmp + path.sep)) throw new Error('refusing to clean a directory outside os.tmpdir(): ' + real);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function assertTempHome(env) {
  if (!env.DSH_HOME) throw new Error('DSH_HOME is not set');
  const real = fs.realpathSync(env.DSH_HOME);
  const tmp = fs.realpathSync(os.tmpdir());
  if (real === tmp || !real.startsWith(tmp + path.sep)) {
    throw new Error('DSH_HOME must be a new directory under os.tmpdir()');
  }
  if (!fs.statSync(real).isDirectory()) throw new Error('DSH_HOME is not a directory');
  return real;
}

export function findDsh(env) {
  let out;
  try {
    out = execFileSync('bash', ['-c', 'command -v dsh'], { env, encoding: 'utf8', timeout: 15000 }).trim();
  } catch {
    throw new Error('dsh was not found on PATH');
  }
  if (!out) throw new Error('dsh was not found on PATH');
  return fs.realpathSync(out);
}

export function commandPath(env, name) {
  try {
    const out = execFileSync('bash', ['-c', 'command -v ' + name], { env, encoding: 'utf8', timeout: 15000 }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export function hasPnpm(env) {
  return commandPath(env, 'pnpm') !== undefined;
}

export function enablePnpm(env, root) {
  if (hasPnpm(env)) return commandPath(env, 'pnpm');
  const corepack = commandPath(env, 'corepack');
  if (!corepack) throw new Error('neither pnpm nor corepack was found on PATH');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  execFileSync(corepack, ['enable', '--install-directory', bin, 'pnpm'], { env, encoding: 'utf8', timeout: 30000 });
  env.PATH = bin + path.delimiter + env.PATH;
  // 首次启用 corepack 的 pnpm shim 可能需要下载 pnpm；实验开始前先完成这一步。
  execFileSync('pnpm', ['--version'], { env, encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
  return path.join(bin, 'pnpm');
}

export function runDsh(env, dshEntry, args, options = {}) {
  assertTempHome(env);
  const result = spawnSync(process.execPath, [dshEntry, ...args], {
    env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 180000,
    input: options.input,
    cwd: options.cwd,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

export function startWeb(env, dshEntry, options = {}) {
  assertTempHome(env);
  const child = spawn(process.execPath, [dshEntry, '--profile', options.profile ?? 'web', '--port', '0', '--no-open'], {
    env,
    cwd: options.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + (options.timeoutMs ?? 90000);
    const timer = setInterval(() => {
      const match = /dsh web: (https?:\/\/[^\s]+)/.exec(stdout);
      if (match) {
        clearInterval(timer);
        resolve({
          child,
          url: match[1],
          port: new URL(match[1]).port,
          stdout: () => stdout,
          stderr: () => stderr,
        });
        return;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        clearInterval(timer);
        reject(new Error('dsh web exited before printing its URL; stderr tail: ' + stderr.slice(-2000)));
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        stopChild(child).catch(() => {});
        reject(new Error('timed out waiting for dsh web to print its URL; stderr tail: ' + stderr.slice(-2000)));
      }
    }, 200);
  });
}

export async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const waitExit = (ms) => new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, ms);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    child.once('exit', onExit);
  });
  child.kill('SIGTERM');
  const graceful = await waitExit(5000);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await waitExit(5000);
  }
}

export async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out waiting for ' + label);
}

export function makePlugin(root, env, spec) {
  const dir = path.join(root, 'plugin-src', spec.name + '-' + spec.version);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: spec.name,
    version: spec.version,
    private: true,
    type: 'module',
    main: 'index.js',
    files: ['index.js', 'cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'index.js'), spec.main);
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), spec.patch);
  const outDir = path.join(root, 'packs');
  fs.mkdirSync(outDir, { recursive: true });
  const printed = execFileSync('npm', ['pack', '--json', '--pack-destination', outDir], {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(printed);
  if (!parsed[0]?.filename) throw new Error('npm pack did not report a filename');
  return path.join(outDir, parsed[0].filename);
}

export function installPlugin(env, dshEntry, profile, tgz, extraArgs = []) {
  return runDsh(env, dshEntry, ['plugin', '--profile', profile, 'add', tgz, ...extraArgs], { timeoutMs: 180000 });
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function packageRootOfDsh(dshEntry) {
  return path.dirname(path.dirname(dshEntry));
}

export function assert(condition, message) {
  if (!condition) throw new Error('assertion failed: ' + message);
}
