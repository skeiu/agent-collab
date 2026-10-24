// 本文件：测试用的假执行端进程：在回环 TCP 上持有会话，按脚本产生统一事件、改工作区文件、执行 git 操作、模拟审批和提问、以指定的 stopReason / stoppedBy 结束，并保存完整记录、支持按位置补发。由测试启动，独立于工作进程存活。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    result[arg.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
if (!args['port-file'] || !args.script) {
  process.stderr.write('用法：fake-executor.mjs --port-file <文件> --script <脚本> [--record <记录>]\n');
  process.exit(2);
}

const script = JSON.parse(await fsp.readFile(args.script, 'utf8'));
const recordFile = args.record ?? null;
const sessionId = args['session-id'] ?? 'fake-session-1';
const ignoreCancel = script.ignoreCancel === true;
const rejectAttach = script.rejectAttach === true;
const attachNoResult = script.attachNoResult === true;

const state = {
  socket: null,
  buffer: '',
  seq: 0,
  turn: 0,
  lastTurn: 0,
  lastResult: null,
  running: null,
  cancelRequested: false,
  cwd: process.cwd(),
  records: [],
};

function send(message) {
  const socket = state.socket;
  if (!socket || socket.destroyed || !socket.writable) return;
  socket.write(JSON.stringify(message) + '\n');
}

function record(entry) {
  if (recordFile) {
    try {
      fs.appendFileSync(recordFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch {
      // 记录失败不影响测试主体。
    }
  }
}

/** 发一条统一事件：分配 cursor、写记录、发给适配器。 */
function emit(event) {
  state.seq += 1;
  const cursor = { seq: state.seq, sub: 0 };
  const entry = { turn: state.turn, cursor, event };
  state.records.push(entry);
  record(entry);
  send({ type: 'event', event, cursor, turn: state.turn });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 可被取消打断的等待。 */
async function sleepStep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!ignoreCancel && state.cancelRequested) return;
    await sleep(Math.min(10, Math.max(1, end - Date.now())));
  }
}

function resolvePath(relative) {
  return path.resolve(state.cwd, relative);
}

async function runGit(gitArgs) {
  await new Promise((resolve, reject) => {
    const child = spawn('git', gitArgs, { cwd: state.cwd, windowsHide: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('git ' + gitArgs.join(' ') + ' 退出码 ' + code))));
  });
}

async function runStep(step) {
  switch (step.kind) {
    case 'event':
      emit(step.event);
      return;
    case 'sleep':
      await sleepStep(step.ms ?? 0);
      return;
    case 'write': {
      const file = resolvePath(step.path);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, step.content ?? '', 'utf8');
      return;
    }
    case 'append': {
      const file = resolvePath(step.path);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.appendFile(file, step.content ?? '', 'utf8');
      return;
    }
    case 'delete':
      await fsp.rm(resolvePath(step.path), { force: true });
      return;
    case 'git':
      await runGit(step.args ?? []);
      return;
    case 'human_message':
      emit({ type: 'human_message', text: step.text ?? '', source: step.source ?? 'designer' });
      return;
    case 'approval': {
      const approvalId = step.approvalId ?? 'approval-1';
      const toolName = step.toolName ?? 'bash';
      const callId = step.callId ?? 'call-1';
      emit({ type: 'approval', state: 'pending', approvalId, toolName, callId, reason: step.reason ?? null });
      await sleepStep(step.holdMs ?? 0);
      emit({
        type: 'approval',
        state: 'resolved',
        approvalId,
        toolName,
        callId,
        reason: step.reason ?? null,
        outcome: step.outcome ?? 'allow',
      });
      return;
    }
    case 'question': {
      const callId = step.callId ?? 'call-1';
      emit({ type: 'question', state: 'pending', callId, questions: step.questions ?? [] });
      await sleepStep(step.holdMs ?? 0);
      emit({ type: 'question', state: 'resolved', callId, questions: step.questions ?? [] });
      return;
    }
    case 'usage':
      emit({ type: 'usage', ...(step.usage ?? {}) });
      return;
    default:
      throw new Error('未知的脚本步骤：' + String(step.kind));
  }
}

async function runTurn(index) {
  const spec = (script.turns ?? [])[index - 1] ?? { steps: [] };
  state.running = { turn: index };
  state.cancelRequested = false;
  let cancelled = false;
  for (const step of spec.steps ?? []) {
    if (!ignoreCancel && state.cancelRequested) {
      cancelled = true;
      break;
    }
    await runStep(step);
  }
  if (!ignoreCancel && state.cancelRequested) cancelled = true;
  const end = cancelled
    ? { stopReason: 'cancelled', endReason: 'cancelled', stoppedBy: null, finalText: spec.cancelledText ?? '' }
    : (spec.end ?? { stopReason: 'end_turn', endReason: null, stoppedBy: null, finalText: '' });
  // 先把 turn_end 作为一条统一事件发出去（带 cursor），再回结果；run.mjs 就不会自己补一条。
  emit({ type: 'turn_end', stopReason: end.stopReason ?? null, endReason: end.endReason ?? null, stoppedBy: end.stoppedBy ?? null });
  state.lastTurn = index;
  state.lastResult = end;
  send({ type: 'turn_end', turn: index, result: end });
  state.running = null;
  state.cancelRequested = false;
}

function replay(since) {
  if (!since || typeof since !== 'object') return;
  for (const entry of state.records ?? []) {
    const cursor = entry.cursor;
    if (cursor.seq > since.seq || (cursor.seq === since.seq && (cursor.sub ?? 0) > (since.sub ?? 0))) {
      send({ type: 'event', event: entry.event, cursor, turn: entry.turn });
    }
  }
}

async function handleCommand(command) {
  switch (command.type) {
    case 'start': {
      if (command.cwd) state.cwd = command.cwd;
      state.turn = 1;
      send({ type: 'started', sessionId, model: 'fake-model' });
      void runTurn(1);
      return;
    }
    case 'resume': {
      state.turn += 1;
      const turn = state.turn;
      send({ type: 'resumed', turn });
      void runTurn(turn);
      return;
    }
    case 'attach': {
      if (rejectAttach) {
        send({ type: 'attached', attached: false, running: false, sessionId });
        return;
      }
      if (state.running) {
        send({ type: 'attached', attached: true, running: true, sessionId, turn: state.running.turn });
        replay(command.since);
        return;
      }
      // 工作进程不在期间这一轮已经结束：先补发事件，再告诉适配器补发结束（适配器据此从事件算 TurnResult）。
      if (attachNoResult) {
        send({ type: 'attached', attached: true, running: false, sessionId, turn: state.lastTurn, noResult: true });
        return;
      }
      send({ type: 'attached', attached: true, running: false, sessionId, turn: state.lastTurn });
      replay(command.since);
      send({ type: 'replay_end', turn: state.lastTurn });
      return;
    }
    case 'cancel': {
      if (!ignoreCancel) state.cancelRequested = true;
      send({ type: 'cancel_ack' });
      return;
    }
    default:
      send({ type: 'error', message: '未知命令 ' + String(command.type) });
  }
}

const server = net.createServer((socket) => {
  state.socket = socket;
  state.buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    state.buffer += chunk;
    let index;
    while ((index = state.buffer.indexOf('\n')) !== -1) {
      const line = state.buffer.slice(0, index);
      state.buffer = state.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let command;
      try {
        command = JSON.parse(line);
      } catch {
        continue;
      }
      handleCommand(command).catch((error) => send({ type: 'error', message: error.message }));
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    if (state.socket === socket) state.socket = null;
  });
});

server.listen(0, '127.0.0.1', async () => {
  const address = server.address();
  const portFile = args['port-file'];
  const tmp = portFile + '.tmp-' + process.pid;
  await fsp.writeFile(tmp, JSON.stringify({ port: address.port }) + '\n', { mode: 0o600 });
  // 原子写入：端口文件出现时内容已经完整，读的人不会看到空文件。
  await fsp.rename(tmp, portFile);
  if (process.send) process.send({ type: 'ready', port: address.port });
});
