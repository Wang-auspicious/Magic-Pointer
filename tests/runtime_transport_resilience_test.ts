import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  streamModel,
  resolveSystemProxyUrl,
  formatTransportError,
} from '../electron/runtime/model';
import {conversationFailureMessage} from '../electron/conversation_error';

const ROOT = path.resolve(__dirname, '..');

test('streamModel retries transient fetch cause errors up to 3 times and includes cause code when exhausted', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-transport-test-'));
  const healthFile = path.join(tmpDir, 'health.json');
  try {
    let calls = 0;
    const reply = await streamModel({
      root: ROOT,
      healthFile,
      config: {
        model: 'fixture',
        baseUrl: 'https://gateway.example.test/v1',
        apiMode: 'chat-completions',
        credential: 'fixture',
      },
      system: '',
      messages: [],
      tools: [],
      fetch: async () => {
        calls++;
        if (calls <= 3) {
          const err = new TypeError('fetch failed') as TypeError & {
            cause?: {code: string};
          };
          err.cause = {code: 'UND_ERR_SOCKET'};
          throw err;
        }
        return new Response(
          JSON.stringify({
            choices: [{message: {content: 'recovered answer'}, finish_reason: 'stop'}],
          }),
          {headers: {'content-type': 'application/json'}},
        );
      },
    });
    assert.equal(calls, 4);
    assert.equal(reply.text, 'recovered answer');
    assert.equal(reply.stop_reason, 'completed');

    let exhaustedCalls = 0;
    const exhausted = await streamModel({
      root: ROOT,
      healthFile,
      config: {
        model: 'fixture',
        baseUrl: 'https://exhaust.example.test/v1',
        apiMode: 'chat-completions',
        credential: 'fixture',
      },
      system: '',
      messages: [],
      tools: [],
      fetch: async () => {
        exhaustedCalls++;
        const err = new TypeError('fetch failed') as TypeError & {
          cause?: {code: string};
        };
        err.cause = {code: 'ECONNRESET'};
        throw err;
      },
    });
    assert.equal(exhaustedCalls, 4);
    assert.match(exhausted.stop_reason, /ECONNRESET/);

    // Verify circuit breaker does not prematurely open on a single call (< 3 streak)
    const healthRaw = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
    assert.equal(
      Number(healthRaw.entries['https://exhaust.example.test/v1']?.open_until || 0),
      0,
    );
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

test('formatTransportError and resolveSystemProxyUrl preserve cause codes and parse Chromium proxy rules', () => {
  const err = new TypeError('fetch failed') as TypeError & {
    cause?: {code: string};
  };
  err.cause = {code: 'ECONNRESET'};
  assert.match(formatTransportError(err), /fetch failed \(ECONNRESET\)/);

  assert.equal(
    resolveSystemProxyUrl('PROXY 127.0.0.1:7890; DIRECT'),
    'http://127.0.0.1:7890',
  );
  assert.equal(
    resolveSystemProxyUrl('HTTPS proxy.corp.local:8443'),
    'https://proxy.corp.local:8443',
  );
  assert.equal(resolveSystemProxyUrl('DIRECT'), '');
});

test('conversationFailureMessage appends cause detail when provided while keeping default message intact', () => {
  assert.equal(
    conversationFailureMessage({ok: false, error: 'provider_unavailable'}),
    '模型服务当前不可用（provider_unavailable）。',
  );
  const detailed = conversationFailureMessage({
    ok: false,
    error: 'provider_unavailable',
    answer: 'backend_error:fetch failed (UND_ERR_SOCKET)',
  });
  assert.match(detailed, /UND_ERR_SOCKET/);
  assert.match(detailed, /重试/);
});

test('failed assistant turn and failed Learn branch expose inline retry action', () => {
  const ChatView = require('../electron/renderer/chat_view');
  const failedTurn = ChatView.assistantTurnNode({
    question: 'Why did bayes threshold fail?',
    answer: '',
    failed: true,
    error: '连接中断',
    conversationId: 'c-retry-1',
    turnIndex: 0,
  });
  const serialized = JSON.stringify(failedTurn);
  assert.match(serialized, /data-mp-chat-act":"retry/);
  assert.match(serialized, /data-mp-chat-retry":"Why did bayes threshold fail\?/);
});
