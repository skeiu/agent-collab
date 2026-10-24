// 本文件：测试用执行端适配器：按 docs/protocol.md 第 3 节实现接口，通过回环 TCP 连到 tests/fixtures/fake-executor.mjs。真实适配器在 S4 实现，本文件只用于 S3 的测试。

import net from 'node:net';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 创建假适配器。地址从环境变量 AGENT_COLLAB_FAKE_EXECUTOR（host:port）读取，
 * 由测试在启动工作进程前设置。
 */
export function createAdapter({ config, onEvent, log } = {}) {
  const address = process.env.AGENT_COLLAB_FAKE_EXECUTOR;
  if (typeof address !== 'string' || !address.includes(':')) {
    throw new Error('AGENT_COLLAB_FAKE_EXECUTOR 未设置或格式不对（需要 host:port）');
  }
  const [host, portText] = address.split(':');
  const port = Number(portText);
  let socket = null;
  let buffer = '';
  let pendingTurn = null;
  const waiters = new Map();
  // attach 时补发的事件：先缓冲，等 replay_end 到达后按第 3 节的规则算出 finalText。
  let replayEntries = [];
  let replayDone = null;

  function write(message) {
    if (!socket || socket.destroyed) throw new Error('假适配器未连接');
    socket.write(JSON.stringify(message) + '\n');
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'event') {
      const event = { ...message.event };
      if (message.cursor !== undefined) event.cursor = message.cursor;
      if (replayDone) replayEntries.push({ turn: message.turn, event: { ...event } });
      onEvent(event);
      return;
    }
    if (message.type === 'replay_end') {
      if (replayDone) {
        const current = replayDone;
        replayDone = null;
        current.resolve(message.turn);
      }
      return;
    }
    if (message.type === 'turn_end') {
      if (pendingTurn) {
        const current = pendingTurn;
        pendingTurn = null;
        current.resolve(message.result ?? {});
      }
      return;
    }
    const waiter = waiters.get(message.type);
    if (waiter) {
      waiters.delete(message.type);
      waiter(message);
      return;
    }
    if (message.type === 'error') log && log('假执行端报错：' + message.message);
  }

  function connect() {
    if (socket && !socket.destroyed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const client = net.connect({ host, port }, () => resolve());
      client.setEncoding('utf8');
      client.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          try {
            handleMessage(JSON.parse(line));
          } catch (error) {
            log && log('假适配器解析失败：' + error.message);
          }
        }
      });
      client.on('error', (error) => {
        if (pendingTurn) {
          const current = pendingTurn;
          pendingTurn = null;
          current.reject(error);
        }
        reject(error);
      });
      client.on('close', () => {
        if (socket === client) socket = null;
      });
      socket = client;
    });
  }

  function request(message, replyType) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(replyType);
        reject(new Error('等待 ' + replyType + ' 超时'));
      }, 15000);
      waiters.set(replyType, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      try {
        write(message);
      } catch (error) {
        clearTimeout(timer);
        waiters.delete(replyType);
        reject(error);
      }
    });
  }

  /** 按第 3 节从一轮的事件算 TurnResult：最后一次工具调用之后的全部 text；没有工具调用时取全部 text。 */
  function computeTurnResult(entries, turn) {
    const events = entries
      .filter((entry) => Number(entry.turn) === Number(turn))
      .map((entry) => entry.event);
    let lastToolCall = -1;
    events.forEach((event, index) => {
      if (event.type === 'tool_call') lastToolCall = index;
    });
    const finalText = events
      .slice(lastToolCall + 1)
      .filter((event) => event.type === 'text')
      .map((event) => String(event.text ?? ''))
      .join('');
    const end = events.find((event) => event.type === 'turn_end') ?? {};
    return {
      stopReason: end.stopReason ?? null,
      endReason: end.endReason ?? null,
      stoppedBy: end.stoppedBy ?? null,
      finalText,
    };
  }

  function beginTurn(message, replyType) {
    const turn = deferred();
    pendingTurn = turn;
    return request(message, replyType)
      .then((reply) => ({ reply, turn: turn.promise }))
      .catch((error) => {
        pendingTurn = null;
        turn.reject(error);
        throw error;
      });
  }

  return {
    capabilities() {
      return { images: false, structuredOutput: false, liveView: false, resume: true, humanApproval: true };
    },

    async start({ cwd, runId, title, brief, images, options, env }) {
      await connect();
      const { reply, turn } = await beginTurn({ type: 'start', cwd, runId, title, brief, images, options, env }, 'started');
      return { sessionId: reply.sessionId, transport: 'fake-tcp', model: reply.model ?? null, turn };
    },

    async resume({ sessionId, message }) {
      await connect();
      const { turn } = await beginTurn({ type: 'resume', sessionId, message }, 'resumed');
      return { turn };
    },

    async attach({ sessionId, sinceCursor }) {
      await connect();
      // 先建好这一轮的 deferred 再发请求：补发的事件可能和 attached 在同一个数据块里到达。
      const turn = deferred();
      const replay = deferred();
      pendingTurn = turn;
      replayEntries = [];
      replayDone = replay;
      try {
        const reply = await request({ type: 'attach', sessionId, since: sinceCursor ?? null }, 'attached');
        if (reply.attached !== true) {
          if (pendingTurn === turn) pendingTurn = null;
          return { attached: false, running: false };
        }
        if (reply.running === true) {
          return { attached: true, running: true, turn: turn.promise };
        }
        if (reply.noResult) {
          // 执行端拿不到这一轮的结果：不带 result，由运行时决定怎么记。
          if (pendingTurn === turn) pendingTurn = null;
          return { attached: true, running: false };
        }
        await replay.promise;
        const result = computeTurnResult(replayEntries, reply.turn);
        if (pendingTurn === turn) pendingTurn = null;
        return { attached: true, running: false, turn: reply.turn, result };
      } finally {
        replayDone = null;
        replayEntries = [];
      }
    },

    async cancel({ sessionId }) {
      if (!socket || socket.destroyed) return;
      await request({ type: 'cancel', sessionId }, 'cancel_ack');
    },

    async close() {
      if (!socket) return;
      const client = socket;
      socket = null;
      await new Promise((resolve) => {
        client.end(() => resolve());
        setTimeout(resolve, 200);
      });
    },
  };
}
