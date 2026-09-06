import assert from 'node:assert/strict';

import { FigmaRuntimeController } from '../electron/figma_runtime';

class FakeBridge {
  controlToken = 'control-token';
  started = false;
  stopped = false;
  pairedTask = '';
  connections = [{
    taskId: 'task-1',
    documentSessionId: 'document-a',
    documentName: 'Checkout',
    connectedAt: 10,
    lastEventAt: 11,
    selectionIds: ['1:2'],
  }];
  requests: Array<Record<string, unknown>> = [];

  async start() {
    this.started = true;
    return { host: '127.0.0.1' as const, port: 37843, baseUrl: 'http://127.0.0.1:37843' };
  }

  openPairing(taskId: string) {
    this.pairedTask = taskId;
    return { taskId, pairCode: '123456', expiresAt: 5000 };
  }

  connectionSnapshot() { return this.connections; }

  clientConfiguration(taskId: string, documentSessionId: string) {
    return {
      baseUrl: 'http://127.0.0.1:37843',
      controlToken: this.controlToken,
      taskId,
      documentSessionId,
    };
  }

  closeConnection(taskId: string, documentSessionId: string) {
    const before = this.connections.length;
    this.connections = this.connections.filter(
      (item) => item.taskId !== taskId || item.documentSessionId !== documentSessionId,
    );
    return this.connections.length !== before;
  }

  async request(
    taskId: string,
    documentSessionId: string,
    operation: string,
    args: Record<string, unknown>,
  ) {
    this.requests.push({ taskId, documentSessionId, operation, args });
    return { nodes: [{ id: '1:2', name: 'Button' }] };
  }

  async stop() { this.stopped = true; }
}

async function main() {
  const bridge = new FakeBridge();
  const runtime = new FigmaRuntimeController({ bridge: bridge as any });

  const pairing = await runtime.openPairing('task-1');
  assert.equal(bridge.started, true);
  assert.equal(bridge.pairedTask, 'task-1');
  assert.equal(pairing.pairCode, '123456');
  assert.equal(pairing.baseUrl, 'http://127.0.0.1:37843');
  assert.equal(JSON.stringify(pairing).includes(bridge.controlToken), false);

  assert.equal(runtime.status('task-1').connections[0].documentSessionId, 'document-a');
  assert.deepEqual(runtime.clientConfigurations(), [{
    baseUrl: 'http://127.0.0.1:37843',
    controlToken: 'control-token',
    taskId: 'task-1',
    documentSessionId: 'document-a',
    documentName: 'Checkout',
    selectionIds: ['1:2'],
  }]);
  assert.deepEqual(
    await runtime.request('task-1', 'document-a', 'read_selection', {}),
    { nodes: [{ id: '1:2', name: 'Button' }] },
  );
  assert.deepEqual(bridge.requests, [{
    taskId: 'task-1',
    documentSessionId: 'document-a',
    operation: 'read_selection',
    args: {},
  }]);
  assert.equal(runtime.disconnect('task-1', 'document-a'), true);
  assert.deepEqual(runtime.status('task-1').connections, []);

  await runtime.stop();
  assert.equal(bridge.stopped, true);
  console.log('figma runtime test ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
