import assert from 'node:assert/strict';

import { FigmaLoopbackBridge } from '../electron/figma_bridge';

async function request(
  baseUrl: string,
  path: string,
  options: RequestInit = {},
) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) as Record<string, any> : {},
  };
}

async function main() {
  const bridge = new FigmaLoopbackBridge({ port: 0 });
  const pairing = bridge.openPairing('task-figma', 'PAIR-1234');
  const address = await bridge.start();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const preflight = await fetch(`${baseUrl}/pair`, {
    method: 'OPTIONS',
    headers: { Origin: 'null' },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers') || '', /authorization/i);

  const denied = await request(baseUrl, '/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairCode: 'WRONG',
      documentSessionId: 'document-a',
      documentName: 'Design A',
    }),
  });
  assert.equal(denied.response.status, 403);

  const paired = await request(baseUrl, '/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pairCode: pairing.pairCode,
      documentSessionId: 'document-a',
      documentName: 'Design A',
    }),
  });
  assert.equal(paired.response.status, 200);
  assert.equal(paired.body.taskId, 'task-figma');
  const pluginToken = String(paired.body.pluginToken);
  assert.ok(pluginToken.length >= 24);
  assert.deepEqual(bridge.clientConfiguration('task-figma', 'document-a'), {
    baseUrl,
    controlToken: bridge.controlToken,
    taskId: 'task-figma',
    documentSessionId: 'document-a',
  });
  assert.equal(JSON.stringify(bridge.connectionSnapshot()).includes(pluginToken), false);

  await request(baseUrl, '/events', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${pluginToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      taskId: 'task-figma',
      documentSessionId: 'document-a',
      status: 'connected',
      pageId: '0:7',
      pageName: 'Checkout',
      selectionIds: ['1:2'],
    }),
  });
  assert.deepEqual(bridge.connectionSnapshot()[0].selectionIds, ['1:2']);
  assert.equal(bridge.connectionSnapshot()[0].pageId, '0:7');

  const wrongDocument = await request(baseUrl, '/requests', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bridge.controlToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      taskId: 'task-figma',
      documentSessionId: 'document-b',
      operation: 'read_nodes',
      arguments: { nodeIds: ['1:2'] },
    }),
  });
  assert.equal(wrongDocument.response.status, 409);

  const queued = await request(baseUrl, '/requests', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bridge.controlToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      taskId: 'task-figma',
      documentSessionId: 'document-a',
      operation: 'read_nodes',
      arguments: { nodeIds: ['1:2'] },
    }),
  });
  assert.equal(queued.response.status, 202);
  const commandId = String(queued.body.commandId);

  const commands = await request(baseUrl, '/commands', {
    headers: { authorization: `Bearer ${pluginToken}` },
  });
  assert.equal(commands.response.status, 200);
  assert.equal(commands.body.commands.length, 1);
  assert.equal(commands.body.commands[0].commandId, commandId);
  assert.equal(commands.body.commands[0].documentSessionId, 'document-a');

  const posted = await request(baseUrl, '/results', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${pluginToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      commandId,
      taskId: 'task-figma',
      documentSessionId: 'document-a',
      ok: true,
      result: { nodes: [{ id: '1:2', name: 'Button' }] },
    }),
  });
  assert.equal(posted.response.status, 200);

  const result = await request(baseUrl, `/results/${encodeURIComponent(commandId)}`, {
    headers: { authorization: `Bearer ${bridge.controlToken}` },
  });
  assert.equal(result.body.status, 'completed');
  assert.equal(result.body.result.nodes[0].name, 'Button');

  const directResult = bridge.request(
    'task-figma',
    'document-a',
    'export_preview',
    { nodeId: '1:2' },
    { timeoutMs: 2_000, pollIntervalMs: 5 },
  );
  let directCommand: Record<string, any> | undefined;
  for (let attempt = 0; attempt < 20 && !directCommand; attempt += 1) {
    const pulled = await request(baseUrl, '/commands', {
      headers: { authorization: `Bearer ${pluginToken}` },
    });
    directCommand = pulled.body.commands?.[0];
    if (!directCommand) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(directCommand?.operation, 'export_preview');
  await request(baseUrl, '/results', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${pluginToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      commandId: directCommand?.commandId,
      taskId: 'task-figma',
      documentSessionId: 'document-a',
      ok: true,
      result: { nodeId: '1:2', mimeType: 'image/png', base64: 'iVBORw0KGgo=' },
    }),
  });
  assert.deepEqual(await directResult, {
    nodeId: '1:2',
    mimeType: 'image/png',
    base64: 'iVBORw0KGgo=',
  });

  const undelivered = await request(baseUrl, '/requests', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bridge.controlToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      taskId: 'task-figma',
      documentSessionId: 'document-a',
      operation: 'read_parent',
      arguments: { nodeId: '1:2' },
    }),
  });
  await request(baseUrl, '/events', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${pluginToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      taskId: 'task-figma',
      documentSessionId: 'document-a',
      status: 'disconnected',
    }),
  });
  const cancelled = await request(
    baseUrl,
    `/results/${encodeURIComponent(String(undelivered.body.commandId))}`,
    { headers: { authorization: `Bearer ${bridge.controlToken}` } },
  );
  assert.equal(cancelled.body.status, 'cancelled');

  await bridge.stop();
  console.log('figma bridge test ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
