import {ActionFailure, type Effect, type ToolRegistry, type ToolSpec} from './tools';

export interface LiveBrowserDaemonCallOptions {
  eager?: boolean;
  callDaemon?: (
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;
}

export async function callLiveBrowserDaemonRpc(
  method: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const daemonUrl = process.env.MAGIC_POINTER_BROWSER_DAEMON_URL;
  const daemonToken = process.env.MAGIC_POINTER_BROWSER_DAEMON_TOKEN;
  if (!daemonUrl || !daemonToken) {
    throw new ActionFailure(
      'tool_error',
      'LiveBrowser daemon is unavailable in this headless runtime; use Fetch / Desktop browser tools instead.',
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  const mergedSignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  try {
    const res = await fetch(`${daemonUrl.replace(/\/$/, '')}/rpc`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mp-browser-token': daemonToken,
      },
      body: JSON.stringify({method, params}),
      signal: mergedSignal,
    });
    const json = (await res.json()) as {
      result?: Record<string, unknown>;
      error?: string;
    };
    if (!res.ok || json.error) {
      throw new ActionFailure(
        'tool_error',
        String(json.error || `live_browser_http_${res.status}`),
      );
    }
    return json.result ?? (json as unknown as Record<string, unknown>);
  } finally {
    clearTimeout(timer);
  }
}

export function liveBrowserActEffect(args: Record<string, unknown>): Effect {
  const topIntent = String(args.intent || '').toLowerCase();
  if (topIntent === 'send' || topIntent === 'submit') {
    return 'external_send';
  }
  if (topIntent === 'delete') {
    return 'destructive';
  }
  if (topIntent === 'purchase') {
    return 'purchase';
  }
  const steps = Array.isArray(args.steps)
    ? (args.steps as Array<Record<string, unknown>>)
    : [];
  for (const step of steps) {
    const stepIntent = String(step?.intent || '').toLowerCase();
    if (stepIntent === 'send' || stepIntent === 'submit') {
      return 'external_send';
    }
    if (stepIntent === 'delete') {
      return 'destructive';
    }
    if (stepIntent === 'purchase') {
      return 'purchase';
    }
    const action = String(step?.action || '').toLowerCase();
    const hint = `${String(step?.selector || '')} ${String(step?.description || '')} ${String(step?.value || '')}`.toLowerCase();
    if (/(delete|remove|destroy|erase|trash|注销|删除)/i.test(hint)) {
      return 'destructive';
    }
    if (/(purchase|checkout|pay|buy|order|下单|付款|支付|购买)/i.test(hint)) {
      return 'purchase';
    }
    if (
      action === 'click' &&
      /(send|submit-message|post-comment|publish|发送|发布|群发|提交订单)/i.test(
        hint,
      )
    ) {
      return 'external_send';
    }
  }
  return 'reversible_write';
}

export function registerLiveBrowserTools(
  registry: ToolRegistry,
  options: LiveBrowserDaemonCallOptions = {},
): void {
  const deferred = !options.eager;
  const invoke = options.callDaemon ?? callLiveBrowserDaemonRpc;

  const string = {type: 'string'};
  const integer = {type: 'integer'};
  const boolean = {type: 'boolean'};
  const targetSchema = {enum: ['studio', 'cdp']};

  const register = (spec: ToolSpec) => {
    registry.register({
      ...spec,
      deferred,
      timeout_ms: spec.timeout_ms ?? 35000,
    });
  };

  register({
    name: 'LiveBrowser.list_tabs',
    description:
      'List Studio’s built-in right-pane Browser tab plus any external logged-in Chrome/Edge CDP tabs (if running with --remote-debugging-port=9222).',
    input_schema: {
      type: 'object',
      properties: {skipCdp: boolean},
      required: [],
      additionalProperties: false,
    },
    effect: 'read',
    is_concurrency_safe: true,
    used_backend: 'live_browser',
    execute: async (args, context) =>
      invoke('list_tabs', args, context.signal),
  });

  register({
    name: 'LiveBrowser.open',
    description:
      'Open an http(s) URL inside Studio’s built-in right-pane live Chromium browser (default target:"studio") or navigate an attached Chrome/Edge CDP tab (target:"cdp"). Returns interactive [b1] DOM refs immediately without moving the user’s mouse.',
    input_schema: {
      type: 'object',
      properties: {
        url: string,
        target: targetSchema,
        tabId: string,
        cdpPort: integer,
        readAfterOpen: boolean,
      },
      required: ['url'],
      additionalProperties: false,
    },
    effect: 'reversible_write',
    resource_keys: ['live_browser:nav'],
    used_backend: 'live_browser',
    execute: async (args, context) =>
      invoke('open', args, context.signal),
  });

  register({
    name: 'LiveBrowser.read_page',
    description:
      'Read interactive DOM elements with [b1], [b2], ... refs plus clean page text from Studio’s live browser or an external CDP tab. Faster, cleaner, and non-disruptive compared to pixel OCR.',
    input_schema: {
      type: 'object',
      properties: {
        target: targetSchema,
        tabId: string,
        cdpPort: integer,
        maxElements: integer,
        includeText: boolean,
      },
      required: [],
      additionalProperties: false,
    },
    effect: 'read',
    is_concurrency_safe: true,
    used_backend: 'live_browser',
    execute: async (args, context) =>
      invoke('read_page', args, context.signal),
  });

  const stepProps = {
    action: {enum: ['click', 'fill', 'select', 'press_key', 'scroll', 'wait']},
    ref: string,
    selector: string,
    value: string,
    key: string,
    dy: integer,
    ms: integer,
    description: string,
    intent: {enum: ['input', 'send', 'submit', 'delete', 'purchase']},
  };

  register({
    name: 'LiveBrowser.act',
    description:
      'Execute up to 16 batched DOM actions (click, React/Vue-safe fill, select, press_key, scroll, wait) inside Studio’s right-pane browser or attached Chrome/Edge CDP tab by [b1] ref or CSS selector. Scrolls into view with a visual highlight pulse without moving the physical OS mouse.',
    input_schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 16,
          items: {
            type: 'object',
            properties: stepProps,
            required: ['action'],
            additionalProperties: false,
          },
        },
        target: targetSchema,
        tabId: string,
        cdpPort: integer,
        includeScreenshot: boolean,
        intent: {enum: ['input', 'send', 'submit', 'delete', 'purchase']},
      },
      required: ['steps'],
      additionalProperties: false,
    },
    effect: 'reversible_write',
    effect_for: liveBrowserActEffect,
    resource_keys: ['live_browser:act'],
    used_backend: 'live_browser',
    timeout_ms: 55000,
    execute: async (args, context) => invoke('act', args, context.signal),
  });

  register({
    name: 'LiveBrowser.screenshot',
    description:
      'Capture a visual JPEG screenshot of Studio’s right-pane live browser or attached Chrome/Edge CDP tab.',
    input_schema: {
      type: 'object',
      properties: {
        target: targetSchema,
        tabId: string,
        cdpPort: integer,
      },
      required: [],
      additionalProperties: false,
    },
    effect: 'read',
    is_concurrency_safe: true,
    used_backend: 'live_browser',
    execute: async (args, context) =>
      invoke('screenshot', args, context.signal),
  });

  register({
    name: 'LiveBrowser.eval',
    description:
      'Evaluate a JavaScript expression inside the active Studio browser page or attached CDP tab for read-only inspection.',
    input_schema: {
      type: 'object',
      properties: {
        expression: string,
        target: targetSchema,
        tabId: string,
        cdpPort: integer,
      },
      required: ['expression'],
      additionalProperties: false,
    },
    effect: 'read',
    is_concurrency_safe: true,
    used_backend: 'live_browser',
    execute: async (args, context) => invoke('eval', args, context.signal),
  });
}
