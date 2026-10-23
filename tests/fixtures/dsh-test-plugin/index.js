// 本文件：桥接集成测试专用的 dsh 插件事务。替人应答审批、按控制文件在 dsh 内部取消会话，并报告会话的工作区和预设。

import fs from 'node:fs';
import path from 'node:path';

export const name = 'dsh-test-observer';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(temporary, file);
}

export function apply(ctx) {
  const home = process.env.DSH_HOME;
  if (!home) throw new Error('dsh-test-observer requires DSH_HOME');
  const reportFile = path.join(home, 'test-observer.json');
  const controlFile = path.join(home, 'test-control.json');
  const state = { sessions: new Map(), approvals: [] };

  ctx.inject(['agents', 'agentPresets', 'approval'], (sub) => {
    const describe = () => {
      const registry = ctx.get('workspaceRegistry');
      const workspaces = registry === undefined ? [] : registry.list().map((workspace) => ({
        id: workspace.id,
        title: workspace.title,
        path: workspace.path,
        sessionIds: [...workspace.sessionIds],
      }));
      return {
        v: 1,
        at: new Date().toISOString(),
        sessions: [...state.sessions.values()],
        workspaces,
        approvals: state.approvals,
      };
    };

    const write = () => {
      try { writeJson(reportFile, describe()); } catch { /* 测试插件不应影响 dsh。 */ }
    };

    sub.on('agent/created', ({ agent }) => {
      let preset = null;
      try { preset = sub.agentPresets.composedPreset(agent.ctx) ?? null; } catch { preset = null; }
      state.sessions.set(agent.id, {
        id: agent.id,
        cwd: agent.session.header.cwd ?? null,
        preset,
        createdAt: new Date().toISOString(),
      });
      write();
    }, { global: true });

    sub.on('approval/request', async (request) => {
      const sessionId = request.agent && request.agent.session ? request.agent.session.id : null;
      state.approvals.push({
        sessionId,
        toolName: request.toolName ?? null,
        callId: request.callId ?? null,
        reason: request.reason ?? null,
        at: new Date().toISOString(),
      });
      write();
      await new Promise((resolve) => setTimeout(resolve, 400));
      return 'allowed-once';
    }, { global: true });

    const timer = setInterval(() => {
      write();
      const control = readJson(controlFile);
      if (control === null) return;
      try {
        if (control.action === 'cancel' && typeof control.sessionId === 'string') {
          const agent = sub.agents.get(control.sessionId);
          if (agent !== undefined) agent.cancel({ kind: 'user' });
        }
      } finally {
        try { fs.rmSync(controlFile, { force: true }); } catch { /* 忽略。 */ }
      }
    }, 150);
    ctx.effect(() => () => clearInterval(timer));
    write();
  });
}
