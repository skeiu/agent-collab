// 本文件：watch 子命令（docs/protocol.md 第 6 节）：按行打印里程碑事件，任务停下或结束后退出。显示内容和行格式变化时更新。

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findRepoRoot } from './git.mjs';
import { resolveAgentCollabHome } from './platform.mjs';
import { findRun, isSettledStatus } from './rundir.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envNumber(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function clock(at) {
  const date = at ? new Date(at) : new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

/** 工具调用的简短目标：文件路径、命令、模式等，最多 80 个字符。 */
function toolTarget(event) {
  const input = event && typeof event.input === 'object' && event.input !== null ? event.input : {};
  const candidate = input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query ?? input.url ?? '';
  const text = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > 80 ? single.slice(0, 80) + '…' : single;
}

function describe(event) {
  switch (event.type) {
    case 'status':
      return '状态 ' + String(event.from ?? '?') + ' → ' + String(event.to ?? '?') + (event.reason ? '（' + event.reason + '）' : '');
    case 'tool_call': {
      const target = toolTarget(event);
      return '工具 ' + String(event.name ?? '') + (target ? '：' + target : '');
    }
    case 'approval':
      return '审批 ' + String(event.state ?? '') + '：' + String(event.toolName ?? '') + (event.outcome ? ' → ' + event.outcome : '');
    case 'question': {
      const questions = Array.isArray(event.questions) ? event.questions : [];
      const first = questions.find((item) => item && typeof item.question === 'string');
      const text = first ? first.question : '';
      return '提问 ' + String(event.state ?? '') + (text ? '：' + text : '');
    }
    case 'human_message':
      return '用户插话：' + String(event.text ?? '');
    case 'turn_end':
      return '第 ' + String(event.turn ?? '?') + ' 轮结束：' + String(event.endReason ?? event.stopReason ?? '');
    case 'warning':
      return '警告：' + String(event.message ?? '');
    case 'error':
      return '错误：' + String(event.message ?? '') + (event.fatal ? '（致命）' : '');
    default:
      return null;
  }
}

/** watch 命令入口；返回退出码。 */
export async function watchCommand(argv, io = defaultIo()) {
  const spec = { from: { type: 'string' }, repo: { type: 'string' } };
  const options = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    let name = arg.slice(2);
    let value = null;
    const equals = name.indexOf('=');
    if (equals !== -1) {
      value = name.slice(equals + 1);
      name = name.slice(0, equals);
    }
    const definition = spec[name];
    if (!definition) {
      io.out({ ok: false, error: { code: 'usage', message: '未知参数 --' + name } });
      return 2;
    }
    if (definition.type === 'boolean') {
      options[name] = true;
      continue;
    }
    if (value === null) {
      index += 1;
      value = argv[index];
      if (value === undefined) {
        io.out({ ok: false, error: { code: 'usage', message: '--' + name + ' 缺少值' } });
        return 2;
      }
    }
    options[name] = value;
  }

  const runId = positionals[0];
  if (!runId) {
    io.out({ ok: false, error: { code: 'usage', message: 'watch 需要任务号' } });
    return 2;
  }
  const env = process.env;
  const home = resolveAgentCollabHome(env);
  const cwd = process.cwd();
  const repoRoot = options.repo ? await findRepoRoot(path.resolve(cwd, options.repo)) : await findRepoRoot(cwd);
  const located = await findRun({ home, runId, repoRoot });
  if (located.error) {
    io.out({ ok: false, error: { code: located.error.code, message: located.error.message } });
    return located.error.code === 'run_not_found' ? 4 : 1;
  }
  const runDir = located.runDir;
  const eventsFile = path.join(runDir, 'events.jsonl');
  const statePath = path.join(runDir, 'state.json');
  const from = options.from === undefined ? 1 : Number(options.from);
  if (!Number.isInteger(from) || from < 1) {
    io.out({ ok: false, error: { code: 'usage', message: '--from 需要正整数' } });
    return 2;
  }
  const pollMs = envNumber(env, 'AGENT_COLLAB_TEST_WATCH_POLL_MS', 100);
  let printed = from - 1;

  for (;;) {
    let progressed = false;
    let raw = '';
    try {
      raw = await fsp.readFile(eventsFile, 'utf8');
    } catch {
      raw = '';
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!Number.isInteger(event.n) || event.n <= printed || event.n < from) continue;
      printed = event.n;
      progressed = true;
      const text = describe(event);
      if (text === null) continue;
      io.out('[' + runId + ' ' + clock(event.at) + '] ' + text);
    }
    const state = await readStateJson(statePath);
    if (state && isSettledStatus(state.status) && !progressed && printed >= (state.lastEventN ?? 0)) return 0;
    await sleep(pollMs);
  }
}

async function readStateJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function defaultIo() {
  return {
    out(value) {
      process.stdout.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value) + '\n');
    },
    err(line) {
      process.stderr.write(String(line) + '\n');
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  watchCommand(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write((error && error.stack ? error.stack : String(error)) + '\n');
      process.exitCode = 1;
    });
}
