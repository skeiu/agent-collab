// 本文件：测试用假 ACP 代理。支持 stdio 和 TCP；按 FAKE_ACP_SCRIPT 或 --script 传入的脚本模拟 update、权限请求和取消。

import net from 'node:net';

import { JsonRpcPeer } from '../../core/jsonrpc.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseScript() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--script');
  const text = index >= 0 ? args[index + 1] : process.env.FAKE_ACP_SCRIPT;
  if (!text) return {};
  return JSON.parse(text);
}

const script = parseScript();
const mode = process.argv.includes('--tcp') ? 'tcp' : 'stdio';

function defaultPermissionOptions() {
  return [
    { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  ];
}

function sendText(peer, sessionId, text) {
  peer.notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });
}

function createAgentPeer(readable, writable, label) {
  const peer = new JsonRpcPeer({ readable, writable, name: 'fake-acp-agent-' + label });
  let sessionCounter = 0;
  let activeSessionId = null;
  let cancelled = false;
  let lastNote = null;

  peer.onRequest('initialize', (params) => ({
    protocolVersion: 1,
    agentInfo: { name: 'fake-acp-agent', version: '0.0.0' },
    agentCapabilities: {
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { resume: {}, close: {} },
    },
    authMethods: [],
    _meta: { received: params },
  }));

  peer.onRequest('session/new', (params) => {
    if (script.failSessionNew) throw new Error(script.failSessionNew === true ? 'session/new failed for test' : String(script.failSessionNew));
    sessionCounter += 1;
    activeSessionId = 'fake-session-' + sessionCounter;
    return { sessionId: activeSessionId, configOptions: [], _meta: params && params._meta };
  });

  peer.onRequest('session/resume', () => {
    if (script.failSessionResume) throw new Error(script.failSessionResume === true ? 'session/resume failed for test' : String(script.failSessionResume));
    return { configOptions: [] };
  });
  peer.onRequest('session/set_config_option', () => ({ configOptions: [] }));
  peer.onRequest('session/close', () => ({}));
  peer.onRequest('_test/echo', (params) => params);
  peer.onRequest('_test/env', (params) => ({ value: process.env[params && params.name] ?? null }));

  peer.onNotification('session/cancel', (params) => {
    if (!params || !activeSessionId || params.sessionId === activeSessionId) cancelled = true;
  });
  peer.onNotification('_test/note', (params) => {
    lastNote = params;
  });

  peer.onRequest('session/prompt', async (params) => {
    activeSessionId = params.sessionId;
    const sessionId = params.sessionId;
    cancelled = false;
    const updates = Array.isArray(script.updates) ? script.updates : [];
    for (const text of updates) {
      if (cancelled) break;
      await delay(script.updateDelayMs ?? 2);
      sendText(peer, sessionId, text);
    }
    if (cancelled) return { stopReason: 'cancelled' };

    if (script.permission) {
      const response = await peer.request('session/request_permission', {
        sessionId,
        toolCall: script.permission.toolCall ?? { toolCallId: 'call-1', title: 'fake tool' },
        options: script.permission.options ?? defaultPermissionOptions(),
      });
      const decision = response && response.outcome ? response.outcome : {};
      if (decision.outcome === 'selected') {
        sendText(peer, sessionId, 'permission:selected:' + decision.optionId);
      } else {
        sendText(peer, sessionId, 'permission:' + (decision.outcome ?? 'unknown'));
      }
      if (script.afterPermission) sendText(peer, sessionId, script.afterPermission);
    }

    if (script.fsRequest) {
      let text;
      try {
        await peer.request('fs/read_text_file', { sessionId, path: '/tmp/not-allowed' });
        text = 'fs_error:none';
      } catch (error) {
        text = 'fs_error:' + error.code;
      }
      sendText(peer, sessionId, text);
    }

    if (script.terminalRequest) {
      let text;
      try {
        await peer.request('terminal/create', { sessionId, command: 'true', args: [] });
        text = 'terminal_error:none';
      } catch (error) {
        text = 'terminal_error:' + error.code;
      }
      sendText(peer, sessionId, text);
    }

    if (script.noteRequest) {
      sendText(peer, sessionId, 'note:' + JSON.stringify(lastNote));
    }

    if (cancelled) return { stopReason: 'cancelled' };
    if (script.holdOpen) {
      const deadline = Date.now() + (script.holdTimeoutMs ?? 10000);
      while (!cancelled && Date.now() < deadline) await delay(5);
      return { stopReason: cancelled ? 'cancelled' : (script.stopReason ?? 'end_turn') };
    }
    return { stopReason: script.stopReason ?? 'end_turn' };
  });

  return peer;
}

if (mode === 'tcp') {
  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    createAgentPeer(socket, socket, 'tcp');
  });
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write('FAKE_ACP_AGENT_PORT=' + server.address().port + '\n');
  });
} else {
  createAgentPeer(process.stdin, process.stdout, 'stdio');
}
