'use strict';

const assert = require('assert');
const { RendererReadiness } = require('../electron/renderer_readiness');

const readiness = new RendererReadiness();
let calls = 0;
const callback = () => { calls += 1; };

assert.strictEqual(readiness.isReady, false);
readiness.whenReady(callback);
readiness.whenReady(callback);
assert.strictEqual(calls, 0, 'work must wait for the renderer handshake');
readiness.markReady();
assert.strictEqual(readiness.isReady, true);
assert.strictEqual(calls, 1, 'the same queued work must not be duplicated');
readiness.markReady();
assert.strictEqual(calls, 1, 'duplicate ready events must not replay old work');

readiness.whenReady(callback);
assert.strictEqual(calls, 2, 'an already-ready renderer runs new work immediately');
readiness.reset();
assert.strictEqual(readiness.isReady, false);
readiness.whenReady(callback);
assert.strictEqual(calls, 2, 'navigation resets the handshake');
readiness.markReady();
assert.strictEqual(calls, 3);

console.log('renderer readiness test ok');
