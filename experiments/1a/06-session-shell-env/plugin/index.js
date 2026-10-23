// 实验 06 的探针插件：给单个 Agent 的 shellEnv 注册 DSH_AGENT_COLLAB_ROLE，并实际执行 bash 工具对比两个会话。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const name = 'exp-06-shell-env';

function textOf(result) {
  return (result.content ?? []).map((block) => block.text ?? '').join('');
}

export function apply(ctx) {
  ctx.inject(['agents', 'tools', 'shellEnv'], async (sub) => {
    const logFile = path.join(process.env.DSH_HOME, 'exp-06.log');
    const log = (message) => fs.appendFileSync(logFile, message + '\n');
    log('inject callback start');
    await sub.get('loader')?.await();
    log('loader settled');
    const base = path.join(process.env.DSH_HOME, 'shell-env-06');
    const dirA = path.join(base, 'a');
    const dirB = path.join(base, 'b');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const roleKey = 'DSH_AGENT_COLLAB_ROLE';
    let invalidKeyError;
    let handleA;
    let handleB;
    try {
      handleA = await sub.agents.create({
        sessionId: randomUUID(),
        meta: { cwd: dirA, agentPreset: 'standard' },
        async setup(agentCtx, agent) {
          log('setup A start; shellEnv=' + typeof agentCtx.get('shellEnv'));
          await agentCtx.get('agentPresets').mount(agentCtx, 'standard');
          log('preset mounted');
          agentCtx.get('shellEnv').register({
            name: 'agent-collab-' + agent.id,
            variables: { [roleKey]: { description: 'Role of the agent-collab executor session.' } },
            resolve: (execution) => execution.agent === agent ? { [roleKey]: 'executor' } : {},
          });
          try {
            agentCtx.get('shellEnv').register({
              name: 'agent-collab-invalid-' + agent.id,
              variables: { AGENT_COLLAB_ROLE: { description: 'ordinary key, should be rejected' } },
              resolve: () => ({ AGENT_COLLAB_ROLE: 'executor' }),
            });
          } catch (error) {
            invalidKeyError = String(error);
          }
        },
      });
      log('agent A created ' + (handleA && handleA.agent && handleA.agent.id));
      handleB = await sub.agents.create({
        sessionId: randomUUID(),
        meta: { cwd: dirB, agentPreset: 'standard' },
        async setup(agentCtx) {
          await agentCtx.get('agentPresets').mount(agentCtx, 'standard');
        },
      });
      log('agent B created ' + (handleB && handleB.agent && handleB.agent.id));
      const execute = async (agent, callId) => {
        log('execute start ' + callId);
        const result = await sub.tools.execute({
          callId,
          name: 'bash',
          arguments: {
            command: 'printf "%s" "${' + roleKey + '}"',
            description: 'Print the agent-collab role environment variable',
          },
          agent,
          signal: AbortSignal.timeout(60000),
        });
        return { isError: result.isError, text: textOf(result), error: result.error };
      };
      const a = await execute(handleA.agent, 'exp-06-a');
      const b = await execute(handleB.agent, 'exp-06-b');
      const result = {
        roleKey,
        agentA: { sessionId: handleA.agent.id, output: a.text.trim(), isError: a.isError, error: a.error },
        agentB: { sessionId: handleB.agent.id, output: b.text.trim(), isError: b.isError, error: b.error },
        invalidKeyError,
      };
      fs.writeFileSync(path.join(process.env.DSH_HOME, 'exp-06.json'), JSON.stringify(result, null, 2));
      log('written result');
    } catch (error) {
      fs.writeFileSync(path.join(process.env.DSH_HOME, 'exp-06-error.json'), JSON.stringify({ message: String(error), stack: error && error.stack }, null, 2));
      log('caught ' + String(error));
    } finally {
      if (handleB) await handleB.dispose().catch(() => {});
      if (handleA) await handleA.dispose().catch(() => {});
    }
  });
}
