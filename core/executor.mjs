// 本文件：执行端适配器的定位、加载和选项组装（docs/protocol.md 第 3 节）。run.mjs 做预检、worker.mjs 调用适配器时共用；适配器接口变化时更新。

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { getExecutorOptions } from './config.mjs';

const coreDir = fileURLToPath(new URL('.', import.meta.url));

/** 执行端名对应 core/adapters/<name>.mjs；测试用 AGENT_COLLAB_TEST_ADAPTER 指定模块绝对路径。 */
export function resolveAdapterFile(name, env = process.env) {
  const override = env && env.AGENT_COLLAB_TEST_ADAPTER;
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override);
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    const error = new Error('执行端名不合法：' + String(name));
    error.code = 'executor_unavailable';
    throw error;
  }
  return path.join(coreDir, 'adapters', name + '.mjs');
}

/** 确认适配器模块存在；找不到时抛 executor_unavailable。 */
export async function assertAdapterAvailable(name, env = process.env) {
  const file = resolveAdapterFile(name, env);
  try {
    await fsp.access(file);
  } catch {
    const error = new Error('找不到执行端适配器 ' + String(name) + '（' + file + '）');
    error.code = 'executor_unavailable';
    error.file = file;
    throw error;
  }
  return file;
}

/** 加载适配器并创建实例。 */
export async function loadAdapter(name, { config, onEvent, log, env = process.env, state = null }) {
  const file = await assertAdapterAvailable(name, env);
  let module;
  try {
    module = await import(pathToFileURL(file).href);
  } catch (error) {
    const wrapped = new Error('加载执行端适配器失败：' + error.message);
    wrapped.code = 'executor_unavailable';
    wrapped.cause = error;
    throw wrapped;
  }
  if (typeof module.createAdapter !== 'function') {
    const error = new Error('执行端适配器没有导出 createAdapter：' + file);
    error.code = 'executor_unavailable';
    throw error;
  }
  return module.createAdapter({ config, onEvent, log, env, state });
}

/** 组装传给适配器 start() 的 options（config.mjs 按执行端合并好的选项）。 */
export function buildAdapterOptions(config, name) {
  const base = getExecutorOptions(config, name);
  return {
    model: base.model ?? null,
    reasoningEffort: base.reasoningEffort ?? null,
    permissionPreset: config.permissionPreset ?? null,
    unattendedApproval: config.unattendedApproval ?? null,
    agentPreset: config.dsh && typeof config.dsh === 'object' ? (config.dsh.agentPreset ?? null) : null,
    allowedRoots: config.allowedRoots ?? null,
    command: base.command ?? null,
  };
}

/** 组装要注入执行端的变量。 */
export function buildAdapterEnv(config, name) {
  return { ...getExecutorOptions(config, name).env };
}
