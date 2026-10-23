// 本文件：三级配置的读取、合并、校验和原子写入。配置项或合并规则变化时更新；schema 是唯一描述。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensurePrivateDir, resolveAgentCollabHome, writePrivateFile } from './platform.mjs';
import { ValidationError, validate } from './schema-check.mjs';

const schemaPath = fileURLToPath(new URL('../config/config.schema.json', import.meta.url));

/** 解析出来的配置 schema。 */
export const configSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

/** 配置文件读取或格式错误。 */
export class ConfigFileError extends Error {
  constructor(file, message, options = {}) {
    super(message + '（' + file + '）');
    this.name = 'ConfigFileError';
    this.file = file;
    if (options.cause) this.cause = options.cause;
    if (options.errors) this.errors = options.errors;
  }
}

/** 项目级配置越权设置某个键。 */
export class ConfigScopeError extends Error {
  constructor(keyPath, scopes, options = {}) {
    super(options.message ?? '项目配置不能设置 ' + keyPath + '（x-scopes 为 ' + scopes.join(', ') + '，不含 project）');
    this.name = 'ConfigScopeError';
    this.keyPath = keyPath;
    this.scopes = scopes;
    this.reason = options.reason ?? 'scope';
  }
}

/** 项目级配置试图把可收紧的项改得比前面各级更宽。 */
export class ConfigTightenError extends ConfigScopeError {
  constructor(keyPath, strategy, previousValue, proposedValue) {
    super(keyPath, ['global', 'project', 'task'], {
      message: '项目配置对 ' + keyPath + ' 只能收紧，不能放宽（x-project-tighten 规则 ' + strategy + '）',
      reason: 'loosens',
    });
    this.name = 'ConfigTightenError';
    this.strategy = strategy;
    this.previousValue = clone(previousValue);
    this.proposedValue = clone(proposedValue);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/** 逐层合并：对象递归合并，数组整体替换，null 作为普通值覆盖。 */
export function mergeConfigs(...layers) {
  let merged = {};
  for (const layer of layers) {
    if (layer === undefined || layer === null) continue;
    if (!isPlainObject(layer)) throw new TypeError('config layer must be an object');
    merged = mergeTwo(merged, layer);
  }
  return merged;
}

function mergeTwo(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return clone(override);
  const out = clone(base);
  for (const [key, value] of Object.entries(override)) {
    out[key] = hasOwn(out, key) ? mergeTwo(out[key], value) : clone(value);
  }
  return out;
}

/** 用 schema 的 default 补齐缺失项；返回的新对象不回写文件。 */
export function applyDefaults(schema, value) {
  if (value === undefined) {
    if (hasOwn(schema, 'default')) value = clone(schema.default);
    else if (isPlainObject(schema) && (schema.type === 'object' || isPlainObject(schema.properties))) value = {};
    else if (isPlainObject(schema) && schema.type === 'array') value = [];
    else return undefined;
  }
  if (isPlainObject(value)) {
    const out = clone(value);
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const [name, childSchema] of Object.entries(properties)) {
      const next = applyDefaults(childSchema, out[name]);
      if (next !== undefined) out[name] = next;
    }
    if (isPlainObject(schema.additionalProperties)) {
      for (const [name, childValue] of Object.entries(out)) {
        if (!hasOwn(properties, name)) out[name] = applyDefaults(schema.additionalProperties, childValue);
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    if (!isPlainObject(schema.items)) return clone(value);
    return value.map((item) => applyDefaults(schema.items, item));
  }
  return value;
}

function childSchemaFor(schema, key) {
  if (isPlainObject(schema.properties) && hasOwn(schema.properties, key)) return schema.properties[key];
  if (isPlainObject(schema.additionalProperties)) return schema.additionalProperties;
  return null;
}

const SKIP_PROJECT_VALUE = Symbol('skip project value');

function applyProjectTighten(rule, proposed, previous, keyPath, errors) {
  if (!isPlainObject(rule) || typeof rule.strategy !== 'string') {
    throw new Error('invalid x-project-tighten rule at ' + keyPath);
  }
  if (rule.strategy === 'union') {
    if (!Array.isArray(proposed) || !Array.isArray(previous)) {
      throw new Error('x-project-tighten union requires arrays at ' + keyPath);
    }
    if (proposed.length === 0 && previous.length > 0) {
      errors.push(new ConfigTightenError(keyPath, rule.strategy, previous, proposed));
      return SKIP_PROJECT_VALUE;
    }
    const result = [];
    const seen = new Set();
    for (const item of [...previous, ...proposed]) {
      const marker = JSON.stringify(item);
      if (seen.has(marker)) continue;
      seen.add(marker);
      result.push(clone(item));
    }
    return result;
  }
  if (rule.strategy === 'max') {
    if (!Array.isArray(rule.order)) throw new Error('x-project-tighten max requires order at ' + keyPath);
    const previousRank = rule.order.indexOf(previous);
    const proposedRank = rule.order.indexOf(proposed);
    if (previousRank < 0 || proposedRank < 0) {
      throw new Error('x-project-tighten max value is not in order at ' + keyPath);
    }
    if (proposedRank < previousRank) {
      errors.push(new ConfigTightenError(keyPath, rule.strategy, previous, proposed));
      return SKIP_PROJECT_VALUE;
    }
    return clone(proposed);
  }
  if (rule.strategy === 'only') {
    if (!hasOwn(rule, 'value')) throw new Error('x-project-tighten only requires value at ' + keyPath);
    if (proposed === rule.value) return clone(proposed);
    if (proposed === previous) return SKIP_PROJECT_VALUE;
    errors.push(new ConfigTightenError(keyPath, rule.strategy, previous, proposed));
    return SKIP_PROJECT_VALUE;
  }
  throw new Error('unknown x-project-tighten strategy at ' + keyPath + ': ' + rule.strategy);
}

function sanitizeProjectConfig(schema, value, previous, keyPath, errors) {
  if (!isPlainObject(value)) return clone(value);
  const out = {};
  for (const [key, childValue] of Object.entries(value)) {
    const childSchema = childSchemaFor(schema, key);
    const nextPath = keyPath ? keyPath + '.' + key : key;
    if (!childSchema) {
      out[key] = clone(childValue);
      continue;
    }
    const scopes = childSchema['x-scopes'];
    if (Array.isArray(scopes) && !scopes.includes('project')) {
      errors.push(new ConfigScopeError(nextPath, scopes));
      continue;
    }
    const previousValue = isPlainObject(previous) ? previous[key] : undefined;
    const tighten = childSchema['x-project-tighten'];
    if (tighten) {
      const result = applyProjectTighten(tighten, childValue, previousValue, nextPath, errors);
      if (result !== SKIP_PROJECT_VALUE) out[key] = result;
      continue;
    }
    if (isPlainObject(childValue) && (isPlainObject(childSchema.properties) || isPlainObject(childSchema.additionalProperties))) {
      out[key] = sanitizeProjectConfig(childSchema, childValue, previousValue, nextPath, errors);
    } else {
      out[key] = clone(childValue);
    }
  }
  return out;
}

async function readConfigFile(file, schema) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw new ConfigFileError(file, '读取配置失败：' + error.message, { cause: error });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigFileError(file, 'JSON 不合法：' + error.message, { cause: error });
  }
  const result = validate(schema, data);
  if (!result.valid) {
    throw new ConfigFileError(file, '不符合配置 schema：' + result.errors.map((item) => item.message).join('; '), { errors: result.errors });
  }
  return data;
}

/**
 * 读取全局、项目和单个任务三级配置，按顺序合并。
 *
 * 返回 { config, errors, sources }：
 * - config 已经用默认值补齐；
 * - errors 是项目级越权项和放宽项（这些项已被忽略，其余项正常生效）；
 * - sources 是各级文件路径（不存在时也为路径，便于调用方展示）。
 */
export async function loadConfig(options = {}) {
  const schema = options.schema ?? configSchema;
  const home = options.home ?? resolveAgentCollabHome(options.env ?? process.env);
  const projectDir = options.repoDir ?? options.repo ?? options.projectDir ?? null;
  const globalFile = path.join(home, 'config.json');
  const projectFile = projectDir ? path.join(projectDir, '.agent-collab.json') : null;
  const globalData = await readConfigFile(globalFile, schema);
  const projectData = projectFile ? await readConfigFile(projectFile, schema) : null;
  const taskData = options.taskConfig ?? options.task ?? {};
  if (!isPlainObject(taskData)) throw new ConfigFileError('<任务配置>', '任务配置必须是对象');

  const scopeErrors = [];
  const globalBase = applyDefaults(schema, globalData ?? {});
  const safeProject = projectData ? sanitizeProjectConfig(schema, projectData, globalBase, '', scopeErrors) : {};
  const merged = mergeConfigs(globalData ?? {}, safeProject, taskData);
  const config = applyDefaults(schema, merged);
  const result = validate(schema, config);
  if (!result.valid) {
    throw new ConfigFileError('<合并后的配置>', '不符合配置 schema：' + result.errors.map((item) => item.message).join('; '), { errors: result.errors });
  }
  return {
    config,
    errors: scopeErrors,
    sources: { global: globalFile, project: projectFile },
  };
}

/** 校验一份配置；返回 { valid, errors }。 */
export function validateConfig(config, schema = configSchema) {
  return validate(schema, config);
}

/** 校验后原子写入配置文件；写出的文件在 POSIX 上权限为 0600。 */
export async function saveConfig(file, config, options = {}) {
  const schema = options.schema ?? configSchema;
  const result = validate(schema, config);
  if (!result.valid) throw new ValidationError(result.errors, '配置不符合 schema');
  await ensurePrivateDir(path.dirname(file));
  await writePrivateFile(file, JSON.stringify(config, null, 2) + '\n');
  return config;
}

/** 按执行端名称取出合并后的选项；顶层同名项是所有执行端的默认值。 */
export function getExecutorOptions(config, name) {
  if (typeof name !== 'string' || !name) throw new TypeError('executor name is required');
  const executors = isPlainObject(config.executors) ? config.executors : {};
  const executor = isPlainObject(executors[name]) ? executors[name] : {};
  const topEnv = isPlainObject(config.env) ? config.env : {};
  const executorEnv = isPlainObject(executor.env) ? executor.env : {};
  return {
    command: executor.command ?? null,
    model: executor.model ?? config.model ?? null,
    reasoningEffort: executor.reasoningEffort ?? config.reasoningEffort,
    env: { ...topEnv, ...executorEnv },
  };
}

export { ValidationError };
