// 本文件：用真实 dsh 验证 ACP 客户端的集成测试。一条命令运行，不进 node --test；需要 PATH 上有 dsh。

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { AcpClient } from '../../core/acp-client.mjs';

const FAKE_PROVIDER = 'example-provider';
const FAKE_MODEL = 'example-model';
const FAKE_PROVIDER_PORT = crypto.randomInt(10000, 60000);

function findOnPath(name) {
  const pathEnv = process.env.PATH ?? '';
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return fs.realpathSync(candidate);
      } catch {
        // 继续找。
      }
    }
  }
  return null;
}

function assertTempHome(env) {
  if (!env.DSH_HOME) throw new Error('DSH_HOME is not set');
  const real = fs.realpathSync(env.DSH_HOME);
  const tmp = fs.realpathSync(os.tmpdir());
  if (real === tmp || !real.startsWith(tmp + path.sep)) throw new Error('DSH_HOME must be a new directory under os.tmpdir()');
  if (!fs.statSync(real).isDirectory()) throw new Error('DSH_HOME is not a directory');
  return real;
}

function createSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-collab-acp-dsh-'));
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

function runDsh(env, dshEntry, args, options = {}) {
  assertTempHome(env);
  const result = spawnSync(process.execPath, [dshEntry, ...args], {
    env,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 180000,
    cwd: options.cwd,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
}

function topLevelBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let current;
  for (const line of lines) {
    if (line.startsWith('- ')) {
      if (current) blocks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks.map((block) => block.join('\n').replace(/\n+$/, ''));
}

function selectOverlayEntries(text) {
  return topLevelBlocks(text).filter((block) => /^- id: (llm-|agent-default-model\b)/m.test(block));
}

async function main() {
  let box;
  let client;
  try {
    const dsh = findOnPath('dsh');
    if (!dsh) throw new Error('dsh was not found on PATH');
    box = createSandbox();
    assertTempHome(box.env);

    const initWeb = runDsh(box.env, dsh, ['--profile', 'web', '--dump-config'], { timeoutMs: 60000 });
    if (initWeb.status !== 0) throw new Error('could not initialize web profile: ' + initWeb.stderr.slice(-1000));

    const webPatch = [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      ' + FAKE_PROVIDER + ':',
      '        displayName: Example Provider',
      '        api: openai-completions',
      '        baseURL: http://127.0.0.1:' + FAKE_PROVIDER_PORT + '/v1',
      '        models:',
      '          - id: ' + FAKE_MODEL,
      '            name: Example Model',
      '            contextWindow: 8192',
      '- id: agent-default-model',
      '  config:',
      '    provider: ' + FAKE_PROVIDER,
      '    model: ' + FAKE_MODEL,
      '',
    ].join('\n');
    const webPatchPath = path.join(box.home, 'profiles', 'web', 'cordis.patch.yml');
    fs.mkdirSync(path.dirname(webPatchPath), { recursive: true });
    fs.writeFileSync(webPatchPath, webPatch);

    const webCheck = runDsh(box.env, dsh, ['--profile', 'web', '--dump-config'], { timeoutMs: 60000 });
    if (webCheck.status !== 0) throw new Error('fake web user layer did not load: ' + webCheck.stderr.slice(-1000));

    const entries = selectOverlayEntries(webPatch);
    if (entries.length !== 2) throw new Error('expected 2 overlay entries, got ' + entries.length);
    const overlay = '# generated by tests/integration/acp-client-dsh.mjs\n' + entries.join('\n') + '\n- id: acp\n  config:\n    provider: ' + FAKE_PROVIDER + '\n    model: ' + FAKE_MODEL + '\n';
    const overlayPath = path.join(box.root, 'acp-overlay.yml');
    fs.writeFileSync(overlayPath, overlay);

    const work = path.join(box.root, 'workspace');
    fs.mkdirSync(work, { recursive: true });

    client = await AcpClient.connect({
      transport: 'stdio',
      command: process.execPath,
      args: [dsh, '--profile', 'acp', '--patch', overlayPath],
      cwd: work,
      env: box.env,
      permissionPolicy: 'deny',
    });

    const init = await client.initialize();
    if (init.protocolVersion !== 1) throw new Error('unexpected ACP protocol version: ' + init.protocolVersion);
    if (!init.agentInfo || init.agentInfo.name !== 'deepseek-harness-acp') throw new Error('unexpected agentInfo: ' + JSON.stringify(init.agentInfo));

    const session = await client.newSession({ cwd: work, mcpServers: [] });
    if (typeof session.sessionId !== 'string' || !session.sessionId) throw new Error('session/new did not return sessionId');
    await client.closeSession({ sessionId: session.sessionId });
    await client.close();
    client = null;
    console.log('RESULT: 通过 — dsh ACP initialize / session/new / session/close 成功（protocol=1，agent=' + init.agentInfo.name + '）');
  } catch (error) {
    if (client) {
      try {
        await client.close();
      } catch {
        // 忽略清理错误。
      }
    }
    console.log('RESULT: 不通过 — ' + (error && error.message ? error.message : String(error)));
    process.exitCode = 1;
  } finally {
    if (box) {
      try {
        box.cleanup();
      } catch (error) {
        console.log('清理临时目录失败：' + error.message);
        process.exitCode = 1;
      }
    }
  }
}

await main();
