// 本文件：任务的后台工作进程（D20）：接上执行端、写 events.jsonl 和 state.json、每轮结束写补丁和汇报、处理重发、卡死和取消，最后写 summary.json 并释放锁。任务生命周期规则变化时更新。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from './config.mjs';
import { EventLog, buildSummary, compareCursor } from './events.mjs';
import { buildAdapterEnv, buildAdapterOptions, loadAdapter } from './executor.mjs';
import { changesBetween, checkViolations, diffTrees, snapshotWorktree } from './git.mjs';
import { isPidAlive, writePrivateFile, resolveAgentCollabHome } from './platform.mjs';
import { parseReportJson, validateReport } from './report.mjs';
import {
  isRunningStatus,
  lockFileFor,
  readJson,
  releaseLock,
  writeJson,
} from './rundir.mjs';

function nowIso() {
  return new Date().toISOString();
}

function envNumber(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function errorToReportError(error) {
  if (!error) return { kind: 'REPORT_UNKNOWN', message: '未知错误' };
  return {
    kind: typeof error.code === 'string' ? error.code : 'REPORT_INVALID',
    message: error.message ?? String(error),
  };
}

/** 重发汇报的固定消息。 */
function resendPrompt(error) {
  return [
    '上面这一轮的汇报没有通过校验，请只重发汇报。',
    '',
    '错误类型：' + error.kind,
    '错误信息：' + error.message,
    '',
    '要求：',
    '1. 不要再改代码，不要再运行会改动工作区的命令。',
    '2. 最后一条消息只输出一个 json 代码块（用三个反引号加 json 标注），内容是完整的汇报对象。',
    '3. 汇报的字段和取值按任务书的要求。',
    '',
  ].join('\n');
}

/** 跑一个任务：返回进程退出码。 */
export async function runWorker({ runDir }) {
  const statePath = path.join(runDir, 'state.json');
  const baselinePath = path.join(runDir, 'baseline.json');
  const eventsFile = path.join(runDir, 'events.jsonl');
  const logFile = path.join(runDir, 'worker.log');
  const cancelFile = path.join(runDir, 'cancel.request');

  const log = (message) => {
    try {
      fs.appendFileSync(logFile, '[' + nowIso() + '] ' + String(message) + '\n', { mode: 0o600 });
    } catch {
      // 日志写不进去不影响任务。
    }
  };

  const state = await readJson(statePath);
  if (!state) {
    log('state.json 不存在，退出');
    return 1;
  }
  const baseline = await readJson(baselinePath);
  if (!baseline) {
    log('baseline.json 不存在，退出');
    return 1;
  }

  const env = process.env;
  const home = resolveAgentCollabHome(env);
  const lockFile = lockFileFor(home, state.repoId);
  const evlog = await EventLog.open(eventsFile);
  state.lastEventN = evlog.lastN;
  if (evlog.lastCursor !== null) state.cursor = evlog.lastCursor;

  let adapter = null;
  let finalized = false;
  let cancelRequested = false;
  let cancelSent = false;
  let stalled = false;
  // 工作进程重启时以 events.jsonl 为准：这一轮如果已经写过 turn_end，就不再补一条。
  let currentTurnEndSeen = evlog.events.some((event) => event.type === 'turn_end' && Number(event.turn) === Number(state.turn));
  let lastChanges = null;
  const violations = new Map();

  const timers = [];

  /** 事件处理串行队列：适配器可能同步回调 onEvent。 */
  let queue = Promise.resolve();
  function enqueue(task) {
    queue = queue.then(task).catch((error) => log('事件处理失败：' + (error && error.stack ? error.stack : error)));
    return queue;
  }

  let injectStateWriteFailure = env.AGENT_COLLAB_TEST_STATE_WRITE_FAIL_ONCE === '1';

  async function appendEvent(partial) {
    const written = await evlog.append(partial, state.turn);
    state.lastEventN = written.n;
    return written;
  }

  async function appendWarning(message) {
    try {
      await appendEvent({ type: 'warning', message });
    } catch {
      // 事件也写不进去时只能记日志。
      log('warning 事件写入失败：' + message);
    }
  }

  async function saveState(options = {}) {
    state.updatedAt = nowIso();
    if (!options.final && injectStateWriteFailure) {
      injectStateWriteFailure = false;
      await appendWarning('注入的 state.json 写入失败（测试）');
      return;
    }
    try {
      await writeJson(statePath, state);
    } catch (error) {
      if (options.final) throw error;
      await appendWarning('state.json 写入失败：' + error.message);
    }
  }

  async function setStatus(next, reason, options = {}) {
    const from = state.status;
    state.status = next;
    state.statusReason = reason ?? null;
    if (from !== next) {
      await appendEvent({ type: 'status', from, to: next, reason: reason ?? null });
    }
    await saveState(options);
  }

  function waitingCount() {
    const waiting = state.waiting ?? { approvals: [], questions: [] };
    return (waiting.approvals?.length ?? 0) + (waiting.questions?.length ?? 0);
  }

  async function refreshStatusFromWaiting() {
    if (!isRunningStatus(state.status)) return;
    if (state.status === 'starting') return;
    const waiting = state.waiting ?? { approvals: [], questions: [] };
    const next = (waiting.approvals?.length ?? 0) > 0
      ? 'waiting_approval'
      : (waiting.questions?.length ?? 0) > 0
        ? 'waiting_question'
        : 'running';
    if (next !== state.status) {
      const reason = next === 'waiting_approval' ? '等待审批' : next === 'waiting_question' ? '等待提问答复' : null;
      await setStatus(next, reason);
    }
  }

  async function handleAdapterEvent(raw) {
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return;
    // 重新接上时适配器会从 sinceCursor 之后补发；已经写过的事件直接跳过，避免重复。
    if (raw.cursor !== undefined && evlog.lastCursor !== null) {
      const order = compareCursor(raw.cursor, evlog.lastCursor);
      if (order !== null && order <= 0) return;
    }
    const before = waitingCount();
    const waiting = state.waiting ?? (state.waiting = { approvals: [], questions: [] });
    if (raw.type === 'approval') {
      if (raw.state === 'pending' && raw.approvalId !== undefined) {
        if (!waiting.approvals.includes(raw.approvalId)) waiting.approvals.push(raw.approvalId);
      } else if (raw.state === 'resolved' && raw.approvalId !== undefined) {
        waiting.approvals = waiting.approvals.filter((id) => id !== raw.approvalId);
      }
    } else if (raw.type === 'question') {
      if (raw.state === 'pending' && raw.callId !== undefined) {
        if (!waiting.questions.includes(raw.callId)) waiting.questions.push(raw.callId);
      } else if (raw.state === 'resolved' && raw.callId !== undefined) {
        waiting.questions = waiting.questions.filter((id) => id !== raw.callId);
      }
    }

    const event = await evlog.append(raw, state.turn);
    state.lastEventN = event.n;
    state.lastActivityAt = event.at;
    if (event.cursor !== undefined) state.cursor = event.cursor;
    if (event.type === 'turn_end') currentTurnEndSeen = true;

    const after = waitingCount();
    if (before > 0 && after === 0) {
      // 等待结束，卡死计时从这一刻重新开始。
      state.lastActivityAt = nowIso();
      state.updatedAt = state.lastActivityAt;
    }
    await refreshStatusFromWaiting();
    await saveState();
  }

  function onAdapterEvent(raw) {
    enqueue(() => handleAdapterEvent(raw));
  }

  const adapterLog = (message) => log('[adapter] ' + message);

  async function requestCancel(reason) {
    if (cancelSent || !adapter) return;
    cancelSent = true;
    log('取消执行端会话（' + reason + '）');
    try {
      await adapter.cancel({ sessionId: state.executor?.sessionId ?? null });
    } catch (error) {
      log('取消执行端失败：' + (error && error.message ? error.message : String(error)));
    }
  }

  function startTimers(idleTimeoutMs, stallPollMs, cancelPollMs) {
    timers.push(setInterval(() => {
      if (!isRunningStatus(state.status)) return;
      if (state.status === 'starting') return;
      if (waitingCount() > 0) return;
      const last = Date.parse(state.lastActivityAt ?? state.updatedAt ?? state.createdAt ?? '');
      if (!Number.isFinite(last)) return;
      if (Date.now() - last > idleTimeoutMs && !stalled) {
        stalled = true;
        enqueue(async () => {
          await appendWarning('超过空闲超时 ' + idleTimeoutMs + ' 毫秒，取消本轮');
          await requestCancel('stalled');
        });
      }
    }, stallPollMs));
    timers.push(setInterval(() => {
      if (!isRunningStatus(state.status)) return;
      fsp.access(cancelFile).then(() => {
        if (cancelRequested) {
          // cancel.request 可能在适配器还没加载时就被看到：等适配器可用后补发取消。
          if (!cancelSent && adapter) enqueue(() => requestCancel('cancel'));
          return;
        }
        cancelRequested = true;
        enqueue(async () => {
          await appendWarning('收到 cancel.request，取消任务');
          await requestCancel('cancel');
        });
      }, () => {});
    }, cancelPollMs));
  }

  async function snapshotAndDiff() {
    const snapshot = await snapshotWorktree(state.repoRoot);
    const patch = await diffTrees(state.repoRoot, baseline.tree, snapshot.tree);
    const changes = await changesBetween(state.repoRoot, baseline.tree, snapshot.tree);
    const found = await checkViolations({
      repoRoot: state.repoRoot,
      baseline,
      currentTree: snapshot.tree,
      protectedPaths: state.protectedPaths ?? [],
    });
    for (const violation of found) {
      violations.set(violation.kind + ':' + (violation.path ?? ''), violation);
    }
    lastChanges = changes;
    return patch;
  }

  async function writeTurnFiles(turn, patch, reportValue, reportError) {
    await writePrivateFile(path.join(runDir, 'patch-' + turn + '.diff'), patch);
    const reportFile = path.join(runDir, 'report-' + turn + '.json');
    if (reportError) {
      await writeJson(reportFile, { v: 1, error: reportError });
    } else {
      await writeJson(reportFile, reportValue);
    }
  }

  function extractReport(finalText) {
    try {
      const value = parseReportJson(finalText);
      const result = validateReport(value);
      if (!result.valid) {
        return {
          ok: false,
          error: {
            kind: 'REPORT_SCHEMA_INVALID',
            message: '汇报不符合 schema：' + result.errors.map((item) => item.message).join('; '),
          },
        };
      }
      return { ok: true, report: value };
    } catch (error) {
      return { ok: false, error: errorToReportError(error) };
    }
  }

  /** 一轮结束：写补丁和汇报文件，按优先级决定状态；需要重发时返回新的 turn。 */
  async function finishTurn(result) {
    const turn = state.turn;
    await queue;
    const stoppedBy = result && result.stoppedBy ? result.stoppedBy : null;
    if (!currentTurnEndSeen) {
      await appendEvent({
        type: 'turn_end',
        stopReason: result?.stopReason ?? null,
        endReason: result?.endReason ?? null,
        stoppedBy,
      });
    }
    const patch = await snapshotAndDiff();
    const extracted = extractReport(result && result.finalText ? result.finalText : '');
    await writeTurnFiles(turn, patch, extracted.report, extracted.ok ? null : extracted.error);

    if (cancelRequested) {
      await finalize('cancelled', '设计端要求取消');
      return null;
    }
    if (stoppedBy === 'human') {
      await finalize('stopped_by_human', '用户在 dsh Web 里停止了任务');
      return null;
    }
    if (stalled) {
      await finalize('stalled', '超过空闲超时');
      return null;
    }
    if (extracted.ok) {
      await finalize(extracted.report.status, null);
      return null;
    }
    if (state.turnKind !== 'resend') {
      const next = turn + 1;
      state.turn = next;
      state.turnKind = 'resend';
      state.turnKinds = { ...(state.turnKinds ?? {}), [next]: 'resend' };
      state.counts = { correction: 0, answer: 0, resend: 0, ...(state.counts ?? {}) };
      state.counts.resend = (state.counts.resend ?? 0) + 1;
      const message = resendPrompt(extracted.error);
      await writePrivateFile(path.join(runDir, 'prompt-' + next + '.md'), message);
      state.lastActivityAt = nowIso();
      await setStatus('running', '要求重发汇报');
      currentTurnEndSeen = false;
      const resumed = await adapter.resume({ sessionId: state.executor.sessionId, message });
      return resumed && resumed.turn ? resumed.turn : null;
    }
    await finalize('report_invalid', extracted.error.message);
    return null;
  }

  async function finalize(status, reason) {
    if (finalized) return;
    finalized = true;
    for (const timer of timers) clearInterval(timer);
    await queue;
    const endedAt = nowIso();
    await setStatus(status, reason);
    state.endedAt = endedAt;
    state.worker = null;
    await saveState({ final: true });
    const summary = await buildSummary({
      runDir,
      events: evlog.events,
      state,
      changes: lastChanges,
      violations: [...violations.values()],
      endedAt,
    });
    await writeJson(path.join(runDir, 'summary.json'), summary);
    await releaseLock(lockFile, state.runId);
    log('任务结束：' + status + (reason ? '（' + reason + '）' : ''));
    if (adapter) {
      try {
        await adapter.close();
      } catch (error) {
        log('关闭适配器失败：' + (error && error.message ? error.message : String(error)));
      }
    }
  }

  async function drive() {
    // 已经有一个活着的工作进程时直接退出，避免两个进程同时写同一份运行目录。
    const existingPid = state.worker && state.worker.pid;
    if (Number.isInteger(existingPid) && existingPid !== process.pid && isPidAlive(existingPid)) {
      log('已有工作进程 ' + existingPid + ' 在跑，本进程退出');
      return;
    }
    state.worker = { pid: process.pid, startedAt: nowIso() };
    await saveState();

    const { config } = await loadConfig({ repoDir: state.repoRoot, taskConfig: state.taskConfig ?? {}, env });
    const executorName = state.executor?.name;
    const options = buildAdapterOptions(config, executorName);
    const adapterEnv = buildAdapterEnv(config, executorName);
    const idleTimeoutMs = envNumber(env, 'AGENT_COLLAB_TEST_IDLE_TIMEOUT_MS', Number(config.idleTimeoutMinutes ?? 15) * 60000);
    const stallPollMs = envNumber(env, 'AGENT_COLLAB_TEST_STALL_POLL_MS', 5000);
    const cancelPollMs = envNumber(env, 'AGENT_COLLAB_TEST_CANCEL_POLL_MS', 500);

    adapter = await loadAdapter(executorName, { config, onEvent: onAdapterEvent, log: adapterLog, env });
    log('工作进程启动，pid ' + process.pid + '，任务 ' + state.runId + '，状态 ' + state.status);
    startTimers(idleTimeoutMs, stallPollMs, cancelPollMs);

    let turnPromise = null;
    if (!state.executor.sessionId) {
      const brief = await fsp.readFile(path.join(runDir, 'brief.md'), 'utf8');
      await setStatus('running', '启动执行端');
      const started = await adapter.start({
        cwd: state.repoRoot,
        runId: state.runId,
        title: state.title ?? null,
        brief,
        images: state.images ?? [],
        options,
        env: adapterEnv,
      });
      state.executor = {
        ...state.executor,
        sessionId: started?.sessionId ?? null,
        transport: started?.transport ?? null,
        model: started?.model ?? null,
        agentPreset: state.executor?.agentPreset ?? options.agentPreset ?? null,
      };
      await queue;
      // 适配器自己发了 session 事件就不再补，避免同一件事写两条。
      const sessionSeen = evlog.events.some((event) => event.type === 'session' && event.turn === state.turn);
      if (!sessionSeen) {
        await appendEvent({
          type: 'session',
          sessionId: state.executor.sessionId,
          executor: state.executor.name,
          transport: state.executor.transport,
          model: state.executor.model,
          agentPreset: state.executor.agentPreset,
          permission: options.permissionPreset ?? null,
        });
      }
      await saveState();
      turnPromise = started?.turn ?? null;
    } else if (state.status === 'starting') {
      const promptFile = path.join(runDir, 'prompt-' + state.turn + '.md');
      const message = await fsp.readFile(promptFile, 'utf8');
      await setStatus('running', '续接第 ' + state.turn + ' 轮');
      const resumed = await adapter.resume({ sessionId: state.executor.sessionId, message });
      turnPromise = resumed?.turn ?? null;
    } else if (isRunningStatus(state.status)) {
      const attached = await adapter.attach({ sessionId: state.executor.sessionId, sinceCursor: state.cursor });
      if (!attached || attached.attached !== true) {
        await finalize('failed', 'worker_lost');
        return;
      }
      if (attached.running === true && attached.turn) {
        await setStatus('running', '工作进程重新接上');
        turnPromise = attached.turn;
      } else if (attached.result) {
        // 工作进程不在期间这一轮已经结束：适配器先补发了事件、再带回 TurnResult，按正常的一轮结束处理。
        await queue;
        turnPromise = Promise.resolve(attached.result);
      } else {
        await finalize('failed', 'worker_lost');
        return;
      }
    } else {
      log('任务状态为 ' + state.status + '，不需要工作进程');
      return;
    }

    if (!turnPromise) {
      await finalize('failed', 'executor_error');
      return;
    }

    for (;;) {
      let result;
      try {
        result = await turnPromise;
      } catch (error) {
        log('等待本轮结束失败：' + (error && error.stack ? error.stack : String(error)));
        await finalize('failed', 'executor_error');
        return;
      }
      const nextTurn = await finishTurn(result ?? {});
      if (!nextTurn) return;
      turnPromise = nextTurn;
    }
  }

  try {
    await drive();
    return 0;
  } catch (error) {
    log('工作进程异常：' + (error && error.stack ? error.stack : String(error)));
    try {
      await finalize('failed', 'executor_error');
    } catch (finalizeError) {
      log('收尾失败：' + (finalizeError && finalizeError.stack ? finalizeError.stack : String(finalizeError)));
    }
    return 1;
  } finally {
    for (const timer of timers) clearInterval(timer);
    if (adapter && !finalized) {
      try {
        await adapter.close();
      } catch {
        // 忽略关闭失败。
      }
    }
  }
}
