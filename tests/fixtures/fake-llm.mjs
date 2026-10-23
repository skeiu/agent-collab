// 本文件：测试用假 LLM 服务。按 OpenAI 兼容的 chat completions 协议流式应答，按脚本逐次返回文字/思考/工具调用；探针和桥接测试共用。

import http from 'node:http';
import { pathToFileURL } from 'node:url';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
};

function completionId() {
  return 'chatcmpl-fake-' + Math.random().toString(36).slice(2, 10);
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function normalizeToolCalls(step) {
  if (!Array.isArray(step.toolCalls)) return [];
  return step.toolCalls.map((call, index) => ({
    index,
    id: call.id ?? 'call_fake_' + Math.random().toString(36).slice(2, 12),
    name: call.name,
    arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
  }));
}

/**
 * 启动假 LLM 服务。
 * @param {{ responses?: Array<object>, port?: number, host?: string, onRequest?: (request: object, index: number) => void }} options
 * @returns {Promise<{ server: http.Server, port: number, url: string, requests: object[], close: () => Promise<void> }>}
 */
export async function createFakeLlm(options = {}) {
  const responses = Array.isArray(options.responses) ? options.responses : [];
  const requests = [];
  const host = options.host ?? '127.0.0.1';
  let cursor = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://' + host);

    if (req.method === 'GET' && /\/models\/?$/.test(url.pathname)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model', owned_by: 'fake' }] }));
      return;
    }

    if (req.method !== 'POST' || !/\/chat\/completions\/?$/.test(url.pathname)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found: ' + req.method + ' ' + url.pathname } }));
      return;
    }

    let body = null;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }));
      return;
    }

    const index = cursor++;
    const record = {
      index,
      method: req.method,
      path: url.pathname,
      headers: req.headers,
      body,
      at: new Date().toISOString(),
    };
    requests.push(record);
    if (options.onRequest) options.onRequest(record, index);

    const step = responses[index] ?? {
      text: responses.length === 0 ? 'FAKE_LLM_OK' : 'FAKE_LLM_DONE',
    };
    if (step.delayMs) await delay(step.delayMs);
    const text = typeof step.text === 'string' ? step.text : '';
    const reasoning = typeof step.reasoning === 'string' ? step.reasoning : '';
    const toolCalls = normalizeToolCalls(step);
    const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
    const id = completionId();
    const model = body && typeof body.model === 'string' ? body.model : 'fake-model';
    const created = Math.floor(Date.now() / 1000);
    const usage = {
      prompt_tokens: step.promptTokens ?? 120,
      completion_tokens: step.completionTokens ?? 12,
      total_tokens: (step.promptTokens ?? 120) + (step.completionTokens ?? 12),
      prompt_tokens_details: { cached_tokens: step.cachedTokens ?? 0 },
      completion_tokens_details: { reasoning_tokens: step.reasoningTokens ?? 0 },
    };

    const chunk = (delta, finish = null, extra = {}) => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: finish === null && Object.keys(delta).length === 0 ? [] : [{ index: 0, delta, finish_reason: finish }],
      ...extra,
    });

    if (body && body.stream === false) {
      const message = { role: 'assistant', content: text || null };
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }));
        if (!text) delete message.content;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage,
      }));
      return;
    }

    res.writeHead(200, SSE_HEADERS);
    const write = (payload) => res.write('data: ' + JSON.stringify(payload) + '\n\n');
    write(chunk({ role: 'assistant' }));
    if (reasoning) write(chunk({ reasoning_content: reasoning }));
    if (text) write(chunk({ content: text }));
    for (const call of toolCalls) {
      write(chunk({
        tool_calls: [{
          index: call.index,
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }],
      }));
    }
    write(chunk({}, finishReason));
    write(chunk({}, null, { usage }));
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    server,
    port,
    url: 'http://' + host + ':' + port + '/v1',
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** 从命令行运行：--script <json 文件> [--port <端口>]，输出 FAKE_LLM_URL=<url>。 */
async function main() {
  const args = process.argv.slice(2);
  const scriptIndex = args.indexOf('--script');
  const portIndex = args.indexOf('--port');
  let responses = [];
  if (scriptIndex >= 0 && args[scriptIndex + 1]) {
    const fs = await import('node:fs');
    responses = JSON.parse(fs.readFileSync(args[scriptIndex + 1], 'utf8'));
  }
  const service = await createFakeLlm({
    responses,
    port: portIndex >= 0 ? Number(args[portIndex + 1]) : 0,
  });
  process.stdout.write('FAKE_LLM_URL=' + service.url + '\n');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(String(error && error.stack ? error.stack : error) + '\n');
    process.exitCode = 1;
  });
}

export { messageText };
