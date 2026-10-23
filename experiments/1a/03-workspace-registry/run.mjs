// 实验 03：workspaceRegistry.create 对已有路径是复用还是报错，以及 attachSession 是否可用。
import fs from 'node:fs';
import path from 'node:path';
import { assert, createSandbox, enablePnpm, findDsh, installPlugin, makePlugin, readJson, startWeb, stopChild, waitFor } from '../_shared/harness.mjs';

const box = createSandbox('03');
let web;
try {
  const dsh = findDsh(box.env);
  enablePnpm(box.env, box.root);
  const tgz = makePlugin(box.root, box.env, {
    name: 'dsh-exp-03-workspace',
    version: '1.0.0',
    main: fs.readFileSync(new URL('./plugin/index.js', import.meta.url), 'utf8'),
    patch: fs.readFileSync(new URL('./plugin/cordis.patch.yml', import.meta.url), 'utf8'),
  });
  const installed = installPlugin(box.env, dsh, 'web', tgz);
  assert(installed.status === 0, 'dsh plugin add failed: ' + installed.stderr.slice(-1000));

  web = await startWeb(box.env, dsh);
  console.log('[03] dsh web ready on port ' + web.port);
  const outFile = path.join(box.home, 'exp-03.json');
  await waitFor(() => fs.existsSync(outFile), 60000, 'exp-03.json');
  const result = readJson(outFile);

  console.log('[03] first create: id=' + result.first.id + ', title=' + result.first.title);
  console.log('[03] second create: id=' + result.second.id + ', title=' + result.second.title);
  assert(result.first.id === result.second.id, 'create on an existing path returned a different workspace');
  assert(result.second.title === 'First title', 'create on an existing path changed the title to ' + result.second.title);
  assert(result.listCount === 1, 'workspace list should contain one entry, got ' + result.listCount);
  assert(result.attachSessionType === 'function', 'attachSession is not a function');
  assert(result.attachError === undefined, 'attachSession failed: ' + result.attachError);
  assert(result.sessionIds.includes(result.sessionId), 'attached session id is not in sessionIds');

  console.log('RESULT: 成立 — 对已有路径调用 create 复用同一个 workspace（id 相同、标题不变、列表仍为 1 条）；workspace 实体的 attachSession(sessionId) 可用，会话 cwd 匹配后挂入。');
} finally {
  if (web) await stopChild(web.child);
  box.cleanup();
}
