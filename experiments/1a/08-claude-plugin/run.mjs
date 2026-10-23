// §17 第 8、16 项：用 claude -p --plugin-dir 临时加载测试插件，观察命令前缀、${CLAUDE_PLUGIN_ROOT} 替换、
// SessionStart hook、Monitor 工具，以及 skill 的 allowed-tools 能否在 default 权限模式下放行 Bash。
// 用法：node run.mjs [用例名...]；不给用例名时全部运行。环境变量 PROBE_MODEL 可指定模型。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, 'plugin');

const cases = {
  init: { prompt: 'Reply with exactly: OK' },
  'short-name': { prompt: '/probe-cmd' },
  'prefixed-name': { prompt: '/agent-collab:probe-cmd' },
  'preexec-echo': { prompt: '/agent-collab:probe-echo' },
  'skill-allowed': { prompt: '/agent-collab:probe-allowed' },
  'skill-plain': { prompt: '/agent-collab:probe-plain' },
  'skill-narrow': { prompt: '/agent-collab:probe-narrow' },
};

function runCase(name, prompt) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-collab-1a-08-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-collab-1a-08-cwd-'));
  const args = [
    '-p', prompt,
    '--plugin-dir', pluginDir,
    '--permission-mode', 'default',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--max-budget-usd', '0.5',
    '--output-format', 'stream-json',
    '--verbose',
  ];
  if (process.env.PROBE_MODEL) args.push('--model', process.env.PROBE_MODEL);
  try {
    const r = spawnSync('claude', args, {
      cwd,
      env: { ...process.env, PROBE_OUT: out },
      encoding: 'utf8',
      timeout: 240000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const events = (r.stdout ?? '').split('\n').filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
    const init = events.find((e) => e.type === 'system' && e.subtype === 'init') ?? {};
    const result = events.find((e) => e.type === 'result') ?? {};
    const hookEvents = events.filter((e) => e.type === 'system' && /hook/i.test(e.subtype ?? ''));
    const markersFile = path.join(out, 'markers.jsonl');
    const markers = fs.existsSync(markersFile)
      ? fs.readFileSync(markersFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return {
      name,
      exit: r.status,
      stderrTail: (r.stderr ?? '').slice(-400),
      pluginCommands: (init.slash_commands ?? []).filter((c) => /probe|agent-collab/.test(c)),
      pluginSkills: (init.skills ?? []).filter((s) => /probe|agent-collab/.test(typeof s === 'string' ? s : JSON.stringify(s))),
      plugins: init.plugins,
      hasMonitor: Array.isArray(init.tools) ? init.tools.includes('Monitor') : undefined,
      hookEvents: hookEvents.map((e) => ({ subtype: e.subtype, name: e.hook_name ?? e.hook_event_name, output: String(e.stdout ?? e.output ?? '').slice(0, 200) })),
      markers: markers.map((m) => ({ tag: m.tag, pluginRootEnv: m.pluginRootEnv })),
      resultText: String(result.result ?? '').slice(0, 600),
      isError: result.is_error,
      permissionDenials: (result.permission_denials ?? []).map((d) => ({ tool: d.tool_name, input: JSON.stringify(d.tool_input ?? {}).slice(0, 200) })),
      costUsd: result.total_cost_usd,
    };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(cases);
let total = 0;
for (const name of selected) {
  const c = cases[name];
  if (!c) throw new Error('unknown case: ' + name);
  const res = runCase(name, c.prompt);
  total += res.costUsd ?? 0;
  console.log(JSON.stringify(res, null, 2));
}
console.log('TOTAL_COST_USD ' + total.toFixed(4));
