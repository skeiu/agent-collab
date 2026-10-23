// 实验 01 的探针插件：读取 standard 与 agent-collab 两个预设的定义，供 run.mjs 比较。
import fs from 'node:fs';
import path from 'node:path';

export const name = 'exp-01-preset';

export function apply(ctx) {
  ctx.inject(['agentPresets'], async (sub) => {
    const service = sub.agentPresets;
    let list = [];
    for (let attempt = 0; attempt < 150; attempt++) {
      list = await service.list();
      if (list.some((row) => row.id === 'agent-collab') && list.some((row) => row.id === 'standard')) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const standard = await service.readDocument('standard');
    const derived = await service.readDocument('agent-collab');
    fs.writeFileSync(path.join(process.env.DSH_HOME, 'exp-01.json'), JSON.stringify({ list, standard, derived }, null, 2));
  });
}
