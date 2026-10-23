// 测试探针：把调用标签和环境里能看到的插件根目录追加到 $PROBE_OUT/markers.jsonl，并打印一行。
import fs from 'node:fs';
import path from 'node:path';

const out = process.env.PROBE_OUT;
const tag = process.argv[2] ?? 'unknown';
const line = JSON.stringify({ tag, pluginRootEnv: Boolean(process.env.CLAUDE_PLUGIN_ROOT), time: Date.now() });
if (out) fs.appendFileSync(path.join(out, 'markers.jsonl'), line + '\n');
console.log('PROBE ' + tag + ' ok');
