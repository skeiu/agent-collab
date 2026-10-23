// 实验 06：给单个会话的 shell 注入环境变量，只影响这个会话；实际调用 bash 工具验证。
import fs from 'node:fs';
import path from 'node:path';
import { assert, createSandbox, enablePnpm, findDsh, installPlugin, makePlugin, readJson, startWeb, stopChild, waitFor } from '../_shared/harness.mjs';

const box = createSandbox('06');
let web;
try {
  const dsh = findDsh(box.env);
  enablePnpm(box.env, box.root);
  const tgz = makePlugin(box.root, box.env, {
    name: 'dsh-exp-06-shell-env',
    version: '1.0.0',
    main: fs.readFileSync(new URL('./plugin/index.js', import.meta.url), 'utf8'),
    patch: fs.readFileSync(new URL('./plugin/cordis.patch.yml', import.meta.url), 'utf8'),
  });
  const installed = installPlugin(box.env, dsh, 'web', tgz);
  assert(installed.status === 0, 'dsh plugin add failed: ' + installed.stderr.slice(-1000));

  web = await startWeb(box.env, dsh);
  console.log('[06] dsh web ready on port ' + web.port);
  const outFile = path.join(box.home, 'exp-06.json');
  try {
    await waitFor(() => fs.existsSync(outFile), 120000, 'exp-06.json');
  } catch (error) {
    console.log('[06] web stderr tail: ' + web.stderr().slice(-3000));
    try { console.log('[06] plugin log: ' + fs.readFileSync(path.join(box.home, 'exp-06.log'), 'utf8')); } catch {}
    try { console.log('[06] plugin error: ' + fs.readFileSync(path.join(box.home, 'exp-06-error.json'), 'utf8')); } catch {}
    throw error;
  }
  const result = readJson(outFile);

  console.log('[06] session A (' + result.agentA.sessionId + ') bash output: ' + JSON.stringify(result.agentA.output));
  console.log('[06] session B (' + result.agentB.sessionId + ') bash output: ' + JSON.stringify(result.agentB.output));
  console.log('[06] register with ordinary key rejected: ' + (result.invalidKeyError ? result.invalidKeyError.slice(0, 200) : 'NO'));
  assert(result.agentA.isError === false, 'session A bash call failed: ' + JSON.stringify(result.agentA.error));
  assert(result.agentB.isError === false, 'session B bash call failed: ' + JSON.stringify(result.agentB.error));
  assert(result.agentA.output === 'executor', 'session A did not see DSH_AGENT_COLLAB_ROLE=executor');
  assert(!result.agentB.output.includes('executor'), 'session B unexpectedly saw the role variable: ' + JSON.stringify(result.agentB.output));
  assert(result.invalidKeyError && result.invalidKeyError.includes('invalid key'), 'ordinary key AGENT_COLLAB_ROLE was not rejected');

  console.log('RESULT: 部分成立 — 可用 shellEnv.register 给单个 Agent 的 bash 会话注入变量且不影响其它会话，但键名必须在 DSH_* 命名空间（AGENT_COLLAB_ROLE 被拒绝），需改用 DSH_AGENT_COLLAB_ROLE。');
} finally {
  if (web) await stopChild(web.child);
  box.cleanup();
}
