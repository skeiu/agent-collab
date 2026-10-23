// 实验 04 的探针插件：创建三个会话，分别触发一次“批准”“拒绝”的写文件审批和一次 ask_user_question，并记录插件可见的事件与状态。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const name = 'exp-04-approval-question';

const ANSWER = 'PLUM-731';

function textOf(content) {
  return (content ?? []).map((block) => block.type === 'text' ? block.text : '').join('');
}

function clip(value, max = 500) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return null;
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out waiting for ' + label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function apply(ctx) {
  ctx.inject(['agents', 'agentPresets', 'agentDefaultModel', 'sessionProjections'], async (sub) => {
    const home = process.env.DSH_HOME;
    const logFile = path.join(home, 'exp-04.log');
    const outFile = path.join(home, 'exp-04.json');
    const errorFile = path.join(home, 'exp-04-error.json');
    const log = (message) => fs.appendFileSync(logFile, message + '\n');
    log('inject callback start');

    const records = new Map();
    const handles = [];

    sub.on('session/event', (session, event) => {
      const rec = records.get(session.id);
      if (!rec) return;
      if (event.type === 'approval/asked') {
        rec.approvalEvents.push({
          seq: event.seq,
          type: event.type,
          data: event.data,
          agentStatus: rec.agent.status,
        });
        return;
      }
      if (event.type === 'approval/decided') {
        rec.approvalEvents.push({
          seq: event.seq,
          type: event.type,
          data: event.data,
          agentStatus: rec.agent.status,
        });
        return;
      }
      if (event.type === 'tool/call') {
        if (event.data.name !== 'write' && event.data.name !== 'ask_user_question') return;
        const item = {
          seq: event.seq,
          type: event.type,
          name: event.data.name,
          callId: event.data.callId,
          arguments: clip(event.data.arguments),
        };
        if (event.data.name === 'ask_user_question') {
          try { item.questions = JSON.parse(event.data.arguments).questions; } catch { item.questions = null; }
        }
        rec.toolCalls.push(item);
        rec.toolCallIds.add(event.data.callId);
        return;
      }
      if (event.type === 'tool/result') {
        const callId = event.data.message.toolCallId;
        if (!rec.toolCallIds.has(callId)) return;
        rec.toolResults.push({
          seq: event.seq,
          type: event.type,
          callId,
          isError: event.data.message.isError === true,
          content: clip(textOf(event.data.message.content)),
          error: event.data.error === undefined ? null : event.data.error,
        });
        return;
      }
      if (event.type === 'assistant/message') {
        const text = textOf(event.data.message.content).trim();
        if (text) rec.assistantTexts.push(text);
        if (event.data.usage) rec.usages.push(event.data.usage);
        return;
      }
      if (event.type === 'turn/end') {
        rec.statusSamples.push({ at: 'turn/end', status: rec.agent.status });
      }
    }, { global: true });

    sub.on('approval/request', (request, next) => {
      const rec = records.get(request.agent?.session?.id);
      if (!rec || (rec.kind !== 'approve' && rec.kind !== 'reject')) return next();
      rec.approvalRequests.push({
        toolName: request.toolName,
        callId: request.callId ?? null,
        reason: request.reason ?? null,
        agentStatus: request.agent.status,
        decision: rec.kind === 'approve' ? 'allowed-once' : 'rejected',
      });
      return rec.kind === 'approve' ? 'allowed-once' : 'rejected';
    }, { global: true });

    sub.on('user-questions/request', (request, next) => {
      const rec = records.get(request.agent?.session?.id);
      if (!rec || rec.kind !== 'question') return next();
      const projection = sub.sessionProjections.stateOf(request.agent.session, 'userQuestions');
      const answers = request.questions.map((question) => ({ id: question.id, selected: [], custom: ANSWER }));
      rec.questionRequests.push({
        agentStatus: request.agent.status,
        wait: request.wait ?? null,
        requestKeys: Object.keys(request),
        questions: request.questions,
        projectionTimed: projection?.timed ?? null,
        projectionActive: projection?.questions?.active ?? null,
        answerReturned: answers,
      });
      return { answers };
    }, { global: true });

    const createSession = async (kind, cwd) => {
      fs.mkdirSync(cwd, { recursive: true });
      const rec = {
        kind,
        sessionId: null,
        agent: null,
        statusSamples: [],
        approvalEvents: [],
        approvalRequests: [],
        questionRequests: [],
        toolCalls: [],
        toolCallIds: new Set(),
        toolResults: [],
        assistantTexts: [],
        usages: [],
        file: null,
      };
      const handle = await sub.agents.create({
        sessionId: randomUUID(),
        meta: { cwd, agentPreset: 'standard' },
        agentOptions: sub.agentDefaultModel.currentSelection(),
        async setup(agentCtx, agent) {
          await agentCtx.get('agentPresets').mount(agentCtx, 'standard');
          agent.session.append('sandbox/mode', { mode: 'read-only' });
          agent.session.append('approval/policy', { policy: 'ask' });
          rec.agent = agent;
          rec.sessionId = agent.id;
        },
      });
      records.set(handle.agent.id, rec);
      handles.push(handle);
      return { handle, rec };
    };

    const drive = async (handle, rec, prompt, timeoutMs) => {
      handle.agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      });
      rec.statusSamples.push({ at: 'after-followup', status: handle.agent.status });
      try {
        await withTimeout(handle.agent.whenIdle(), timeoutMs, rec.kind + ' agent idle');
      } catch (error) {
        handle.agent.cancel({ kind: 'user' });
        throw error;
      }
      rec.statusSamples.push({ at: 'when-idle', status: handle.agent.status });
    };

    const approvePrompt = [
      'This is an automated experiment. Work only inside the current working directory.',
      'Use the write tool to create the file "approval-ok.txt" with the content "ok".',
      'The session file policy is read-only, so in the same write call set sandbox_permissions to "workspace-write" and set justification to "The experiment requires writing one file into the session workspace.".',
      'After the tool returns, reply with exactly one short line: WRITE_OK if the file was written, or WRITE_REJECTED if the tool returned an error.',
      'Do not call any other tool and do not retry more than once.',
    ].join('\n');
    const rejectPrompt = [
      'This is an automated experiment. Work only inside the current working directory.',
      'Use the write tool to create the file "approval-rejected.txt" with the content "should not exist".',
      'The session file policy is read-only, so in the same write call set sandbox_permissions to "workspace-write" and set justification to "The experiment requires writing one file into the session workspace.".',
      'After the tool returns, reply with exactly one short line: WRITE_OK if the file was written, or WRITE_REJECTED if the tool returned an error.',
      'Do not call any other tool and do not retry more than once.',
    ].join('\n');
    const questionPrompt = [
      'This is an automated experiment.',
      'Call the ask_user_question tool exactly once with one question: id "magic", question "What is the magic word?", and no options.',
      'When the tool returns the answer, reply with exactly "ANSWER=" followed by the custom answer text from the tool result.',
      'Do not call any other tool.',
    ].join('\n');

    try {
      await sub.get('loader')?.await();
      log('loader settled');

      const approveDir = path.join(home, 'workspaces', 'approve');
      const rejectDir = path.join(home, 'workspaces', 'reject');
      const questionDir = path.join(home, 'workspaces', 'question');

      const approve = await createSession('approve', approveDir);
      log('approve session ' + approve.rec.sessionId);
      await drive(approve.handle, approve.rec, approvePrompt, 180000);
      approve.rec.file = {
        path: 'approval-ok.txt',
        exists: fs.existsSync(path.join(approveDir, 'approval-ok.txt')),
        content: fs.existsSync(path.join(approveDir, 'approval-ok.txt')) ? fs.readFileSync(path.join(approveDir, 'approval-ok.txt'), 'utf8') : null,
      };

      const reject = await createSession('reject', rejectDir);
      log('reject session ' + reject.rec.sessionId);
      await drive(reject.handle, reject.rec, rejectPrompt, 180000);
      reject.rec.file = {
        path: 'approval-rejected.txt',
        exists: fs.existsSync(path.join(rejectDir, 'approval-rejected.txt')),
      };

      const question = await createSession('question', questionDir);
      log('question session ' + question.rec.sessionId);
      await drive(question.handle, question.rec, questionPrompt, 180000);

      const output = {
        generatedAt: new Date().toISOString(),
        modelCategory: 'a chat model behind the user gateway',
        answerToken: ANSWER,
        sessions: [approve.rec, reject.rec, question.rec].map((rec) => ({
          kind: rec.kind,
          sessionId: rec.sessionId,
          statusSamples: rec.statusSamples,
          approvalEvents: rec.approvalEvents,
          approvalRequests: rec.approvalRequests,
          questionRequests: rec.questionRequests,
          toolCalls: rec.toolCalls,
          toolResults: rec.toolResults,
          assistantTexts: rec.assistantTexts,
          usages: rec.usages,
          finalText: rec.assistantTexts.at(-1) ?? '',
          file: rec.file,
        })),
      };
      fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
      log('written result');
    } catch (error) {
      fs.writeFileSync(errorFile, JSON.stringify({ message: String(error), stack: error && error.stack }, null, 2));
      log('caught ' + String(error));
    } finally {
      for (const handle of handles.slice().reverse()) {
        await handle.dispose().catch(() => {});
      }
    }
  });
}
