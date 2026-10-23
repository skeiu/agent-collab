// 测试用工作进程：每秒往 <输出目录>/<标签>.hb 追加一行心跳，持续 <秒数> 秒后自行退出。
import fs from 'node:fs';
import path from 'node:path';

const [outDir, label, seconds = '45'] = process.argv.slice(2);
const file = path.join(outDir, label + '.hb');
fs.writeFileSync(path.join(outDir, label + '.pid'), String(process.pid));
let n = 0;
const timer = setInterval(() => {
  fs.appendFileSync(file, `${Date.now()}\n`);
  if (++n >= Number(seconds)) { clearInterval(timer); process.exit(0); }
}, 1000);
