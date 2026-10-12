'use strict';

// Node's fetch has to be told about the proxy the rest of the machine already
// uses.
//
// The bug this guards: Chromium routes through the system proxy, so the window
// loads and the app looks healthy, while every model call dies with the bare
// message `backend_error:fetch failed`. undici backs Node's global fetch and
// reads no proxy environment variable on its own, so the app was connecting
// direct to a blocked host and being answered by a redirect appliance whose
// self-signed certificate surfaced as DEPTH_ZERO_SELF_SIGNED_CERT — a TLS
// error that was really a routing error.
//
// The property that matters most here is the negative one: a machine with no
// proxy configured must keep connecting directly, unchanged.

const assert = require('node:assert/strict');
const {test} = require('node:test');

const {configuredProxy, installEnvironmentProxy} = require('../electron/runtime/proxy');
const {getGlobalDispatcher, EnvHttpProxyAgent} = require('undici');

test('the proxy is read from the environment in the usual precedence', () => {
  assert.equal(configuredProxy({}), '');
  assert.equal(configuredProxy({HTTPS_PROXY: '  '}), '',
    'a blank value is not a proxy');

  assert.equal(configuredProxy({HTTPS_PROXY: 'http://127.0.0.1:7897'}),
    'http://127.0.0.1:7897');
  assert.equal(configuredProxy({https_proxy: 'http://127.0.0.1:7897'}),
    'http://127.0.0.1:7897',
    'the lowercase spelling curl and most tooling also honour must work');
  assert.equal(configuredProxy({HTTP_PROXY: 'http://127.0.0.1:7897'}),
    'http://127.0.0.1:7897');
  assert.equal(
    configuredProxy({HTTPS_PROXY: 'http://a:1', HTTP_PROXY: 'http://b:2'}),
    'http://a:1',
    'HTTPS_PROXY wins, because the model endpoints are https',
  );
});

test('no proxy configured leaves the dispatcher exactly as it was', () => {
  const before = getGlobalDispatcher();
  assert.equal(installEnvironmentProxy({}), false,
    'installing must report that it did nothing');
  assert.equal(getGlobalDispatcher(), before,
    'a machine that connects directly must keep connecting directly');
});

test('a configured proxy installs the env-aware dispatcher', () => {
  const before = getGlobalDispatcher();
  const installed = installEnvironmentProxy({HTTPS_PROXY: 'http://127.0.0.1:7897'});
  assert.equal(installed, true);
  const after = getGlobalDispatcher();
  assert.notEqual(after, before, 'the global dispatcher must actually change');
  assert.ok(after instanceof EnvHttpProxyAgent,
    'it must be undici\'s own env-contract implementation, so NO_PROXY and friends work');
});

test('installing twice is a no-op rather than a second swap', () => {
  const dispatcher = getGlobalDispatcher();
  assert.equal(installEnvironmentProxy({HTTPS_PROXY: 'http://127.0.0.1:1'}), true);
  assert.equal(getGlobalDispatcher(), dispatcher,
    'the first install wins; a later call must not replace it');
});
