// 本文件：core/report.mjs 的单元测试。覆盖合法汇报、没有/多个代码块、非法 JSON 和 schema 错误；汇报格式变化时更新。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ReportInvalidJsonError,
  ReportMultipleCodeBlocksError,
  ReportNoCodeBlockError,
  ReportSchemaError,
  assertReport,
  extractJsonBlock,
  extractReport,
  parseReportJson,
  validateReport,
} from '../core/report.mjs';

const FENCE = String.fromCharCode(96).repeat(3);

function validReport(overrides = {}) {
  return {
    status: 'done',
    summary: '完成了任务',
    criteria: [{ id: 'AC1', met: true, evidence: 'npm test 通过' }],
    commands: [{ command: 'npm test', exit_code: 0, result: '全部通过' }],
    files_changed: ['core/a.mjs'],
    deviations: [],
    blocked_checks: [],
    open_questions: [],
    human_inputs: [],
    ...overrides,
  };
}

function fenced(value) {
  return '前置说明\n\n' + FENCE + 'json\n' + JSON.stringify(value, null, 2) + '\n' + FENCE + '\n\n后置说明';
}

test('提取唯一的 json 代码块并解析', () => {
  const report = validReport();
  const extracted = extractReport(fenced(report));
  assert.deepEqual(extracted, report);
});

test('只有一个 json 代码块时，其他语言的代码块不影响提取', () => {
  const report = validReport();
  const text = fenced(report) + '\n\n' + FENCE + 'bash\nnpm test\n' + FENCE + '\n';
  assert.deepEqual(extractReport(text), report);
});

test('没有代码块时返回 ReportNoCodeBlockError', () => {
  assert.throws(() => extractReport('普通回复，没有 JSON'), (error) => {
    assert.ok(error instanceof ReportNoCodeBlockError);
    assert.equal(error.code, 'REPORT_NO_CODE_BLOCK');
    return true;
  });
  assert.throws(() => extractJsonBlock('没有代码块'), ReportNoCodeBlockError);
});

test('多个 json 代码块时返回 ReportMultipleCodeBlocksError', () => {
  const text = fenced(validReport()) + '\n' + fenced(validReport());
  assert.throws(() => extractReport(text), (error) => {
    assert.ok(error instanceof ReportMultipleCodeBlocksError);
    assert.equal(error.count, 2);
    return true;
  });
});

test('JSON 不合法时返回 ReportInvalidJsonError', () => {
  const text = FENCE + 'json\n{ not json }\n' + FENCE;
  assert.throws(() => extractReport(text), (error) => {
    assert.ok(error instanceof ReportInvalidJsonError);
    assert.equal(error.code, 'REPORT_INVALID_JSON');
    return true;
  });
  assert.throws(() => parseReportJson(text), ReportInvalidJsonError);
});

test('不符合 schema 时返回 ReportSchemaError，带错误路径', () => {
  const report = validReport();
  delete report.summary;
  assert.throws(() => extractReport(fenced(report)), (error) => {
    assert.ok(error instanceof ReportSchemaError);
    assert.equal(error.code, 'REPORT_SCHEMA_INVALID');
    assert.ok(error.errors.some((item) => item.path === '/summary'));
    return true;
  });
});

test('额外字段和错误类型都按 schema 报错', () => {
  const extra = validateReport(validReport({ extra: true }));
  assert.equal(extra.valid, false);
  assert.ok(extra.errors.some((item) => item.path === '/extra' && item.keyword === 'additionalProperties'));
  const wrong = validateReport(validReport({ status: 'unknown' }));
  assert.equal(wrong.valid, false);
  assert.ok(wrong.errors.some((item) => item.path === '/status' && item.keyword === 'enum'));
  const wrongExit = validateReport(validReport({ commands: [{ command: 'x', exit_code: '0', result: 'x' }] }));
  assert.equal(wrongExit.valid, false);
  assert.ok(wrongExit.errors.some((item) => item.path === '/commands/0/exit_code'));
});

test('assertReport 对合法对象返回原对象，对非法对象抛 ReportSchemaError', () => {
  const report = validReport();
  assert.equal(assertReport(report), report);
  assert.throws(() => assertReport({ status: 'done' }), ReportSchemaError);
});
