// 实验 07：dsh Web 运行中安装和更新 bundle 插件，验证是否热重载。
import fs from 'node:fs';
import path from 'node:path';
import { assert, createSandbox, enablePnpm, findDsh, installPlugin, makePlugin, runDsh, startWeb, stopChild, waitFor } from '../_shared/harness.mjs';

function pluginMain(version) {
  return `import fs from 'node:fs';
import path from 'node:path';

export const name = 'exp-07-hot';

export function apply() {
  fs.appendFileSync(path.join(process.env.DSH_HOME, 'exp-07.log'), 'apply ${version} ' + process.pid + ' ' + Date.now() + '\\n');
  if ('${version}' === '1.0.1') fs.writeFileSync(path.join(process.env.DSH_HOME, 'exp-07-v2.txt'), 'v2 behavior\\n');
}
`;
}

function logText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

const box = createSandbox('07');
let web;
try {
  const dsh = findDsh(box.env);
  enablePnpm(box.env, box.root);
  // 先建立一个没有插件的 web profile。
  const init = runDsh(box.env, dsh, ['--profile', 'web', '--dump-config'], { timeoutMs: 60000 });
  assert(init.status === 0, 'could not initialize web profile: ' + init.stderr.slice(-1000));

  const patch = fs.readFileSync(new URL('./plugin/cordis.patch.yml', import.meta.url), 'utf8');
  const v1 = makePlugin(box.root, box.env, { name: 'dsh-exp-07-hot', version: '1.0.0', main: pluginMain('1.0.0'), patch });
  const v2 = makePlugin(box.root, box.env, { name: 'dsh-exp-07-hot', version: '1.0.1', main: pluginMain('1.0.1'), patch });
  const logFile = path.join(box.home, 'exp-07.log');
  const v2File = path.join(box.home, 'exp-07-v2.txt');

  web = await startWeb(box.env, dsh);
  const pid1 = web.child.pid;
  console.log('[07] web started, pid=' + pid1);

  let install = installPlugin(box.env, dsh, 'web', v1);
  assert(install.status === 0, 'installing v1 failed: ' + install.stderr.slice(-1000));
  let installHot = false;
  try {
    await waitFor(() => logText(logFile).includes('apply 1.0.0'), 30000, 'v1 apply after install');
    installHot = logText(logFile).includes('apply 1.0.0');
  } catch {}
  console.log('[07] install while running -> hot loaded: ' + installHot + ' (log: ' + JSON.stringify(logText(logFile).trim()) + ')');

  if (!installHot) {
    await stopChild(web.child);
    web = await startWeb(box.env, dsh);
    await waitFor(() => logText(logFile).includes('apply 1.0.0'), 30000, 'v1 apply after restart');
    console.log('[07] v1 appeared only after restart');
  }

  const update = installPlugin(box.env, dsh, 'web', v2);
  assert(update.status === 0, 'installing v2 failed: ' + update.stderr.slice(-1000));
  let updateHot = false;
  try {
    await waitFor(() => logText(logFile).includes('apply 1.0.1'), 30000, 'v2 apply after update');
    updateHot = logText(logFile).includes('apply 1.0.1');
  } catch {}
  console.log('[07] update while running -> hot loaded: ' + updateHot + ' (log: ' + JSON.stringify(logText(logFile).trim()) + ')');

  let updateAfterRestart = false;
  if (!updateHot) {
    await stopChild(web.child);
    web = await startWeb(box.env, dsh);
    await waitFor(() => logText(logFile).includes('apply 1.0.1'), 30000, 'v2 apply after restart');
    updateAfterRestart = logText(logFile).includes('apply 1.0.1') && fs.existsSync(v2File);
    console.log('[07] v2 appeared only after restart; v2 behavior file exists: ' + fs.existsSync(v2File));
  }

  if (installHot && updateHot) {
    console.log('RESULT: 成立 — 运行中的 dsh Web 对新装 bundle 和同包更新都能热重载，不重启即生效。');
  } else if (!installHot && !updateHot && updateAfterRestart) {
    console.log('RESULT: 不成立 — 运行中的 dsh Web 安装和更新 bundle 插件都需要重启才生效。');
  } else {
    console.log('RESULT: 部分成立 — 新装 bundle ' + (installHot ? '可热加载' : '需重启') + '；同包更新' + (updateHot ? '可热更新' : '需重启') + '。');
  }
} finally {
  if (web) await stopChild(web.child);
  box.cleanup();
}
