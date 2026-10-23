// 按 D20 的做法启动工作进程：detached + unref，标准输入输出全部断开，启动后立即返回。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [outDir, label, seconds] = process.argv.slice(2);
const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.mjs');
const child = spawn(process.execPath, [worker, outDir, label, seconds], { detached: true, stdio: 'ignore' });
child.unref();
console.log('LAUNCHED ' + label + ' pid ' + child.pid);
