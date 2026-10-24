// 本文件：清理时结束进程的规则（PR1）：已退出的句柄、已停下或结束的任务、发现文件不在的 Web 都不结束；仍在跑才结束。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { killActiveWorkers, killChild, killWorkerIfActive, pidAlive, stopWebFromDiscovery } from './helpers/pids.mjs';

function recorder() {
  const calls = [];
  return {
    calls,
    kill(pid, signal) { calls.push([pid, signal]); },
    signalled() { return calls.filter(([, signal]) => signal !== 0); },
  };
}

/** 起一个真的还活着的子进程，用来冒充“PID 存活”。 */
async function liveChild(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(async () => { await killChild(child); });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !pidAlive(child.pid)) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(pidAlive(child.pid), '测试用的子进程没有起来');
  return child;
}

test('已经退出的句柄不结束：exitCode 或 signalCode 不是 null 都不发信号', async () => {
  const rec = recorder();
  assert.equal(await killChild({ pid: 424242, exitCode: 0, signalCode: null }, { kill: rec.kill }), false, '已退出的句柄不该结束');
  assert.equal(await killChild({ pid: 424243, exitCode: null, signalCode: 'SIGTERM' }, { kill: rec.kill }), false, '被信号结束的句柄不该结束');
  assert.deepEqual(rec.calls, [], '已退出的句柄不该收到任何信号');
});

test('还在跑的句柄要结束', async (t) => {
  const rec = recorder();
  const child = await liveChild(t);
  assert.equal(await killChild({ pid: child.pid, exitCode: null, signalCode: null }, { kill: rec.kill }), true);
  assert.deepEqual(rec.signalled(), [[child.pid, 'SIGKILL']]);
});

test('任务已经停下或结束时不结束它的 worker.pid，即使这个 PID 还活着', async (t) => {
  const rec = recorder();
  const child = await liveChild(t);
  for (const status of ['done', 'partial', 'blocked', 'failed', 'cancelled', 'report_invalid']) {
    assert.equal(killWorkerIfActive({ status, worker: { pid: child.pid } }, { kill: rec.kill }), false, '状态为 ' + status + ' 时不该结束工作进程');
  }
  assert.deepEqual(rec.signalled(), [], '非进行中状态不该收到结束信号');
  assert.equal(pidAlive(child.pid), true, '冒充工作进程的子进程应还活着');
});

test('任务仍在进行中、worker.pid 就是这个 PID 且 PID 存活时结束它', async (t) => {
  const child = await liveChild(t);
  for (const status of ['starting', 'running', 'waiting_approval', 'waiting_question']) {
    const rec = recorder();
    assert.equal(killWorkerIfActive({ status, worker: { pid: child.pid } }, { kill: rec.kill }), true, '状态为 ' + status + ' 时应该结束工作进程');
    assert.deepEqual(rec.signalled(), [[child.pid, 'SIGKILL']]);
  }
});

test('state.json 里的 worker.pid 不是这个 PID 时不结束', async (t) => {
  const rec = recorder();
  const child = await liveChild(t);
  assert.equal(killWorkerIfActive({ status: 'running', worker: { pid: child.pid } }, { pid: 1, kill: rec.kill }), false);
  assert.deepEqual(rec.calls, []);
});

test('任务正在进行但 PID 已经不存活时不发信号', async (t) => {
  const rec = recorder();
  const kill = (pid, signal) => {
    if (signal === 0) {
      const error = new Error('kill ESRCH');
      error.code = 'ESRCH';
      throw error;
    }
    rec.kill(pid, signal);
  };
  assert.equal(killWorkerIfActive({ status: 'running', worker: { pid: 424244 } }, { kill }), false);
  assert.deepEqual(rec.calls, []);
});

test('发现文件不在时不结束 Web', async () => {
  const rec = recorder();
  const readFile = async () => {
    const error = new Error('ENOENT: no such file or directory');
    error.code = 'ENOENT';
    throw error;
  };
  assert.equal(await stopWebFromDiscovery('/tmp/不存在的发现文件/bridge-web.json', { readFile, kill: rec.kill }), false);
  assert.deepEqual(rec.calls, [], '发现文件不在时不该按 PID 结束任何进程');
});

test('发现文件里的 pid 是测试进程自己时不结束', async () => {
  const rec = recorder();
  assert.equal(await stopWebFromDiscovery('bridge-web.json', { readFile: async () => JSON.stringify({ pid: process.pid }), kill: rec.kill }), false);
  assert.deepEqual(rec.calls, []);
});

test('发现文件在且 pid 存活时结束 Web，pid 不存活时不结束', async (t) => {
  const child = await liveChild(t);
  const rec = recorder();
  assert.equal(await stopWebFromDiscovery('bridge-web.json', { readFile: async () => JSON.stringify({ pid: child.pid }), kill: rec.kill }), true);
  assert.deepEqual(rec.signalled(), [[child.pid, 'SIGTERM']]);

  const rec2 = recorder();
  const killGone = (pid, signal) => {
    if (signal === 0) {
      const error = new Error('kill ESRCH');
      error.code = 'ESRCH';
      throw error;
    }
    rec2.kill(pid, signal);
  };
  assert.equal(await stopWebFromDiscovery('bridge-web.json', { readFile: async () => JSON.stringify({ pid: 424245 }), kill: killGone }), false);
  assert.deepEqual(rec2.calls, []);
});

test('killActiveWorkers 只结束仍在进行中的任务的工作进程', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-collab-pids-'));
  const repoId = 'repo-abc';
  const running = await liveChild(t);
  const done = await liveChild(t);
  const writeState = async (runId, state) => {
    const dir = path.join(root, 'runs', repoId, runId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'state.json'), JSON.stringify(state));
  };
  await writeState('T001', { status: 'running', worker: { pid: running.pid } });
  await writeState('T002', { status: 'done', worker: { pid: done.pid } });
  const rec = recorder();
  await killActiveWorkers(root, { kill: rec.kill });
  assert.deepEqual(rec.signalled(), [[running.pid, 'SIGKILL']], '只应结束进行中的那个');
  await fsp.rm(root, { recursive: true, force: true });
});
