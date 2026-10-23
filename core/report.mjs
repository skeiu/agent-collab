// 本文件：从回复文字里提取唯一 json 代码块并校验汇报格式。run.mjs 提取汇报时使用；汇报格式变化时更新。

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ValidationError, validate } from './schema-check.mjs';

const schemaPath = fileURLToPath(new URL('../skills/collab/references/report-schema.json', import.meta.url));

/** 解析出来的汇报 schema。 */
export const reportSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

/** 汇报提取或格式错误的基类。 */
export class ReportError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ReportError';
    this.code = code;
  }
}

/** 回复里没有 json 代码块。 */
export class ReportNoCodeBlockError extends ReportError {
  constructor() {
    super('回复里没有 json 代码块', 'REPORT_NO_CODE_BLOCK');
    this.name = 'ReportNoCodeBlockError';
  }
}

/** 回复里有多个 json 代码块。 */
export class ReportMultipleCodeBlocksError extends ReportError {
  constructor(count) {
    super('回复里有 ' + count + ' 个 json 代码块，应当只有一个', 'REPORT_MULTIPLE_CODE_BLOCKS');
    this.name = 'ReportMultipleCodeBlocksError';
    this.count = count;
  }
}

/** json 代码块里的内容不是合法 JSON。 */
export class ReportInvalidJsonError extends ReportError {
  constructor(message, cause) {
    super('汇报 JSON 不合法：' + message, 'REPORT_INVALID_JSON');
    this.name = 'ReportInvalidJsonError';
    if (cause) this.cause = cause;
  }
}

/** JSON 合法但不符合 schema。 */
export class ReportSchemaError extends ReportError {
  constructor(errors) {
    super('汇报不符合 schema：' + errors.map((item) => item.message).join('; '), 'REPORT_SCHEMA_INVALID');
    this.name = 'ReportSchemaError';
    this.errors = errors;
  }
}

const FENCE = String.fromCharCode(96).repeat(3);
const JSON_FENCE = new RegExp('^[ \\t]*' + FENCE + 'json[ \\t]*\\r?\\n([\\s\\S]*?)^[ \\t]*' + FENCE + '[ \\t]*$', 'gim');

/** 提取唯一的 json 代码块内容。 */
export function extractJsonBlock(text) {
  if (typeof text !== 'string') throw new TypeError('reply text must be a string');
  const blocks = [];
  JSON_FENCE.lastIndex = 0;
  let match;
  while ((match = JSON_FENCE.exec(text)) !== null) blocks.push(match[1]);
  if (blocks.length === 0) throw new ReportNoCodeBlockError();
  if (blocks.length > 1) throw new ReportMultipleCodeBlocksError(blocks.length);
  return blocks[0];
}

/** 提取并解析汇报 JSON（不校验 schema）。 */
export function parseReportJson(text) {
  const block = extractJsonBlock(text);
  try {
    return JSON.parse(block);
  } catch (error) {
    throw new ReportInvalidJsonError(error.message, error);
  }
}

/** 按 schema 校验汇报对象；返回 { valid, errors }。 */
export function validateReport(value) {
  return validate(reportSchema, value);
}

/** 提取、解析并按 schema 校验汇报。 */
export function extractReport(text) {
  const value = parseReportJson(text);
  const result = validateReport(value);
  if (!result.valid) throw new ReportSchemaError(result.errors);
  return value;
}

/** 按 schema 校验汇报对象，不合法时抛 ReportSchemaError。 */
export function assertReport(value) {
  const result = validateReport(value);
  if (!result.valid) throw new ReportSchemaError(result.errors);
  return value;
}


export { ValidationError };
