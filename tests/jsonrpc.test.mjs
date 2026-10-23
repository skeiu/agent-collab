// 本文件：core/jsonrpc.mjs 的单元测试。覆盖分包、拆包、多字节 UTF-8、请求匹配、错误码和关闭行为；JSON-RPC 实现变化时更新。

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import {
  JsonRpcConnectionError,
  JsonRpcError,
  JsonRpcLineTooLongError,
  JsonRpcPeer,
  JSON_RPC_ERRORS,
} from '../core/jsonrpc.mjs';

function makePair(options = {}) {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  const a = new JsonRpcPeer({ readable: bToA, writable: aToB, name: 'a' });
  const b = new JsonRpcPeer({ readable: aToB, writable: bToA, name: 'b', maxLineBytes: options.maxLineBytes });
  return { a, b, aToB, bToA };
}

function closePair(pair) {
  pair.a.close();
  pair.b.close();
  pair.aToB.destroy();
  pair.bToA.destroy();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 2000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(5);
  }
  throw new Error('timed out waiting for ' + label);
}

test('请求按 id 匹配响应，响应可以乱序到达', async () => {
  const pair = makePair();
  try {
    pair.b.onRequest('slow', async () => {
      await delay(30);
      return 'slow-result';
    });
    pair.b.onRequest('fast', () => 'fast-result');
    const slow = pair.a.request('slow', {});
    const fast = pair.a.request('fast', {});
    assert.equal(await fast, 'fast-result');
    assert.equal(await slow, 'slow-result');
  } finally {
    closePair(pair);
  }
});

test('通知按到达顺序交给处理函数，未知通知被忽略', async () => {
  const pair = makePair();
  try {
    const seen = [];
    pair.b.onNotification('note', (params) => seen.push(params.n));
    pair.a.notify('note', { n: 1 });
    pair.a.notify('unknown/method', { n: 99 });
    pair.a.notify('note', { n: 2 });
    await waitFor(() => seen.length === 2, 2000, 'two notifications');
    assert.deepEqual(seen, [1, 2]);
  } finally {
    closePair(pair);
  }
});

test('一个数据块里的多条消息全部处理', async () => {
  const pair = makePair();
  try {
    const seen = [];
    pair.b.onNotification('note', (params) => seen.push(params.n));
    pair.aToB.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'note', params: { n: 1 } }) + '\n' +
      JSON.stringify({ jsonrpc: '2.0', method: 'note', params: { n: 2 } }) + '\n' +
      JSON.stringify({ jsonrpc: '2.0', method: 'note', params: { n: 3 } }) + '\n',
    );
    await waitFor(() => seen.length === 3, 2000, 'three notifications');
    assert.deepEqual(seen, [1, 2, 3]);
  } finally {
    closePair(pair);
  }
});

test('一条消息跨多个数据块时能拼起来', async () => {
  const pair = makePair();
  try {
    const seen = [];
    pair.b.onNotification('note', (params) => seen.push(params.text));
    const line = JSON.stringify({ jsonrpc: '2.0', method: 'note', params: { text: 'split-message' } }) + '\n';
    const cut = Math.floor(line.length / 2);
    pair.aToB.write(line.slice(0, cut));
    await delay(10);
    pair.aToB.write(line.slice(cut));
    await waitFor(() => seen.length === 1, 2000, 'split notification');
    assert.deepEqual(seen, ['split-message']);
  } finally {
    closePair(pair);
  }
});

test('多字节 UTF-8 字符被数据块切开时仍能正确解码', async () => {
  const pair = makePair();
  try {
    const seen = [];
    pair.b.onNotification('note', (params) => seen.push(params.text));
    const text = '你好，世界 🚀 emoji';
    const buffer = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'note', params: { text } }) + '\n');
    const emojiStart = buffer.indexOf(Buffer.from('🚀'));
    assert.ok(emojiStart > 0);
    pair.aToB.write(buffer.subarray(0, emojiStart + 2));
    await delay(10);
    pair.aToB.write(buffer.subarray(emojiStart + 2));
    await waitFor(() => seen.length === 1, 2000, 'utf8 notification');
    assert.deepEqual(seen, [text]);
  } finally {
    closePair(pair);
  }
});

test('未注册的请求返回 -32601', async () => {
  const pair = makePair();
  try {
    await assert.rejects(pair.a.request('no/such/method', {}), (error) => {
      assert.ok(error instanceof JsonRpcError);
      assert.equal(error.code, JSON_RPC_ERRORS.METHOD_NOT_FOUND);
      return true;
    });
  } finally {
    closePair(pair);
  }
});

test('请求处理函数抛出的 JsonRpcError 原样返回错误码', async () => {
  const pair = makePair();
  try {
    pair.b.onRequest('fail', () => {
      throw new JsonRpcError(-32010, 'custom failure', { detail: true });
    });
    await assert.rejects(pair.a.request('fail', {}), (error) => {
      assert.equal(error.code, -32010);
      assert.equal(error.message, 'custom failure');
      assert.deepEqual(error.data, { detail: true });
      return true;
    });
  } finally {
    closePair(pair);
  }
});

test('无法解析的行返回 -32700，并继续处理后续行', async () => {
  const pair = makePair();
  try {
    const received = [];
    pair.b.onNotification('note', (params) => received.push(params.n));
    const raw = [];
    pair.bToA.on('data', (chunk) => raw.push(chunk.toString('utf8')));
    pair.aToB.write('this is not json\n');
    pair.aToB.write(JSON.stringify({ jsonrpc: '2.0', method: 'note', params: { n: 7 } }) + '\n');
    await waitFor(() => received.length === 1, 2000, 'post-parse-error notification');
    assert.deepEqual(received, [7]);
    await waitFor(() => raw.join('').includes('"code":-32700'), 2000, 'parse error response');
  } finally {
    closePair(pair);
  }
});

test('对端关闭时未完成的请求以 JsonRpcConnectionError 结束', async () => {
  const pair = makePair();
  try {
    pair.b.onRequest('never', () => new Promise(() => {}));
    const pending = pair.a.request('never', {});
    await delay(10);
    pair.bToA.end();
    await assert.rejects(pending, (error) => {
      assert.ok(error instanceof JsonRpcConnectionError);
      assert.equal(error.code, 'JSONRPC_CONNECTION_CLOSED');
      return true;
    });
  } finally {
    closePair(pair);
  }
});

test('未完成的一行超过 maxLineBytes 时关闭连接，并以该错误拒绝未完成请求', async () => {
  const pair = makePair({ maxLineBytes: 128 });
  try {
    pair.a.onRequest('never', () => new Promise(() => {}));
    const pending = pair.b.request('never', {});
    await delay(10);
    pair.aToB.write('x'.repeat(129));
    await assert.rejects(pending, (error) => {
      assert.ok(error instanceof JsonRpcLineTooLongError);
      assert.equal(error.code, 'JSONRPC_LINE_TOO_LONG');
      assert.equal(error.maxLineBytes, 128);
      return true;
    });
    assert.equal(pair.b.closed, true);
  } finally {
    closePair(pair);
  }
});

test('maxLineBytes 以内的正常消息不受影响', async () => {
  const pair = makePair({ maxLineBytes: 256 });
  try {
    const seen = [];
    pair.b.onNotification('note', (params) => seen.push(params.n));
    pair.a.notify('note', { n: 42, text: 'short' });
    await waitFor(() => seen.length === 1, 2000, 'short notification');
    assert.deepEqual(seen, [42]);
    assert.equal(pair.b.closed, false);
  } finally {
    closePair(pair);
  }
});

test('关闭后发送请求立即失败', async () => {
  const pair = makePair();
  try {
    pair.a.close('test close');
    await assert.rejects(pair.a.request('anything', {}), (error) => {
      assert.ok(error instanceof JsonRpcConnectionError);
      return true;
    });
    assert.throws(() => pair.a.notify('anything', {}), (error) => error instanceof JsonRpcConnectionError);
  } finally {
    closePair(pair);
  }
});
