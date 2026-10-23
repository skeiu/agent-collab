// 本文件：core/acp-client.mjs 对假 ACP 代理的单元测试。覆盖 stdio/TCP、update 顺序、取消、权限策略和 fs/terminal 拒绝；客户端协议变化时更新。

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AcpClient } from '../core/acp-client.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(repoRoot, 'tests', 'fixtures', 'fake-acp-agent.mjs');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 3000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(5);
  }
  throw new Error('timed out waiting for ' + label);
}

function scriptEnv(script) {
  return { ...process.env, FAKE_ACP_SCRIPT: JSON.stringify(script) };
}

function cleanEnv(script) {
  const env = { FAKE_ACP_SCRIPT: JSON.stringify(script) };
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

async function connectStdio(script, options = {}) {
  return AcpClient.connect({
    transport: 'stdio',
    command: process.execPath,
    args: [fixturePath, '--stdio'],
    cwd: repoRoot,
    env: scriptEnv(script),
    permissionPolicy: options.permissionPolicy ?? 'deny',
  });
}

function collectUpdates(client) {
  const texts = [];
  client.onSessionUpdate((params) => {
    const update = params && params.update;
    if (update && update.sessionUpdate === 'agent_message_chunk' && update.content && update.content.type === 'text') {
      texts.push(update.content.text);
    }
  });
  return texts;
}

async function startTcpFixture(script) {
  const child = spawn(process.execPath, [fixturePath, '--tcp'], {
    cwd: repoRoot,
    env: scriptEnv(script),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for fake agent port; stderr=' + stderr)), 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = /FAKE_ACP_AGENT_PORT=(\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error('fake agent exited early: code=' + code + ' signal=' + signal + ' stderr=' + stderr));
    });
  });
  return { child, port };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(2000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, delay(1000)]);
  }
}

async function connectTcp(script, permissionPolicy = 'deny') {
  const fixture = await startTcpFixture(script);
  try {
    const client = await AcpClient.connect({
      transport: 'tcp',
      host: '127.0.0.1',
      port: fixture.port,
      permissionPolicy,
    });
    return { client, fixture };
  } catch (error) {
    await stopChild(fixture.child);
    throw error;
  }
}

async function closeTcp(connection) {
  if (connection.client) await connection.client.close();
  await stopChild(connection.fixture.child);
}

async function assertProcessGone(pid) {
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  }, 3000, 'process ' + pid + ' to exit');
}

test('stdio：initialize、session/new、session/prompt、update 顺序、权限和 fs/terminal 拒绝', async () => {
  const script = {
    updates: ['one', 'two', '三分'],
    permission: {},
    fsRequest: true,
    terminalRequest: true,
    stopReason: 'end_turn',
  };
  const client = await connectStdio(script, { permissionPolicy: 'allow' });
  const pid = client.pid;
  try {
    const init = await client.initialize();
    assert.equal(init.protocolVersion, 1);
    assert.equal(init.agentInfo.name, 'fake-acp-agent');
    assert.equal(init._meta.received.clientCapabilities.fs.readTextFile, false);
    assert.equal(init._meta.received.clientCapabilities.fs.writeTextFile, false);
    assert.equal(init._meta.received.clientCapabilities.terminal, false);

    const session = await client.newSession({ cwd: repoRoot, mcpServers: [], _meta: { test: true } });
    assert.equal(session.sessionId, 'fake-session-1');
    assert.deepEqual(session._meta, { test: true });

    const updates = collectUpdates(client);
    const result = await client.prompt({ sessionId: session.sessionId, prompt: 'hello', _meta: { test: true } });
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(updates, [
      'one',
      'two',
      '三分',
      'permission:selected:allow-once',
      'fs_error:-32601',
      'terminal_error:-32601',
    ]);

    const echo = await client.extensionRequest('_test/echo', { value: 42 });
    assert.deepEqual(echo, { value: 42 });
    client.extensionNotify('_test/note', { hello: 'world' });
    await delay(10);

    const closed = await client.closeSession({ sessionId: session.sessionId });
    assert.deepEqual(closed, {});
  } finally {
    await client.close();
  }
  await assertProcessGone(pid);
});

test('stdio：permissionPolicy=deny 选择 reject_once 选项', async () => {
  const client = await connectStdio({ updates: [], permission: {} }, { permissionPolicy: 'deny' });
  try {
    await client.initialize();
    const session = await client.newSession({ cwd: repoRoot });
    const updates = collectUpdates(client);
    const result = await client.prompt({ sessionId: session.sessionId, prompt: 'need permission' });
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(updates, ['permission:selected:reject-once']);
  } finally {
    await client.close();
  }
});

test('stdio：session/cancel 后 prompt 以 cancelled 结束', async () => {
  const client = await connectStdio({ updates: ['start'], holdOpen: true }, { permissionPolicy: 'deny' });
  try {
    await client.initialize();
    const session = await client.newSession({ cwd: repoRoot });
    const updates = collectUpdates(client);
    const pending = client.prompt({ sessionId: session.sessionId, prompt: 'long task' });
    await waitFor(() => updates.length === 1, 3000, 'first update');
    client.cancel({ sessionId: session.sessionId });
    const result = await pending;
    assert.equal(result.stopReason, 'cancelled');
  } finally {
    await client.close();
  }
});

test('stdio：传入 env 时使用完整环境，不继承父进程变量', async () => {
  const key = 'AGENT_COLLAB_PARENT_ONLY_' + process.pid;
  process.env[key] = 'parent-value';
  let client;
  try {
    client = await AcpClient.connect({
      transport: 'stdio',
      command: process.execPath,
      args: [fixturePath, '--stdio'],
      cwd: repoRoot,
      env: cleanEnv({ updates: [] }),
      permissionPolicy: 'deny',
    });
    const result = await client.extensionRequest('_test/env', { name: key });
    assert.deepEqual(result, { value: null });
    assert.equal(process.env[key], 'parent-value');
  } finally {
    if (client) await client.close();
    delete process.env[key];
  }
});

test('TCP：permissionPolicy=allow 选择 allow_once，fs/terminal 请求回 -32601', async () => {
  const connection = await connectTcp({ updates: ['tcp-permission'], permission: {}, fsRequest: true, terminalRequest: true }, 'allow');
  try {
    await connection.client.initialize();
    const session = await connection.client.newSession({ cwd: repoRoot });
    const updates = collectUpdates(connection.client);
    const result = await connection.client.prompt({ sessionId: session.sessionId, prompt: 'need permission' });
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(updates, [
      'tcp-permission',
      'permission:selected:allow-once',
      'fs_error:-32601',
      'terminal_error:-32601',
    ]);
    await connection.client.closeSession({ sessionId: session.sessionId });
  } finally {
    await closeTcp(connection);
  }
});

test('TCP：permissionPolicy=deny 选择 reject_once 选项', async () => {
  const connection = await connectTcp({ updates: [], permission: {} }, 'deny');
  try {
    await connection.client.initialize();
    const session = await connection.client.newSession({ cwd: repoRoot });
    const updates = collectUpdates(connection.client);
    const result = await connection.client.prompt({ sessionId: session.sessionId, prompt: 'need permission' });
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(updates, ['permission:selected:reject-once']);
  } finally {
    await closeTcp(connection);
  }
});

test('TCP：session/cancel 后 prompt 以 cancelled 结束', async () => {
  const connection = await connectTcp({ updates: ['tcp-start'], holdOpen: true }, 'deny');
  try {
    await connection.client.initialize();
    const session = await connection.client.newSession({ cwd: repoRoot });
    const updates = collectUpdates(connection.client);
    const pending = connection.client.prompt({ sessionId: session.sessionId, prompt: 'long task' });
    await waitFor(() => updates.length === 1, 3000, 'first tcp update');
    connection.client.cancel({ sessionId: session.sessionId });
    const result = await pending;
    assert.equal(result.stopReason, 'cancelled');
  } finally {
    await closeTcp(connection);
  }
});

test('TCP：initialize、session/new、prompt 和 update 顺序', async () => {
  const fixture = await startTcpFixture({ updates: ['tcp-one', 'tcp-two'], stopReason: 'end_turn' });
  let client;
  try {
    client = await AcpClient.connect({ transport: 'tcp', host: '127.0.0.1', port: fixture.port, permissionPolicy: 'deny' });
    const init = await client.initialize();
    assert.equal(init.protocolVersion, 1);
    const session = await client.newSession({ cwd: repoRoot });
    const updates = collectUpdates(client);
    const result = await client.prompt({ sessionId: session.sessionId, prompt: 'over tcp' });
    assert.equal(result.stopReason, 'end_turn');
    assert.deepEqual(updates, ['tcp-one', 'tcp-two']);
    await client.closeSession({ sessionId: session.sessionId });
  } finally {
    if (client) await client.close();
    await stopChild(fixture.child);
  }
});
