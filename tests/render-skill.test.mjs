// 本文件：render-skill 的规则测试和生成物检查。渲染规则、模板占位符或插件清单变化时更新。

import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseHost, renderSkill } from '../core/render-skill.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templateFile = path.join(repoRoot, 'skills', 'collab', 'SKILL.template.md');
const hostFile = path.join(repoRoot, 'skills', 'collab', 'hosts', 'claude.md');
const skillFile = path.join(repoRoot, 'skills', 'collab', 'SKILL.md');

const hostSource = '---\n' +
  'x: X\n' +
  '---\n' +
  '\n' +
  '<!-- slot: body -->\n' +
  'B\n';

const templateSource = '---\n' +
  'name: test\n' +
  'value: {{var.x}}\n' +
  '---\n' +
  '\n' +
  '{{slot.body}}\n';

function assertRenderError(fn, pattern) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, 'render_error');
    assert.match(error.message, pattern);
    return true;
  });
}

test('变量和槽替换到 frontmatter 与正文，并插入生成说明', () => {
  const result = renderSkill({ template: templateSource, host: hostSource, hostName: 'demo' });
  assert.match(result, /^---\nname: test\nvalue: X\n---\n/);
  assert.match(result, /<!-- 本文件由 core\/render-skill\.mjs 从 SKILL\.template\.md 和 hosts\/demo\.md 生成，不要直接修改；改了模板后运行 npm run build。 -->\n\nB\n$/);
  assert.equal(result.endsWith('\n'), true);
  assert.equal(result.endsWith('\n\n'), false);
});

test('替换只做一遍：替换进来的文字里的占位符不再展开', () => {
  const host = '---\n' +
    'x: {{var.y}}\n' +
    'y: Y\n' +
    '---\n' +
    '<!-- slot: body -->\n' +
    'slot {{slot.other}}\n' +
    '<!-- slot: other -->\n' +
    'OTHER\n';
  const template = '---\n' +
    'value: {{var.x}} / {{var.y}}\n' +
    '---\n' +
    '{{slot.body}} / {{slot.other}}\n';
  const result = renderSkill({ template, host, hostName: 'demo' });
  assert.match(result, /value: \{\{var\.y\}\} \/ Y/);
  assert.match(result, /slot \{\{slot\.other\}\} \/ OTHER/);
});

test('未知变量、未知槽、未用变量、未用槽都报 render_error', () => {
  assertRenderError(
    () => renderSkill({ template: templateSource.replace('{{var.x}}', '{{var.missing}}'), host: hostSource, hostName: 'demo' }),
    /模板第 3 行.*没有的变量.*\{\{var\.missing\}\}/,
  );
  assertRenderError(
    () => renderSkill({ template: templateSource.replace('{{slot.body}}', '{{slot.missing}}'), host: hostSource, hostName: 'demo' }),
    /模板第 6 行.*没有的槽.*\{\{slot\.missing\}\}/,
  );
  assertRenderError(
    () => renderSkill({ template: templateSource.replace('{{var.x}}', 'fixed'), host: hostSource, hostName: 'demo' }),
    /host 第 2 行.*变量 x 在模板里没有被用到/,
  );
  assertRenderError(
    () => renderSkill({ template: templateSource.replace('{{slot.body}}', 'fixed'), host: hostSource, hostName: 'demo' }),
    /host 第 5 行.*槽 body 在模板里没有被用到/,
  );
});

test('其他形式的 {{…}} 报 render_error', () => {
  assertRenderError(
    () => renderSkill({ template: templateSource.replace('{{var.x}}', '{{ var.x }}'), host: hostSource, hostName: 'demo' }),
    /模板第 3 行.*不支持的占位符/,
  );
  assertRenderError(
    () => renderSkill({ template: templateSource.replace('{{var.x}}', '{{env.x}}'), host: hostSource, hostName: 'demo' }),
    /模板第 3 行.*不支持的占位符/,
  );
  assertRenderError(
    () => renderSkill({ template: templateSource.replace('{{var.x}}', '{{var.x'), host: hostSource, hostName: 'demo' }),
    /模板第 3 行.*缺少 }}/,
  );
});

test('重复键、重复槽、变量区和第一个槽之间非空行都报 render_error', () => {
  const duplicateKey = hostSource.replace('x: X\n', 'x: X\nx: Y\n');
  assertRenderError(
    () => renderSkill({ template: templateSource, host: duplicateKey, hostName: 'demo' }),
    /host 第 3 行.*变量键 x 重复/,
  );
  const duplicateSlot = hostSource.replace('<!-- slot: body -->', '<!-- slot: body -->\nold\n<!-- slot: body -->');
  assertRenderError(
    () => renderSkill({ template: templateSource, host: duplicateSlot, hostName: 'demo' }),
    /host 第 7 行.*槽名 body 重复/,
  );
  const nonBlank = hostSource.replace('\n<!-- slot: body -->', '\nnot blank\n<!-- slot: body -->');
  assertRenderError(
    () => renderSkill({ template: templateSource, host: nonBlank, hostName: 'demo' }),
    /host 第 5 行.*变量区和第一个槽之间只能有空行/,
  );
});

test('模板没有 frontmatter 和 lang 不是 zh 都报 render_error', () => {
  assertRenderError(
    () => renderSkill({ template: '# no frontmatter\n', host: hostSource, hostName: 'demo' }),
    /模板第 1 行.*frontmatter/,
  );
  assertRenderError(
    () => renderSkill({ template: templateSource, host: hostSource, hostName: 'demo', lang: 'en' }),
    /lang 只支持 zh/,
  );
});

test('CRLF 输入得到只有 LF 且以一个换行结尾的输出', () => {
  const result = renderSkill({
    template: templateSource.replace(/\n/g, '\r\n'),
    host: hostSource.replace(/\n/g, '\r\n'),
    hostName: 'demo',
  });
  assert.equal(result.includes('\r'), false);
  assert.equal(result.endsWith('\n'), true);
  assert.equal(result.endsWith('\n\n'), false);
});

test('parseHost 按原文保留值，并去掉槽内容的首尾空行', () => {
  const parsed = parseHost('---\nkey: a: b  \n---\n\n<!-- slot: body -->\n\nline\n\n');
  assert.deepEqual(parsed, {
    variables: { key: 'a: b  ' },
    slots: { body: 'line' },
  });
});

test('仓库里的 SKILL.md 与模板渲染结果完全一致', async () => {
  const template = await readFile(templateFile, 'utf8');
  const host = await readFile(hostFile, 'utf8');
  const expected = renderSkill({ template, host, hostName: 'claude' });
  const actual = await readFile(skillFile, 'utf8');
  assert.equal(actual, expected, 'skills/collab/SKILL.md 过期，请运行 npm run build');
});

test('渲染出的 SKILL.md frontmatter 和引用文件符合要求', async () => {
  const template = await readFile(templateFile, 'utf8');
  const host = await readFile(hostFile, 'utf8');
  const rendered = renderSkill({ template, host, hostName: 'claude' });
  assert.match(rendered, /^---\n/);
  assert.match(rendered, /^name: collab$/m);
  assert.match(rendered, /^disable-model-invocation: true$/m);
  assert.equal(rendered.includes('{{'), false);
  const allowed = rendered.match(/^allowed-tools: (.*)$/m);
  assert.ok(allowed);
  assert.equal(allowed[1], 'Bash(node "${CLAUDE_PLUGIN_ROOT}/bin/collab.mjs":*)');
  await stat(path.join(repoRoot, 'skills', 'collab', 'references', 'brief-template.md'));
  await stat(path.join(repoRoot, 'skills', 'collab', 'references', 'correction-template.md'));
});

test('.claude-plugin/plugin.json 是合法清单且版本与 package.json 一致', async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'agent-collab');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.repository, 'https://github.com/skeiu/agent-collab');
  assert.equal(typeof manifest.description, 'string');
  assert.ok(manifest.description.length > 0);
  assert.equal('commands' in manifest, false);
  assert.equal('hooks' in manifest, false);
});
