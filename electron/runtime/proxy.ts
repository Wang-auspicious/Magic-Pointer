/**
 * Make the Node-side fetch honour the environment's proxy.
 *
 * Chromium routes through the system proxy, so the window loads and the app
 * looks healthy — while every model call dies with the bare message
 * `backend_error:fetch failed`. Node's global fetch is backed by undici, and
 * undici reads no proxy environment variable on its own. The app was therefore
 * connecting directly while curl and Chromium went through the proxy.
 *
 * The failure disguises itself. A direct connection to a blocked host gets
 * answered by a redirect appliance whose self-signed certificate surfaces as
 * `DEPTH_ZERO_SELF_SIGNED_CERT`, which reads like a broken TLS setup — and
 * sends you looking for a certificate to trust rather than a route to fix.
 *
 * `EnvHttpProxyAgent` is undici's own implementation of the
 * `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` contract, so the Node side ends up
 * agreeing with curl and with Chromium instead of quietly bypassing both.
 */
import {EnvHttpProxyAgent, setGlobalDispatcher} from 'undici';

const PROXY_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
] as const;

let installed = false;

/** The proxy this process would use, or '' when none is configured. */
export function configuredProxy(env: NodeJS.ProcessEnv = process.env): string {
  for (const key of PROXY_KEYS) {
    const value = String(env[key] || '').trim();
    if (value) {
      return value;
    }
  }
  return '';
}

/**
 * Route this process's fetch through the configured proxy.
 *
 * Called once at process start, before anything can issue a request: the
 * dispatcher is chosen lazily on the first fetch and cannot be corrected
 * afterwards. That timing is the whole reason this is a startup step rather
 * than a property of the request.
 *
 * Returns true when a proxy dispatcher was installed. With no proxy configured
 * the global dispatcher is left exactly as it was, so a machine that connects
 * directly keeps connecting directly.
 */
export function installEnvironmentProxy(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (installed) {
    return true;
  }
  if (!configuredProxy(env)) {
    return false;
  }
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    installed = true;
    return true;
  } catch {
    // A dispatcher problem must never be the reason the app fails to start;
    // without it the request fails with a readable error instead.
    return false;
  }
}
