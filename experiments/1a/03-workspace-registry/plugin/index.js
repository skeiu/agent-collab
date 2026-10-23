// 实验 03 的探针插件：对同一路径重复调用 workspaceRegistry.create，并验证 attachSession。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const name = 'exp-03-workspace';

export function apply(ctx) {
  ctx.inject(['sessions'], async (sub) => {
    let registry;
    for (let attempt = 0; attempt < 150; attempt++) {
      registry = ctx.get('workspaceRegistry');
      if (registry !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (registry === undefined) throw new Error('workspaceRegistry service did not become available');
    const dir = path.join(process.env.DSH_HOME, 'workspace-03');
    fs.mkdirSync(dir, { recursive: true });
    const first = await registry.create(dir, 'First title');
    const second = await registry.create(dir, 'Second title');
    const session = sub.sessions.create(randomUUID(), { meta: { cwd: dir } });
    let attachError;
    try {
      await first.attachSession(session.id);
    } catch (error) {
      attachError = String(error);
    }
    const result = {
      first: { id: first.id, title: first.title, path: first.path },
      second: { id: second.id, title: second.title, path: second.path },
      listCount: registry.list().length,
      attachSessionType: typeof first.attachSession,
      attachError,
      sessionIds: [...first.sessionIds],
      sessionId: session.id,
    };
    fs.writeFileSync(path.join(process.env.DSH_HOME, 'exp-03.json'), JSON.stringify(result, null, 2));
  });
}
