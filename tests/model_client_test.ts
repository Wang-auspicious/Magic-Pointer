import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listModels, requestText, type ModelConfig } from '../electron/runtime/model';
import { expandPassage } from '../electron/runtime/text';

async function main() {
  const requests: { path: string; headers: Record<string, unknown>; body: Record<string, any> }[] = [];
  let respond = (_body: Record<string, any>): [number, unknown] => [200, { choices: [{ message: { content: '完整回答' }, finish_reason: 'stop' }] }];
  let responseDelay = 0;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body || '{}');
    requests.push({ path: request.url!, headers: request.headers, body: parsed });
    const [status, data] = respond(parsed);
    if (responseDelay) await new Promise(resolve => setTimeout(resolve, responseDelay));
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(data));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const config: ModelConfig = { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test-model', credential: 'private-key', apiMode: 'chat-completions' };
  const scratch = mkdtempSync(join(tmpdir(), 'mp-ts-model-'));
  try {
    const reply = await requestText(config, { prompt: '问题', context: '实际上下文', system: '系统指令' });
    assert.equal(reply.text, '完整回答');
    assert.equal(reply.usedBackend, 'test-model');
    assert(reply.latencyMs >= 0);
    assert.equal(requests.at(-1)!.path, '/v1/chat/completions');
    assert.equal(requests.at(-1)!.headers.authorization, 'Bearer private-key');
    assert.equal(requests.at(-1)!.body.messages[1].content, '问题\n\n实际上下文');
    await requestText({ ...config, effort: 'xhigh' }, { prompt: '问题' });
    assert.equal(requests.at(-1)!.body.reasoning_effort, 'xhigh');

    respond = () => [200, { content: [{ type: 'thinking', thinking: '内部推理' }, { type: 'text', text: '消息协议' }], stop_reason: 'end_turn' }];
    assert.equal((await requestText({ ...config, apiMode: 'messages' }, { prompt: '问题' })).text, '消息协议');
    assert.equal(requests.at(-1)!.path, '/v1/messages');
    assert.equal(requests.at(-1)!.headers['x-api-key'], 'private-key');
    assert.equal(requests.at(-1)!.body.thinking.type, 'disabled');

    respond = () => [200, { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '响应协议' }] }] }];
    assert.equal((await requestText({ ...config, apiMode: 'responses' }, { prompt: '问题' })).text, '响应协议');
    assert.equal(requests.at(-1)!.path, '/v1/responses');
    assert.equal(requests.at(-1)!.body.input[0].content[0].text, '问题');

    respond = body => body.thinking ? [400, { error: 'unsupported thinking' }] : [200, { choices: [{ message: { content: '重试完成' }, finish_reason: 'stop' }] }];
    const before = requests.length;
    assert.equal((await requestText(config, { prompt: '问题' })).text, '重试完成');
    assert.equal(requests.length - before, 2);
    assert.equal(requests.at(-1)!.body.thinking, undefined);

    respond = body => [200, { choices: [{ message: { content: body.thinking ? '' : '空回答重试完成' }, finish_reason: body.thinking ? 'length' : 'stop' }] }];
    assert.equal((await requestText(config, { prompt: '问题' })).text, '空回答重试完成');

    respond = () => [200, { choices: [{ message: { content: '被截断的正文' }, finish_reason: 'length' }] }];
    await assert.rejects(requestText(config, { prompt: '问题' }), /未完成.*length/);
    const count = requests.length;
    await assert.rejects(requestText({ ...config, credential: '' }, { prompt: '问题' }), /密钥/);
    assert.equal(requests.length, count);

    respond = () => [401, { error: 'private-key rejected' }];
    await assert.rejects(requestText(config, { prompt: '问题' }), error => error instanceof Error && /HTTP 401/.test(error.message) && !error.message.includes('private-key'));
    const healthFile = join(scratch, 'model-health.json');
    await assert.rejects(requestText(config, { prompt: '问题', healthFile }), /HTTP 401/);
    const blockedAt = requests.length;
    await assert.rejects(requestText(config, { prompt: '问题', healthFile }), /unauthorized/);
    assert.equal(requests.length, blockedAt);
    assert(!readFileSync(healthFile, 'utf8').includes('private-key'));

    respond = () => [200, { choices: [{ message: { content: '完整回答' }, finish_reason: 'stop' }] }];
    const other = { ...config, baseUrl: `${config.baseUrl}/other` };
    assert.equal((await requestText(other, { prompt: '问题', healthFile })).text, '完整回答');
    responseDelay = 100;
    await assert.rejects(requestText(other, { prompt: '问题', timeoutMs: 20, healthFile }), /timeout|timed out/i);
    responseDelay = 0;
    assert.equal((await requestText(other, { prompt: '问题', healthFile })).text, '完整回答');

    respond = () => [200, { data: [{ id: 'declared-model', context_length: 512000, vision: true }] }];
    const catalog = await listModels(config);
    assert.equal(catalog.source, 'gateway');
    assert.equal(catalog.groups[0].models[0].id, config.model);
    assert.equal(catalog.groups[0].models[1].contextWindow, 512000);
    assert.equal(requests.at(-1)!.path, '/v1/models');
    const countBeforeDeclared = requests.length;
    const declared = await listModels({ ...config, models: [{ id: 'gpt-5.6' }] });
    assert.equal(requests.length, countBeforeDeclared);
    assert.equal(declared.source, 'profile');
    assert.equal(declared.groups[0].models[1].contextWindow, 1050000);
    respond = () => [403, { error: 'private-key refused' }];
    const failedCatalog = await listModels(config);
    assert.equal(failedCatalog.current, config.model);
    assert(failedCatalog.error.includes('403'));
    assert(!failedCatalog.error.includes('private-key'));

    respond = () => [200, { choices: [{ message: { content: '这是一段展开后的详细文字，补充了原文省略的步骤，并把原文已有的意思说明白。' }, finish_reason: 'stop' }] }];
    const expanded = await expandPassage('这是一段需要展开的文字。', '已有上下文', config);
    assert.equal(expanded.ok, true);
    assert(expanded.resultChars! > expanded.sourceChars!);
    assert.equal(expanded.usedBackend, 'test-model');
    assert.equal((await expandPassage('短句', '', config)).ok, false);
    assert.equal((await expandPassage('字'.repeat(4001), '', config)).ok, false);
    respond = () => [200, { choices: [{ message: { content: '短回答' }, finish_reason: 'stop' }] }];
    assert.equal((await expandPassage('这是一段需要展开的文字。', '', config)).ok, false);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(requestText(config, { prompt: '问题', signal: cancelled.signal }), /abort/i);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log('TS model transport and inline expansion passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
