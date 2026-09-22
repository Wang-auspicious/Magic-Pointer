'use strict';


const assert = require('assert');
const Module = require('module');

type Listener = (...args: unknown[]) => void;

const listeners = new Map<string, Listener[]>();
const exposed = new Map<string, Record<string, unknown>>();

const electronStub = {
  contextBridge: {
    exposeInMainWorld(key: string, api: Record<string, unknown>) {
      exposed.set(key, api);
    },
  },
  ipcRenderer: {
    on(channel: string, listener: Listener) {
      const existing = listeners.get(channel) || [];
      existing.push(listener);
      listeners.set(channel, existing);
      return this;
    },
    send() {},
    invoke: async () => undefined,
  },
};

const originalLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === 'electron') return electronStub;
  return originalLoad.call(this, request, ...rest);
};
try {
  require('../electron/preload.ts');
} finally {
  Module._load = originalLoad;
}

const fakeEvent = { sender: { __ipcHandle: true }, ports: [], senderId: 7 };

function fire(channel: string, ...args: unknown[]) {
  const registered = listeners.get(channel) || [];
  assert(registered.length > 0, `no listener registered for ${channel}`);
  for (const listener of registered) listener(...args);
}

const signalSurfaces: Array<[string, string]> = [
  ['magicPointer', 'overlay:hide'],
  ['magicPointerPanel', 'panel:hide'],
  ['magicPointerStage', 'stage:hide'],
];

for (const [surface, channel] of signalSurfaces) {
  const api = exposed.get(surface);
  if (!api) throw new Error(`${surface} was never exposed on the main world`);

  const seen: unknown[][] = [];
  (api.onHide as (callback: (...args: unknown[]) => void) => void)((...args: unknown[]) => {
    seen.push(args);
  });

  fire(channel, fakeEvent);

  assert.strictEqual(seen.length, 1, `${surface}.onHide callback must fire exactly once for ${channel}`);
  assert.deepStrictEqual(
    seen[0],
    [],
    `${surface}.onHide must invoke its callback with no arguments; got ${seen[0].length} `
      + `(the IpcRendererEvent must not cross contextBridge)`,
  );
}

const overlay = exposed.get('magicPointer');
if (!overlay) throw new Error('magicPointer was never exposed on the main world');
const payloadSeen: unknown[][] = [];
(overlay.onShow as (callback: (...args: unknown[]) => void) => void)((...args: unknown[]) => {
  payloadSeen.push(args);
});
fire('overlay:show', fakeEvent, { reason: 'test' });
assert.deepStrictEqual(
  payloadSeen,
  [[{ reason: 'test' }]],
  'payload channels must forward the payload alone, without the IpcRendererEvent',
);

console.log('preload signal bridge test ok');
