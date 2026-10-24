// 本文件：cordis 插件入口。只在 dsh Web 组合包里启动回环监听、生成发现文件并管理生命周期；dsh 服务访问全部经 dsh-api。

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AcpBridgeServer, PROTOCOL_MIN, PROTOCOL_VERSION } from './acp-server.js';
import { atomicWriteJson } from './atomic-write.js';
import { createDshApi, isDshVersionSupported, SUPPORTED_DSH_RANGE } from './dsh-api.js';

export const name = 'agent-collab-bridge';

const packageManifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const bridgeVersion = packageManifest.version;

function discoveryPath(homeDir, profile) {
  return path.join(homeDir, 'agent-collab', 'bridge-' + profile + '.json');
}

function removeDiscoveryFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // 已删除或不可写。
  }
}

async function start(ctx) {
  const dsh = createDshApi(ctx);
  if (!dsh.isWebProfile()) return null;
  if (!dsh.homeDir) {
    ctx.logger?.warn?.('agent-collab bridge: cannot resolve DSH_HOME; bridge is not started');
    return null;
  }

  let problem = null;
  if (dsh.dshVersion === null) problem = 'cannot determine the running dsh version';
  else if (!isDshVersionSupported(dsh.dshVersion)) problem = 'dsh ' + dsh.dshVersion + ' is outside the supported range ' + SUPPORTED_DSH_RANGE;
  else if (!dsh.profileName) problem = 'cannot determine the dsh profile name';

  const token = randomBytes(32).toString('base64url');
  const server = new AcpBridgeServer({ dsh, bridgeVersion, token, problem });
  const port = await server.start();
  const profile = dsh.profileName ?? 'unknown';
  const file = discoveryPath(dsh.homeDir, profile);
  const record = {
    v: 1,
    host: '127.0.0.1',
    port,
    token,
    pid: process.pid,
    protocol: PROTOCOL_VERSION,
    protocolMin: PROTOCOL_MIN,
    bridgeVersion,
    dshVersion: dsh.dshVersion ?? 'unknown',
    profile,
    startedAt: new Date().toISOString(),
    ...dsh.getWebUrl() ? { webUrl: dsh.getWebUrl() } : {},
    ...problem === null ? {} : { problem },
  };
  try {
    await atomicWriteJson(file, record);
  } catch (error) {
    await server.stop();
    throw error;
  }
  ctx.logger?.info?.('agent-collab bridge listening on 127.0.0.1:' + port + ' (' + file + ')');

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    removeDiscoveryFile(file);
    void server.stop();
  };
  const onExit = () => removeDiscoveryFile(file);
  process.once('exit', onExit);
  ctx.effect(() => () => {
    process.off('exit', onExit);
    stop();
  });
  return { server, file };
}

export function apply(ctx) {
  ctx.inject(['agents', 'agentPresets', 'shellEnv', 'llm', 'workspaceRegistry'], (sub) => {
    void start(sub).catch((error) => {
      sub.logger?.error?.('agent-collab bridge failed to start: ' + (error instanceof Error ? error.message : String(error)));
    });
  });
}
