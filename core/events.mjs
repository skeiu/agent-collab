// 本文件：events.jsonl 的追加与恢复、summary.json 的汇总（docs/protocol.md 第 4、5.6 节）。工作进程使用；事件或汇总字段变化时更新。

import fsp from 'node:fs/promises';
import path from 'node:path';

import { readJson } from './rundir.mjs';

/** 现在的时间：ISO 8601 UTC。 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * 事件日志：负责分配 n、at、turn，追加写入、重启后恢复最后一行。
 * 构造时读入已有事件；最后一行不完整（没有换行结尾或不是 JSON）时截掉。
 */
export class EventLog {
  constructor(file, events, options = {}) {
    this.file = file;
    this.events = events;
    this.lastN = events.reduce((max, event) => Math.max(max, Number(event.n) || 0), 0);
    this.lastCursor = null;
    for (const event of events) if (event.cursor !== undefined) this.lastCursor = event.cursor;
    this.truncated = options.truncated === true;
    this.chain = Promise.resolve();
  }

  /** 读入已有日志；必要时把不完整的尾部截掉。 */
  static async open(file) {
    let raw = '';
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    let truncated = false;
    let text = raw;
    if (text.length > 0 && !text.endsWith('\n')) {
      const cut = text.lastIndexOf('\n');
      text = cut === -1 ? '' : text.slice(0, cut + 1);
      truncated = true;
    }
    const events = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
        events.push(parsed);
      } catch {
        // 中间或结尾出现坏行：从这里往后都不要，重写文件。
        truncated = true;
        break;
      }
    }
    if (truncated) {
      const kept = events.map((event) => JSON.stringify(event)).join('\n');
      await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fsp.writeFile(file, kept.length > 0 ? kept + '\n' : '', { mode: 0o600 });
      if (process.platform !== 'win32') await fsp.chmod(file, 0o600);
    }
    return new EventLog(file, events, { truncated });
  }

  /**
   * 追加一条事件，补齐 v、n、at、turn；返回写入的事件。
   * 所有追加串行执行：运行时事件和适配器事件可能同时到达，不能算出同一个 n。
   */
  append(partial, turn) {
    const task = this.chain.then(async () => {
      // 运行时字段放在展开 partial 之后：适配器即使带了同名字段，也不能覆盖 `n`、`turn`、`at`、`v`。
      const event = {
        ...partial,
        v: 1,
        n: this.lastN + 1,
        at: nowIso(),
        turn: turn ?? 0,
      };
      await fsp.appendFile(this.file, JSON.stringify(event) + '\n', { mode: 0o600 });
      this.events.push(event);
      this.lastN = event.n;
      if (event.cursor !== undefined) this.lastCursor = event.cursor;
      return event;
    });
    this.chain = task.then(() => {}, () => {});
    return task;
  }
}

/**
 * 比较两个适配器 cursor：数字直接比大小；{ seq, sub } 先比 seq 再比 sub。
 * 无法比较时返回 null（调用方按“不重复”处理）。
 */
export function compareCursor(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return null;
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  if (typeof left === 'object' && typeof right === 'object' && 'seq' in left && 'seq' in right) {
    const leftSeq = Number(left.seq);
    const rightSeq = Number(right.seq);
    if (!Number.isFinite(leftSeq) || !Number.isFinite(rightSeq)) return null;
    if (leftSeq !== rightSeq) return leftSeq - rightSeq;
    return (Number(left.sub) || 0) - (Number(right.sub) || 0);
  }
  if (typeof left === 'string' && typeof right === 'string') return left === right ? 0 : null;
  return null;
}

/** 判断事件是否属于运行时自己写的类型（不是适配器发来的）。 */
export function isRuntimeEvent(event) {
  return event && (event.type === 'status' || event.type === 'session');
}

/**
 * 由事件流汇总 summary 的其余字段：轮次、汇报状态、审批、提问、用户插话、用量、警告。
 * report-<n>.json 存在且没有 error 字段时记 valid，有 error 记 invalid，没有文件记 missing。
 */
export async function collectRunFacts({ runDir, events, turnKinds }) {
  const turns = new Map();
  const reportStatus = new Map();
  const usages = new Map();
  const humanInputs = [];
  const approvals = new Map();
  const questions = new Map();
  const warnings = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let lastActivityAt = null;

  const turnOf = (event) => {
    const record = Number(event.turn) || 0;
    if (!turns.has(record)) {
      turns.set(record, {
        n: record,
        kind: (turnKinds && turnKinds[record]) ?? (record === 1 ? 'brief' : null),
        startedAt: event.at ?? null,
        endedAt: null,
        stopReason: null,
        endReason: null,
        stoppedBy: null,
        report: 'missing',
        reportFile: null,
        patchFile: null,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    }
    return turns.get(record);
  };

  for (const event of events) {
    if (event.type === 'usage') {
      const record = turnOf(event);
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
        const value = Number(event[key]) || 0;
        record.usage[key] = (record.usage[key] ?? 0) + value;
        usage[key] += value;
      }
      continue;
    }
    if (event.type === 'turn_end') {
      const record = turnOf(event);
      record.endedAt = event.at ?? null;
      record.stopReason = event.stopReason ?? null;
      record.endReason = event.endReason ?? null;
      record.stoppedBy = event.stoppedBy ?? null;
      lastActivityAt = event.at ?? lastActivityAt;
      continue;
    }
    if (event.type === 'human_message') {
      humanInputs.push({ at: event.at ?? null, turn: Number(event.turn) || 0, text: String(event.text ?? '') });
      lastActivityAt = event.at ?? lastActivityAt;
      continue;
    }
    if (event.type === 'approval') {
      const id = String(event.approvalId ?? '');
      if (!approvals.has(id)) {
        approvals.set(id, {
          approvalId: id,
          turn: Number(event.turn) || 0,
          toolName: event.toolName ?? null,
          reason: event.reason ?? null,
          outcome: null,
          askedAt: event.at ?? null,
          decidedAt: null,
        });
      }
      const record = approvals.get(id);
      if (event.state === 'resolved') {
        record.outcome = event.outcome ?? null;
        record.decidedAt = event.at ?? null;
      } else if (event.toolName) {
        record.toolName = event.toolName;
        record.reason = event.reason ?? record.reason;
      }
      lastActivityAt = event.at ?? lastActivityAt;
      continue;
    }
    if (event.type === 'question') {
      const id = String(event.callId ?? '');
      if (!questions.has(id)) {
        questions.set(id, {
          callId: id,
          turn: Number(event.turn) || 0,
          questions: event.questions ?? [],
          askedAt: event.at ?? null,
          resolvedAt: null,
        });
      }
      const record = questions.get(id);
      if (event.state === 'resolved') record.resolvedAt = event.at ?? null;
      lastActivityAt = event.at ?? lastActivityAt;
      continue;
    }
    if (event.type === 'warning') {
      warnings.push(String(event.message ?? ''));
      continue;
    }
    if (event.type !== 'status' && event.type !== 'session') {
      turnOf(event);
      lastActivityAt = event.at ?? lastActivityAt;
    }
  }

  // 汇报文件：report-<n>.json 有 error 字段就是提取失败。
  const reportFiles = new Map();
  for (const n of turns.keys()) {
    if (n < 1) continue;
    const file = path.join(runDir, 'report-' + n + '.json');
    const value = await readJson(file).catch(() => null);
    if (value === null) {
      reportStatus.set(n, 'missing');
    } else if (value && typeof value === 'object' && value.error) {
      reportStatus.set(n, 'invalid');
      reportFiles.set(n, file);
    } else {
      reportStatus.set(n, 'valid');
      reportFiles.set(n, file);
    }
    turns.get(n).report = reportStatus.get(n);
    turns.get(n).reportFile = reportFiles.get(n) ?? null;
    const patch = path.join(runDir, 'patch-' + n + '.diff');
    const patchExists = await fsp.access(patch).then(() => true, () => false);
    turns.get(n).patchFile = patchExists ? patch : null;
  }

  const turnList = [...turns.values()].filter((record) => record.n >= 1).sort((left, right) => left.n - right.n);
  return { turns: turnList, humanInputs, approvals: [...approvals.values()], questions: [...questions.values()], warnings, usage, lastActivityAt };
}

/**
 * 组装 summary.json 的内容（docs/protocol.md 5.6）。
 * changes 和 violations 由调用方在最后一轮结束时算出。
 */
export async function buildSummary({ runDir, events, state, changes, violations, endedAt }) {
  const facts = await collectRunFacts({ runDir, events, turnKinds: state.turnKinds ?? null });
  const createdAt = state.createdAt ?? null;
  const end = endedAt ?? nowIso();
  const createdMs = createdAt ? Date.parse(createdAt) : NaN;
  const durationMs = Number.isFinite(createdMs) ? Math.max(0, Date.parse(end) - createdMs) : null;
  // report：最近一次合法的汇报；reportError：只看最近一轮有汇报文件的那一轮（protocol.md 5.6）。
  let report = null;
  let reportError = null;
  for (const record of facts.turns) {
    if (!record.reportFile) continue;
    const value = await readJson(record.reportFile).catch(() => null);
    if (value && typeof value === 'object' && value.error) {
      reportError = value.error;
    } else if (value) {
      report = value;
      reportError = null;
    }
  }
  return {
    v: 1,
    runId: state.runId,
    status: state.status,
    statusReason: state.statusReason ?? null,
    repoRoot: state.repoRoot,
    designer: state.designer ?? null,
    executor: state.executor ?? null,
    createdAt,
    endedAt: end,
    durationMs,
    counts: state.counts,
    turns: facts.turns,
    report,
    reportError,
    changes: changes ?? { files: [], stat: '' },
    violations: violations ?? [],
    humanInputs: facts.humanInputs,
    approvals: facts.approvals,
    questions: facts.questions,
    usage: facts.usage,
    warnings: facts.warnings,
    lastActivityAt: state.lastActivityAt ?? facts.lastActivityAt ?? null,
  };
}
