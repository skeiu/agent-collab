// 本文件：配置 schema 的覆盖测试（AC5）。核对 §12.2 的配置项清单、元数据、默认值和项目级覆盖限制；schema 变化时更新。

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyDefaults, configSchema } from '../core/config.mjs';
import { validate } from '../core/schema-check.mjs';

const EXPECTED_ITEMS = [
  'executorByDesigner',
  'warnSameAgentPair',
  'executors.<名称>.command',
  'executors.<名称>.model',
  'executors.<名称>.reasoningEffort',
  'executors.<名称>.env',
  'dsh.home',
  'dsh.profile',
  'dsh.transport',
  'dsh.autoStartWeb',
  'dsh.openBrowserOnStart',
  'dsh.webArgs',
  'dsh.agentPreset',
  'model',
  'reasoningEffort',
  'permissionPreset',
  'unattendedApproval',
  'protectedPaths',
  'allowedRoots',
  'confirmBeforeDispatch',
  'maxCorrectionRounds',
  'commitOnAccept',
  'freshReviewForRisky',
  'language',
  'idleTimeoutMinutes',
  'taskTimeoutMinutes',
  'tokenBudget',
  'env',
  'inheritEnv',
  'autoSync',
  'runRetentionDays',
];

const PROJECT_TIGHTEN = {
  protectedPaths: { strategy: 'union' },
  confirmBeforeDispatch: { strategy: 'max', order: ['never', 'risky', 'always'] },
  freshReviewForRisky: { strategy: 'only', value: true },
  commitOnAccept: { strategy: 'only', value: false },
};

const PROJECT_FORBIDDEN = [
  'permissionPreset',
  'unattendedApproval',
  'allowedRoots',
  'env',
  'inheritEnv',
  'executors.<名称>.command',
  'executors.<名称>.env',
  'dsh.home',
  'dsh.profile',
  'dsh.transport',
  'dsh.autoStartWeb',
  'dsh.openBrowserOnStart',
  'dsh.webArgs',
  'dsh.agentPreset',
  'autoSync',
  'runRetentionDays',
];

function itemNode(pathText) {
  const parts = pathText.split('.');
  let node = configSchema;
  for (const part of parts) {
    if (part === '<名称>') {
      assert.ok(node.additionalProperties, pathText + ' 缺少 additionalProperties');
      node = node.additionalProperties;
      continue;
    }
    if (node.properties && Object.prototype.hasOwnProperty.call(node.properties, part)) {
      node = node.properties[part];
      continue;
    }
    assert.ok(node.additionalProperties && typeof node.additionalProperties === 'object', pathText + ' 找不到配置项 ' + part);
    node = node.additionalProperties;
    if (node.properties && Object.prototype.hasOwnProperty.call(node.properties, part)) {
      node = node.properties[part];
      continue;
    }
    assert.fail(pathText + ' 找不到配置项 ' + part);
  }
  return node;
}

function leafItems() {
  const result = [];
  for (const [name, node] of Object.entries(configSchema.properties)) {
    if (name === 'dsh') {
      for (const child of Object.keys(node.properties)) result.push('dsh.' + child);
    } else if (name === 'executors') {
      for (const child of Object.keys(node.additionalProperties.properties)) result.push('executors.<名称>.' + child);
    } else {
      result.push(name);
    }
  }
  return result;
}

test('schema 恰好覆盖 §12.2 的配置项清单', () => {
  assert.deepEqual(leafItems().sort(), [...EXPECTED_ITEMS].sort());
});

test('每个配置项都有 type、default、x-title、x-description、x-group、x-scopes', () => {
  for (const pathText of EXPECTED_ITEMS) {
    const node = itemNode(pathText);
    assert.ok(node.type, pathText + ' 缺少 type');
    assert.ok(Object.prototype.hasOwnProperty.call(node, 'default'), pathText + ' 缺少 default');
    assert.equal(typeof node['x-title']?.zh, 'string', pathText + ' 缺少 x-title.zh');
    assert.equal(typeof node['x-title']?.en, 'string', pathText + ' 缺少 x-title.en');
    assert.equal(typeof node['x-description']?.zh, 'string', pathText + ' 缺少 x-description.zh');
    assert.equal(typeof node['x-description']?.en, 'string', pathText + ' 缺少 x-description.en');
    assert.equal(typeof node['x-group'], 'string', pathText + ' 缺少 x-group');
    assert.ok(Array.isArray(node['x-scopes']) && node['x-scopes'].length > 0, pathText + ' 缺少 x-scopes');
    for (const scope of node['x-scopes']) assert.ok(['global', 'project', 'task'].includes(scope), pathText + ' 的 x-scopes 有未知级别 ' + scope);
  }
});

test('schema 顶层 version 是整数', () => {
  assert.equal(configSchema.version, 1);
  assert.equal(Number.isInteger(configSchema.version), true);
});

test('schema 的默认值能通过 schema 自身的校验', () => {
  const defaults = applyDefaults(configSchema, {});
  const result = validate(configSchema, defaults);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  for (const pathText of EXPECTED_ITEMS) {
    const node = itemNode(pathText);
    const itemResult = validate(node, node.default);
    assert.equal(itemResult.valid, true, pathText + ' 的默认值不合法：' + JSON.stringify(itemResult.errors));
  }
});

test('4 个项目级收紧项都有 x-project-tighten 标注，且规则形状正确', () => {
  const annotated = [];
  for (const pathText of EXPECTED_ITEMS) {
    const node = itemNode(pathText);
    if (node['x-project-tighten']) annotated.push(pathText);
  }
  assert.deepEqual(annotated.sort(), Object.keys(PROJECT_TIGHTEN).sort());
  for (const [pathText, expected] of Object.entries(PROJECT_TIGHTEN)) {
    assert.deepEqual(itemNode(pathText)['x-project-tighten'], expected, pathText + ' 的收紧标注不对');
  }
  assert.match(configSchema.description, /x-project-tighten/);
});

test('决定 7 列出的项 x-scopes 不含 project，其余项允许 project', () => {
  for (const pathText of PROJECT_FORBIDDEN) {
    const node = itemNode(pathText);
    assert.ok(!node['x-scopes'].includes('project'), pathText + ' 不应允许 project');
  }
  for (const pathText of EXPECTED_ITEMS) {
    if (PROJECT_FORBIDDEN.includes(pathText)) continue;
    const node = itemNode(pathText);
    assert.ok(node['x-scopes'].includes('project'), pathText + ' 应允许 project');
  }
});
