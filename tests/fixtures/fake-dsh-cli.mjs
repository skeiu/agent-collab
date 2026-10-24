// 本文件：测试用假 dsh CLI 安装的入口。--profile web 时在进程内跑桥接并写发现文件，--profile acp 时当 ACP stdio 代理；记录参数、环境和 --patch 内容。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repoRoot = process.env.FAKE_DSH_REPO_ROOT;
if (!repoRoot) {
  process.stderr.write('FAKE_DSH_REPO_ROOT is not set\n');
  process.exit(2);
}
const { createFakeDsh } = await import(pathToFileURL(path.join(repoRoot, 'tests', 'fixtures', 'fake-dsh.mjs')).href);
const { apply } = await import(pathToFileURL(path.join(repoRoot, 'dsh-bridge', 'lib', 'index.js')).href);

const argv = process.argv.slice(2);
const profileIndex = argv.indexOf('--profile');
const profile = profileIndex >= 0 ? argv[profileIndex + 1] : null;
const patchIndex = argv.indexOf('--patch');
const patchFile = patchIndex >= 0 ? argv[patchIndex + 1] : null;
const recordFile = process.env.FAKE_DSH_RECORD;
const stateFile = process.env.FAKE_DSH_STATE_FILE;

function appendRecord(value) {
  if (!recordFile) return;
  try {
    fs.appendFileSync(recordFile, JSON.stringify(value) + '\n', { mode: 0o600 });
  } catch {
    // 记录失败不影响启动。
  }
}

function readPatch(file) {
  if (!file) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

appendRecord({
  argv,
  profile,
  patchFile,
  patch: readPatch(patchFile),
  env: {
    DSH_HOME: process.env.DSH_HOME ?? null,
    DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? null,
    AGENT_COLLAB_ROLE: process.env.AGENT_COLLAB_ROLE ?? null,
    DSH_AGENT_COLLAB_ROLE: process.env.DSH_AGENT_COLLAB_ROLE ?? null,
    LOGIN_ONLY: process.env.LOGIN_ONLY ?? null,
    DESIGNER_ONLY: process.env.DESIGNER_ONLY ?? null,
    FAKE_DSH_RECORD: recordFile ?? null,
  },
});

if (argv.includes('--version')) {
  process.stdout.write('0.2.1\n');
  process.exit(0);
}

if (profile === 'acp') {
  const script = process.env.FAKE_ACP_SCRIPT;
  const child = spawn(process.execPath, [path.join(repoRoot, 'tests', 'fixtures', 'fake-acp-agent.mjs')], {
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.once('exit', (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
} else if (profile === 'web' || profile === null) {
  await runWeb();
} else {
  process.stderr.write('fake dsh: unknown profile ' + profile + '\n');
  process.exit(2);
}

async function runWeb() {
  const mode = process.env.FAKE_DSH_WEB_MODE ?? 'normal';
  if (mode === 'exit') {
    process.stderr.write('fake dsh: exiting on purpose\n');
    process.exit(3);
  }
  const home = process.env.DSH_HOME;
  if (!home) {
    process.stderr.write('fake dsh: DSH_HOME is not set\n');
    process.exit(2);
  }
  const turns = process.env.FAKE_DSH_TURNS ? JSON.parse(process.env.FAKE_DSH_TURNS) : null;
  const presets = process.env.FAKE_DSH_PRESETS ? JSON.parse(process.env.FAKE_DSH_PRESETS) : undefined;
  const defaultModel = process.env.FAKE_DSH_DEFAULT_MODEL ? JSON.parse(process.env.FAKE_DSH_DEFAULT_MODEL) : undefined;
  const context = createFakeDsh({ homeDir: home, profile: 'web', turns, presets, defaultModel });
  apply(context.ctx);
  const discoveryFile = path.join(home, 'agent-collab', 'bridge-web.json');
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !fs.existsSync(discoveryFile)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!fs.existsSync(discoveryFile)) {
    process.stderr.write('fake dsh: bridge did not write a discovery file\n');
    process.exit(1);
  }
  if (mode === 'no-discovery') {
    // 写一个假文件后删掉，模拟 Web 起来了但桥接没有写出发现文件。
    fs.rmSync(discoveryFile, { force: true });
  }
  let snapshotTimer = null;
  if (stateFile) {
    const writeState = () => {
      try { fs.writeFileSync(stateFile, JSON.stringify(context.fake.snapshot(), null, 2)); } catch { /* 忽略 */ }
    };
    writeState();
    snapshotTimer = setInterval(writeState, 50);
    if (typeof snapshotTimer.unref === 'function') snapshotTimer.unref();
  }
  const shutdown = () => {
    if (snapshotTimer) clearInterval(snapshotTimer);
    try { context.fake.dispose(); } catch { /* 忽略 */ }
    try { fs.rmSync(discoveryFile, { force: true }); } catch { /* 忽略 */ }
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.once('exit', () => {
    try { fs.rmSync(discoveryFile, { force: true }); } catch { /* 忽略 */ }
  });
  // 保持进程存活。
  setInterval(() => {}, 1000);
}
