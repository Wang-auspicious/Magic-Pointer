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

test('streamModel renews idle timeout on active SSE chunks instead of aborting healthy long streams', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-idle-test-'));
  const healthFile = path.join(tmpDir, 'health.json');
  try {
    const encoder = new TextEncoder();
    const reply = await streamModel({
      root: ROOT,
      healthFile,
      timeoutMs: 90,
      config: {
        model: 'fixture',
        baseUrl: 'https://idle.example.test/v1',
        apiMode: 'chat-completions',
        credential: 'fixture',
      },
      system: '',
      messages: [],
      tools: [],
      fetch: async (_url, init) => {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            const chunks = [
              'data: {"choices":[{"delta":{"reasoning_content":"step 1"}}]}\n\n',
              'data: {"choices":[{"delta":{"reasoning_content":"step 2"}}]}\n\n',
              'data: {"choices":[{"delta":{"content":"final "}}]}\n\n',
              'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n',
              'data: [DONE]\n\n',
            ];
            for (const c of chunks) {
              if (init?.signal?.aborted) {
                controller.error(init.signal.reason || new Error('aborted'));
                return;
              }
              await new Promise(r => setTimeout(r, 40));
              if (init?.signal?.aborted) {
                controller.error(init.signal.reason || new Error('aborted'));
                return;
              }
              controller.enqueue(encoder.encode(c));
            }
            controller.close();
          },
        });
        return new Response(body, {
          headers: {'content-type': 'text/event-stream'},
        });
      },
    });
    assert.equal(reply.text, 'final answer');
    assert.equal(reply.stop_reason, 'completed');
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

test('streamModel retries stalled pre-commit SSE stream on idle timeout and succeeds', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-stall-retry-'));
  const healthFile = path.join(tmpDir, 'health.json');
  try {
    const encoder = new TextEncoder();
    let calls = 0;
    const reply = await streamModel({
      root: ROOT,
      healthFile,
      timeoutMs: 80,
      config: {
        model: 'fixture',
        baseUrl: 'https://stall-retry.example.test/v1',
        apiMode: 'chat-completions',
        credential: 'fixture',
      },
      system: '',
      messages: [],
      tools: [],
      fetch: async (_url, init) => {
        calls++;
        const attempt = calls;
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            if (attempt === 1) {
              controller.enqueue(
                encoder.encode(
                  'data: {"choices":[{"delta":{"reasoning_content":"thinking..."}}]}\n\n',
                ),
              );
              init?.signal?.addEventListener('abort', () => {
                controller.error(init.signal?.reason || new Error('aborted'));
              });
              return;
            }
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":"recovered stream"},"finish_reason":"stop"}]}\n\n',
              ),
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(body, {
          headers: {'content-type': 'text/event-stream'},
        });
      },
    });
    assert.equal(calls, 2);
    assert.equal(reply.text, 'recovered stream');
    assert.equal(reply.stop_reason, 'completed');
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

test('streamModel renews idle timeout on raw SSE keepalive comments and empty deltas', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-keepalive-test-'));
  const healthFile = path.join(tmpDir, 'health.json');
  try {
    const encoder = new TextEncoder();
    const reply = await streamModel({
      root: ROOT,
      healthFile,
      timeoutMs: 80,
      config: {
        model: 'fixture',
        baseUrl: 'https://keepalive.example.test/v1',
        apiMode: 'chat-completions',
        credential: 'fixture',
      },
      system: '',
      messages: [],
      tools: [],
      fetch: async (_url, init) => {
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            const chunks = [
              ': keep-alive\n\n',
              ': ping\n\n',
              'data: {"choices":[{"delta":{}}]}\n\n',
              'data: {"choices":[{"delta":{"content":"still alive"},"finish_reason":"stop"}]}\n\n',
              'data: [DONE]\n\n',
            ];
            for (const c of chunks) {
              await new Promise(r => setTimeout(r, 45));
              if (init?.signal?.aborted) {
                controller.error(init.signal.reason || new Error('aborted'));
                return;
              }
              controller.enqueue(encoder.encode(c));
            }
            controller.close();
          },
        });
        return new Response(body, {
          headers: {'content-type': 'text/event-stream'},
        });
      },
    });
    assert.equal(reply.text, 'still alive');
    assert.equal(reply.stop_reason, 'completed');
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

test('streamModel retries 429 beyond 2 attempts, honors retry-after-ms, and avoids mid-retry circuit break', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-429-retry-'));
  const healthFile = path.join(tmpDir, 'health.json');
  try {
    let calls = 0;
    const reply = await streamModel({
      root: ROOT,
      healthFile,
      timeoutMs: 250,
      config: {
        model: 'fixture',
        baseUrl: 'https://ratelimit.example.test/v1',
        apiMode: 'chat-completions',
        credential: 'fixture',
      },
      system: '',
      messages: [],
      tools: [],
      fetch: async () => {
        calls++;
        if (calls <= 3) {
          return new Response(
            JSON.stringify({error: {type: 'rate_limit_error', message: 'slow down'}}),
            {
              status: 429,
              headers: {
                'content-type': 'application/json',
                'retry-after-ms': '20',
              },
            },
          );
        }
        return new Response(
          JSON.stringify({
            choices: [{message: {content: 'ok after 429'}, finish_reason: 'stop'}],
          }),
          {headers: {'content-type': 'application/json'}},
        );
      },
    });
    assert.equal(calls, 4);
    assert.equal(reply.text, 'ok after 429');
    assert.equal(reply.stop_reason, 'completed');
    const healthRaw = JSON.parse(fs.readFileSync(healthFile, 'utf8'));
    assert.equal(
      Number(healthRaw.entries['https://ratelimit.example.test/v1']?.open_until || 0),
      0,
    );
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

test('conversationFailureMessage formats raw backend_error timeout and 429 strings clearly', () => {
  const timeoutMsg = conversationFailureMessage({
    ok: false,
    error: 'backend_error:model_request_timeout',
  });
  assert.match(timeoutMsg, /超时/);
  assert.match(timeoutMsg, /重试/);
  assert.ok(!timeoutMsg.includes('backend_error:'));

  const rateLimitMsg = conversationFailureMessage({
    ok: false,
    error: 'backend_error:http_429:{"error":{"type":"rate_limit_error"}}',
  });
  assert.match(rateLimitMsg, /限流|429/);
  assert.match(rateLimitMsg, /重试/);
  assert.ok(!rateLimitMsg.includes('backend_error:'));
});
