// 本文件：仓库锁并发测试的子进程：从标准输入接收“第几轮、什么时候开始”的指令，按时刻调用 core/rundir.mjs 的 acquireLock；拿到锁后一直持有，等父进程发 release 再释放。由 tests/run-lock-atomic.test.mjs 启动。

import readline from 'node:readline';

import { acquireLock, lockFileFor, releaseLock } from '../../core/rundir.mjs';

const [home, repoId] = process.argv.slice(2);
if (!home || !repoId) {
  process.stderr.write('用法：lock-worker.mjs <home> <repoId>\n');
  process.exit(2);
}
const lockFile = lockFileFor(home, repoId);
const workerPid = process.pid;
let holding = null;

function print(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

async function sleepUntil(time) {
  for (;;) {
    const left = time - Date.now();
    if (left <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(left, 5)));
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === 'attempt') {
    void (async () => {
      await sleepUntil(message.startAt);
      try {
        await acquireLock({ home, repoId, runId: 'T' + message.round, pid: workerPid, phase: 'starting' });
        holding = message.round;
        print({ round: message.round, worker: workerPid, ok: true });
      } catch (error) {
        print({ round: message.round, worker: workerPid, ok: false, code: error.code ?? 'error', message: error.message });
      }
    })();
    return;
  }
  if (message.type === 'release') {
    void (async () => {
      if (holding === null) return;
      const round = holding;
      holding = null;
      await releaseLock(lockFile, 'T' + round);
      print({ round, worker: workerPid, released: true });
    })();
  }
});
