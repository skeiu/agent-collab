// 实验 02：列出 agentPresets 的预设 id，并取 mount 签名，与 dsh 源码对照。
import fs from 'node:fs';
import path from 'node:path';
import { assert, createSandbox, enablePnpm, findDsh, installPlugin, makePlugin, packageRootOfDsh, readJson, startWeb, stopChild, waitFor } from '../_shared/harness.mjs';

const box = createSandbox('02');
let web;
try {
  const dsh = findDsh(box.env);
  enablePnpm(box.env, box.root);
  const tgz = makePlugin(box.root, box.env, {
    name: 'dsh-exp-02-presets',
    version: '1.0.0',
    main: fs.readFileSync(new URL('./plugin/index.js', import.meta.url), 'utf8'),
    patch: fs.readFileSync(new URL('./plugin/cordis.patch.yml', import.meta.url), 'utf8'),
  });
  const installed = installPlugin(box.env, dsh, 'web', tgz);
  assert(installed.status === 0, 'dsh plugin add failed: ' + installed.stderr.slice(-1000));

  web = await startWeb(box.env, dsh);
  console.log('[02] dsh web ready on port ' + web.port);
  const outFile = path.join(box.home, 'exp-02.json');
  await waitFor(() => fs.existsSync(outFile), 60000, 'exp-02.json');
  const result = readJson(outFile);

  const ids = result.list.map((row) => row.id);
  console.log('[02] preset ids: ' + ids.join(', '));
  for (const row of result.list) {
    assert(row.broken === undefined, 'preset ' + row.id + ' is broken: ' + row.broken);
  }
  for (const expected of ['standard', 'minimal', 'cordis']) {
    assert(ids.includes(expected), 'missing preset ' + expected);
  }
  assert(result.mount.type === 'function', 'mount is not a function');
  assert(result.mount.length === 2, 'mount should take (ctx, id), got arity ' + result.mount.length);
  assert(result.mount.prototypeText.includes('async mount(ctx, id)'), 'mount source does not match async mount(ctx, id): ' + result.mount.prototypeText.slice(0, 300));

  const sourceFile = path.join(packageRootOfDsh(dsh), 'node_modules', '@deepseek-ai', 'dsh-agent-preset-registry', 'lib', 'index.js');
  const source = fs.readFileSync(sourceFile, 'utf8');
  assert(source.includes('async mount(ctx, id)'), 'source no longer declares async mount(ctx, id)');
  console.log('[02] source check: dsh-agent-preset-registry/lib/index.js contains "async mount(ctx, id)"');
  console.log('[02] mount arity=' + result.mount.length + ', returns { id: generation.mount.presetId } per source');

  console.log('RESULT: 成立 — agentPresets 提供 ' + ids.length + ' 个预设（' + ids.join('、') + '），mount(ctx, id) 为两参数异步方法，返回 { id }。');
} finally {
  if (web) await stopChild(web.child);
  box.cleanup();
}
