// 实验 01：能否在 bundle 补丁里基于 standard 派生一个去掉 tool-ask-user 的工具预设。
import fs from 'node:fs';
import path from 'node:path';
import { assert, createSandbox, enablePnpm, findDsh, installPlugin, makePlugin, packageRootOfDsh, readJson, startWeb, stopChild, waitFor } from '../_shared/harness.mjs';

function stripToolAskUser(content) {
  const lines = content.split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/^- id: tool-ask-user\s*$/.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^- id: /.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n+$/, '');
}

const box = createSandbox('01');
let web;
try {
  const dsh = findDsh(box.env);
  enablePnpm(box.env, box.root);
  const tgz = makePlugin(box.root, box.env, {
    name: 'dsh-exp-01-preset',
    version: '1.0.0',
    main: fs.readFileSync(new URL('./plugin/index.js', import.meta.url), 'utf8'),
    patch: fs.readFileSync(new URL('./plugin/cordis.patch.yml', import.meta.url), 'utf8'),
  });
  const installed = installPlugin(box.env, dsh, 'web', tgz);
  assert(installed.status === 0, 'dsh plugin add failed: ' + installed.stderr.slice(-1200));

  web = await startWeb(box.env, dsh);
  console.log('[01] dsh web ready on port ' + web.port);
  const outFile = path.join(box.home, 'exp-01.json');
  await waitFor(() => fs.existsSync(outFile), 60000, 'exp-01.json');
  const result = readJson(outFile);

  const rows = result.list.map((row) => row.id);
  console.log('[01] presets: ' + rows.join(', '));
  const created = result.list.find((row) => row.id === 'agent-collab');
  assert(created, 'agent-collab preset was not registered');
  assert(created.broken === undefined, 'agent-collab preset is broken: ' + created.broken);
  const standardText = result.standard.content;
  const derivedText = result.derived.content;
  assert(standardText.includes("@deepseek-ai/dsh-tool-ask-user"), 'standard no longer contains tool-ask-user');
  assert(!derivedText.includes("@deepseek-ai/dsh-tool-ask-user"), 'agent-collab still contains tool-ask-user');
  const normalized = stripToolAskUser(standardText);
  assert(normalized === derivedText.replace(/\n+$/, ''), 'agent-collab differs from standard beyond the removed tool-ask-user row');
  console.log('[01] copied preset matches standard after removing tool-ask-user (normalized text equal)');

  const patchWarnings = web.stderr().split('\n').filter((line) => line.includes('patch'));
  console.log('[01] patch-layer warnings: ' + (patchWarnings.length ? patchWarnings.join(' | ') : '(none)'));
  assert(standardText.includes("@deepseek-ai/dsh-tool-ask-user"), 'nested id override unexpectedly changed standard');
  const presetSource = fs.readFileSync(path.join(packageRootOfDsh(dsh), 'node_modules', '@deepseek-ai', 'dsh-agent-preset', 'lib', 'index.js'), 'utf8');
  const includeSource = fs.readFileSync(path.join(packageRootOfDsh(dsh), 'node_modules', '@deepseek-ai', 'cordis-plugin-include', 'lib', 'index.js'), 'utf8');
  assert(presetSource.includes('plugins: z.array(z.any()).required()'), 'agent-preset schema no longer requires an explicit plugins array');
  assert(!presetSource.includes('extends'), 'agent-preset now has an extends-like option; re-check derivation');
  assert(includeSource.includes('if (entry.group && Array.isArray(entry.config)) buildMap(entry.config);'), 'loader patch no longer limits nested id matching to raw group rows');
  console.log('[01] source: agent-preset has no extends; include patch only descends into raw group rows; standard is unchanged');

  console.log('RESULT: 不成立 — 补丁层没有基于 standard 派生的语法：agent-preset 没有 extends/继承字段，loader patch 只对顶层或原始 group 行匹配嵌套 id，而 preset-standard 不是 group；两种派生尝试都没有改变 standard。整份复制可以工作，复制出的 agent-collab 与 standard 除 tool-ask-user 外一致。');
} finally {
  if (web) await stopChild(web.child);
  box.cleanup();
}
