// 实验 02 的探针插件：读取 agentPresets 服务的预设 id、mount 签名和各预设定义。
import fs from 'node:fs';
import path from 'node:path';

export const name = 'exp-02-presets';

export function apply(ctx) {
  ctx.inject(['agentPresets'], async (sub) => {
    const service = sub.agentPresets;
    let list = [];
    for (let attempt = 0; attempt < 150; attempt++) {
      list = await service.list();
      if (list.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const documents = {};
    for (const preset of list) {
      try {
        documents[preset.id] = await service.readDocument(preset.id);
      } catch (error) {
        documents[preset.id] = { error: String(error) };
      }
    }
    const result = {
      list,
      mount: {
        type: typeof service.mount,
        length: service.mount.length,
        text: String(service.mount),
        prototypeText: String(Object.getPrototypeOf(service).mount),
      },
      methods: Object.getOwnPropertyNames(Object.getPrototypeOf(service)),
      documents,
    };
    fs.writeFileSync(path.join(process.env.DSH_HOME, 'exp-02.json'), JSON.stringify(result, null, 2));
  });
}
