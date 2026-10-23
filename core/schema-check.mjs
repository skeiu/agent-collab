// 本文件：零依赖的精简 JSON Schema 校验器。config.mjs 和 report.mjs 共用；支持的 schema 关键字变化时更新。

import { isDeepStrictEqual } from 'node:util';

const SUPPORTED_KEYWORDS = new Set([
  'type',
  'enum',
  'minimum',
  'maximum',
  'properties',
  'required',
  'additionalProperties',
  'items',
]);

const IGNORED_KEYWORDS = new Set(['title', 'description', 'default']);

/** schema 用了不支持的关键字。 */
export class UnsupportedSchemaError extends Error {
  constructor(keyword, path) {
    super('unsupported JSON Schema keyword "' + keyword + '" at schema path ' + (path || '/'));
    this.name = 'UnsupportedSchemaError';
    this.keyword = keyword;
    this.path = path;
  }
}

/** 值不符合 schema。errors 里每项有 JSON Pointer 路径、关键字和说明。 */
export class ValidationError extends Error {
  constructor(errors, label) {
    const first = errors[0];
    super((label ? label + ': ' : '') + (first ? first.message : 'validation failed'));
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapePointer(segment) {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function childPath(path, segment) {
  return path + '/' + escapePointer(segment);
}

function formatPath(path) {
  return path || '/';
}

function unsupported(keyword, path) {
  throw new UnsupportedSchemaError(keyword, path);
}

const checkedSchemas = new WeakSet();

/** 检查 schema 只用了支持的关键字；不支持的关键字直接抛错。 */
export function assertSchemaSupported(schema, path = '') {
  if (!isPlainObject(schema)) throw new UnsupportedSchemaError('(non-object schema)', path);
  if (checkedSchemas.has(schema)) return;
  for (const key of Object.keys(schema)) {
    if (IGNORED_KEYWORDS.has(key) || key.startsWith('x-')) continue;
    if (key === 'version' && path === '') {
      if (!Number.isInteger(schema.version)) throw new UnsupportedSchemaError('version (non-integer)', path);
      continue;
    }
    if (!SUPPORTED_KEYWORDS.has(key)) unsupported(key, path);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const type of types) {
      const allowed = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
      if (!allowed.includes(type)) unsupported('type ' + type, path);
    }
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) unsupported('enum (non-array)', path);
  if (schema.minimum !== undefined && typeof schema.minimum !== 'number') unsupported('minimum (non-number)', path);
  if (schema.maximum !== undefined && typeof schema.maximum !== 'number') unsupported('maximum (non-number)', path);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== 'string'))) {
    unsupported('required (non-string-array)', path);
  }
  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) unsupported('properties (non-object)', path);
    for (const [name, child] of Object.entries(schema.properties)) {
      assertSchemaSupported(child, childPath(path, name));
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    if (!isPlainObject(schema.additionalProperties)) unsupported('additionalProperties (non-object)', path);
    assertSchemaSupported(schema.additionalProperties, path + '/additionalProperties');
  }
  if (schema.items !== undefined) {
    if (!isPlainObject(schema.items)) unsupported('items (non-object)', path);
    assertSchemaSupported(schema.items, path + '/items');
  }
  checkedSchemas.add(schema);
}

function matchesType(value, type) {
  switch (type) {
    case 'object':
      return isPlainObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      throw new UnsupportedSchemaError('type ' + type, '');
  }
}

function addError(errors, path, keyword, message) {
  errors.push({ path, keyword, message: 'at ' + formatPath(path) + ': ' + message });
}

function walk(schema, value, path, errors) {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      addError(errors, path, 'type', 'expected ' + types.join(' or ') + ', got ' + (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value));
      return;
    }
  }
  if (schema.enum !== undefined) {
    if (!schema.enum.some((item) => isDeepStrictEqual(item, value))) {
      addError(errors, path, 'enum', 'value is not one of the allowed values');
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      addError(errors, path, 'minimum', 'value must be >= ' + schema.minimum);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      addError(errors, path, 'maximum', 'value must be <= ' + schema.maximum);
    }
  }
  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, name)) {
          addError(errors, childPath(path, name), 'required', 'required property is missing');
        }
      }
    }
    for (const [name, childSchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, name)) {
        walk(childSchema, value[name], childPath(path, name), errors);
      }
    }
    if (schema.additionalProperties !== undefined) {
      for (const [name, childValue] of Object.entries(value)) {
        if (Object.prototype.hasOwnProperty.call(properties, name)) continue;
        const extraPath = childPath(path, name);
        if (schema.additionalProperties === false) {
          addError(errors, extraPath, 'additionalProperties', 'additional property is not allowed');
        } else if (isPlainObject(schema.additionalProperties)) {
          walk(schema.additionalProperties, childValue, extraPath, errors);
        }
      }
    }
  }
  if (Array.isArray(value) && isPlainObject(schema.items)) {
    value.forEach((item, index) => walk(schema.items, item, childPath(path, index), errors));
  }
}

/** 按 schema 校验 value，返回 { valid, errors }；schema 不支持时抛 UnsupportedSchemaError。 */
export function validate(schema, value) {
  assertSchemaSupported(schema);
  const errors = [];
  walk(schema, value, '', errors);
  return { valid: errors.length === 0, errors };
}

/** 按 schema 校验 value，不符合时抛 ValidationError。 */
export function assertValid(schema, value, label = '') {
  const result = validate(schema, value);
  if (!result.valid) throw new ValidationError(result.errors, label);
  return value;
}

export { childPath as pointerPath, formatPath };
