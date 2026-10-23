// 本文件：core/schema-check.mjs 的单元测试。覆盖每个支持的关键字、错误路径和不支持关键字的报错；校验器能力变化时更新。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { UnsupportedSchemaError, ValidationError, assertValid, validate } from '../core/schema-check.mjs';

test('type：单类型和类型数组', () => {
  assert.equal(validate({ type: 'string' }, 'ok').valid, true);
  const bad = validate({ type: 'string' }, 1);
  assert.equal(bad.valid, false);
  assert.equal(bad.errors[0].keyword, 'type');
  assert.equal(bad.errors[0].path, '');
  assert.equal(validate({ type: ['string', 'null'] }, null).valid, true);
  assert.equal(validate({ type: ['string', 'null'] }, 1).valid, false);
});

test('enum：通过和不通过', () => {
  assert.equal(validate({ enum: ['a', 'b'] }, 'a').valid, true);
  const bad = validate({ enum: ['a', 'b'] }, 'c');
  assert.equal(bad.valid, false);
  assert.equal(bad.errors[0].keyword, 'enum');
});

test('minimum 和 maximum', () => {
  assert.equal(validate({ type: 'integer', minimum: 1, maximum: 5 }, 3).valid, true);
  assert.equal(validate({ type: 'integer', minimum: 1, maximum: 5 }, 0).valid, false);
  assert.equal(validate({ type: 'integer', minimum: 1, maximum: 5 }, 6).valid, false);
});

test('properties、required 和嵌套错误路径', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      nested: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] },
    },
  };
  assert.equal(validate(schema, { name: 'x', nested: { count: 2 } }).valid, true);
  const missing = validate(schema, { nested: { count: 2 } });
  assert.equal(missing.valid, false);
  assert.equal(missing.errors[0].path, '/name');
  const nestedBad = validate(schema, { name: 'x', nested: { count: 'two' } });
  assert.equal(nestedBad.valid, false);
  assert.equal(nestedBad.errors[0].path, '/nested/count');
});

test('additionalProperties：布尔和子 schema', () => {
  const closed = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
  assert.equal(validate(closed, { a: 'x' }).valid, true);
  const extra = validate(closed, { a: 'x', b: 1 });
  assert.equal(extra.valid, false);
  assert.equal(extra.errors[0].path, '/b');
  assert.equal(extra.errors[0].keyword, 'additionalProperties');
  const typed = { type: 'object', additionalProperties: { type: 'integer' } };
  assert.equal(validate(typed, { a: 1, b: 2 }).valid, true);
  assert.equal(validate(typed, { a: 1, b: 'two' }).errors[0].path, '/b');
  const open = { type: 'object', additionalProperties: true };
  assert.equal(validate(open, { anything: true }).valid, true);
});

test('items：数组每个元素', () => {
  const schema = { type: 'array', items: { type: 'string' } };
  assert.equal(validate(schema, ['a', 'b']).valid, true);
  const bad = validate(schema, ['a', 2]);
  assert.equal(bad.valid, false);
  assert.equal(bad.errors[0].path, '/1');
});

test('JSON Pointer 对 ~ 和 / 转义', () => {
  const schema = { type: 'object', properties: { 'a/b~c': { type: 'integer' } } };
  const bad = validate(schema, { 'a/b~c': 'x' });
  assert.equal(bad.valid, false);
  assert.equal(bad.errors[0].path, '/a~1b~0c');
});

test('title、description、default 和 x- 开头的键被忽略', () => {
  const schema = { title: 't', description: 'd', default: {}, 'x-group': 'g', type: 'string' };
  assert.equal(validate(schema, 'ok').valid, true);
});

test('不支持的关键字抛 UnsupportedSchemaError', () => {
  for (const schema of [
    { type: 'string', pattern: '^a' },
    { type: 'string', format: 'email' },
    { anyOf: [{ type: 'string' }] },
    { $ref: '#/x' },
    { type: 'object', minProperties: 1 },
  ]) {
    assert.throws(() => validate(schema, 'x'), (error) => {
      assert.ok(error instanceof UnsupportedSchemaError);
      return true;
    });
  }
});

test('assertValid 不符合时抛 ValidationError，并带 errors', () => {
  assert.throws(() => assertValid({ type: 'integer' }, 'x', '测试'), (error) => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.errors[0].keyword, 'type');
    assert.match(error.message, /测试/);
    return true;
  });
});
