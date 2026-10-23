// §17 第 17 项：claude -p 会话结束后，从它的 Bash 启动的工作进程能否存活。
// 两次独立调用：
//   detached：只用 detached + unref 启动工作进程（D20 方案），看 claude 退出后心跳是否继续；
//   bg-tool：只用 Bash 工具的 run_in_background 启动，看 claude -p 是否等它结束才退出。
// 用法：node run.mjs [detached|bg-tool]...；环境变量 PROBE_MODEL 可指定模型。工作进程到时自行退出，不需要手动停止。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SECONDS = 60;
// 用 PATH 上的 node，命令才能匹配 --allowedTools 的 Bash(node:*)。
const node = 'node';
const launcher = path.join(here, 'launch-detached.mjs');
const worker = path.join(here, 'worker.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const modes = {
  detached: (out) => `Use the Bash tool once to run exactly: ${node} ${launcher} ${out} detached ${SECONDS}\nThen reply DONE immediately. Do not wait for the worker.`,
  'bg-tool': (out) => `Use the Bash tool once, with its run_in_background option set to true, to run exactly: ${node} ${worker} ${out} bg-tool ${SECONDS}\nThen reply DONE immediately. Do not wait for the worker.`,
};

async function runMode(label) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-collab-1a-17-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-collab-1a-17-cwd-'));
  const count = () => {
    const f = path.join(out, label + '.hb');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
  };
  const alive = () => {
    const f = path.join(out, label + '.pid');
    if (!fs.existsSync(f)) return 'no-pid';
    try { process.kill(Number(fs.readFileSync(f, 'utf8')), 0); return 'alive'; } catch { return 'gone'; }
  };
  try {
    const args = ['-p', modes[label](out), '--permission-mode', 'default', '--allowedTools', 'Bash(node:*)',
      '--no-session-persistence', '--strict-mcp-config', '--max-budget-usd', '0.5', '--output-format', 'json'];
    if (process.env.PROBE_MODEL) args.push('--model', process.env.PROBE_MODEL);
    const started = Date.now();
    const r = spawnSync('claude', args, { cwd, encoding: 'utf8', timeout: 240000 });
    const claudeSeconds = Math.round((Date.now() - started) / 1000);
    let result = {};
    try { result = JSON.parse(r.stdout); } catch {}
    const beatsAtExit = count();
    const processAtExit = alive();
    await sleep(10000);
    const beatsLater = count();
    const summary = {
      label, claudeExit: r.status, claudeSeconds, costUsd: result.total_cost_usd,
      beatsAtClaudeExit: beatsAtExit, beats10sLater: beatsLater, processAtClaudeExit: processAtExit,
      stillBeatingAfterExit: beatsLater > beatsAtExit,
      claudeReply: String(result.result ?? '').slice(0, 160),
    };
    console.log(JSON.stringify(summary, null, 2));
    // 等工作进程自行结束后再删临时目录
    while (alive() === 'alive') await sleep(2000);
    return summary;
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(modes);
const results = [];
for (const m of selected) {
  if (!modes[m]) throw new Error('unknown mode: ' + m);
  results.push(await runMode(m));
}
const d = results.find((r) => r.label === 'detached');
if (d) {
  if (d.processAtClaudeExit === 'no-pid') console.log('RESULT: 无法判断 — detached 工作进程没有启动');
  else if (d.beatsAtClaudeExit >= SECONDS) console.log('RESULT: 无法判断 — claude 退出前工作进程已经跑完');
  else console.log('RESULT: ' + (d.stillBeatingAfterExit ? '成立' : '不成立') + ' — claude -p 退出后，detached + unref 启动的工作进程' + (d.stillBeatingAfterExit ? '仍在运行' : '没有继续运行'));
}
