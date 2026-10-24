// 本文件：仓库锁的原子性和多进程并发测试（RW2）：4 个进程同时抢锁，无锁和有 pid 已死的旧锁两种情况下每轮恰好一个成功；内容不可读的新锁在宽限内按被占用处理，锁文件出现时内容总是完整 JSON。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { acquireLock, releaseLock, lockFileFor } from '../core/rundir.mjs';

const lockWorkerPath = fileURLToPath(new URL('./fixtures/lock-worker.mjs', import.meta.url));
const DEAD_PID = 2147483647;

async function makeHome(label) {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'agent-collab-lock-' + label + '-'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startWorker(home, repoId) {
  const child = spawn(process.execPath, [lockWorkerPath, home, repoId], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = [];
  const waiting = [];
  child.stdout.setEncoding('utf8');
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    const value = JSON.parse(line);
    const resolver = waiting.shift();
    if (resolver) resolver(value);
    else pending.push(value);
  });
  child.stderr.resume();
  return {
    child,
    send(message) {
      child.stdin.write(JSON.stringify(message) + '\n');
    },
    next(timeout = 10000) {
      if (pending.length > 0) return Promise.resolve(pending.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待锁测试子进程输出超时')), timeout);
        waiting.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    },
    async close() {
      try {
        child.stdin.end();
      } catch {
        // 已经关闭。
      }
      child.kill('SIGKILL');
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', resolve);
        setTimeout(resolve, 1000);
      });
    },
  };
}

/** 每一轮让 4 个进程在同一时刻抢锁；返回每轮的结果。 */
async function runRounds({ home, repoId, rounds, prepare }) {
  const file = lockFileFor(home, repoId);
  const workers = Array.from({ length: 4 }, () => startWorker(home, repoId));
  const badReads = [];
  try {
    for (let round = 1; round <= rounds; round += 1) {
      if (prepare) await prepare(round);
      // 抢锁期间不停读锁文件：锁文件出现时必须已经是完整 JSON。
      let reading = true;
      const reader = (async () => {
        while (reading) {
          try {
            const text = await fsp.readFile(file, 'utf8');
            JSON.parse(text);
          } catch (error) {
            if (error.code !== 'ENOENT') badReads.push('第 ' + round + ' 轮：' + error.message);
          }
          await sleep(1);
        }
      })();
      const startAt = Date.now() + 25;
      for (const worker of workers) worker.send({ type: 'attempt', round, startAt });
      const results = await Promise.all(workers.map((worker) => worker.next()));
      reading = false;
      await reader;
      const winners = results.filter((item) => item.ok);
      assert.equal(winners.length, 1, '第 ' + round + ' 轮成功数是 ' + winners.length + '：' + JSON.stringify(results));
      assert.deepEqual(
        results.filter((item) => !item.ok).map((item) => item.code).sort(),
        ['lock_held', 'lock_held', 'lock_held'],
        '第 ' + round + ' 轮拒绝原因不对：' + JSON.stringify(results),
      );
      // 拿到锁的进程一直持有，等所有结果都回来再让它释放：每轮恰好一个持有者。
      const winner = workers[results.findIndex((item) => item.ok)];
      winner.send({ type: 'release', round });
      const released = await winner.next();
      assert.equal(released.released, true, '第 ' + round + ' 轮释放失败：' + JSON.stringify(released));
      await assert.rejects(fsp.access(file), '第 ' + round + ' 轮结束后锁应已释放');
    }
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
  }
  assert.deepEqual(badReads, [], '读到了不完整的锁文件');
}

test('4 个进程同时抢锁：没有锁时每轮恰好一个成功，其余 lock_held（20 轮）', async (t) => {
  const home = await makeHome('free');
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  await runRounds({ home, repoId: 'repo-a', rounds: 20 });
});

test('4 个进程同时抢 pid 已死的旧锁：每轮恰好一个成功，其余 lock_held（20 轮）', async (t) => {
  const home = await makeHome('stale');
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const file = lockFileFor(home, 'repo-b');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await runRounds({
    home,
    repoId: 'repo-b',
    rounds: 20,
    prepare: async () => {
      await fsp.writeFile(
        file,
        JSON.stringify({ v: 1, runId: 'T900', pid: DEAD_PID, phase: 'worker', createdAt: new Date().toISOString() }) + '\n',
      );
    },
  });
});

test('内容读不出来的新锁在宽限内按被占用处理，超过宽限后可以打破', async (t) => {
  const home = await makeHome('grace');
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const file = lockFileFor(home, 'repo-c');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, '');

  await assert.rejects(
    acquireLock({ home, repoId: 'repo-c', runId: 'T001', pid: process.pid }),
    (error) => error.code === 'lock_held',
    '空锁在宽限内应被拒绝',
  );

  // 把修改时间拨到宽限之外，旧锁可以打破。
  const old = new Date(Date.now() - 60000);
  await fsp.utimes(file, old, old);
  await acquireLock({ home, repoId: 'repo-c', runId: 'T002', pid: process.pid });
  const lock = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(lock.runId, 'T002');
  await releaseLock(file, 'T002');
});

test('锁文件内容总是完整的 JSON：并发抢锁期间解析失败为 0', async (t) => {
  // 已经在上面 runRounds 的 reader 里检查；这里再断言一次单进程创建的锁立即可解析。
  const home = await makeHome('complete');
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const file = lockFileFor(home, 'repo-d');
  await acquireLock({ home, repoId: 'repo-d', runId: 'T001', pid: process.pid });
  const lock = JSON.parse(await fsp.readFile(file, 'utf8'));
  assert.equal(lock.runId, 'T001');
  assert.equal(typeof lock.pid, 'number');
  await releaseLock(file, 'T001');
});
