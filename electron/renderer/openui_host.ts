interface OpenUIBundle {
  React: {
    createElement(type: unknown, props: Record<string, unknown>): unknown;
  };
  createRoot(
    host: HTMLElement,
    options?: Record<string, unknown>,
  ): {
    render(element: unknown): void;
    unmount(): void;
  };
  Renderer: unknown;
  openuiChatLibrary: unknown;
}

declare global {
  var __OpenUI: OpenUIBundle | undefined;
  var OpenUIHost: {
    sync(container: HTMLElement, scope: string, isStreaming: boolean): void;
    dispose(container: HTMLElement): void;
    clearConversation(conversationId: string): void;
  };
}

(() => {
  const scriptUrl =
    (document.currentScript as HTMLScriptElement | null)?.src ||
    document.baseURI;
  let assets: Promise<{bundle: OpenUIBundle; css: string}> | null = null;
  interface Mount {
    owner: HTMLElement;
    host: HTMLElement;
    scope: string;
    blockId: string;
    source: string;
    streaming: boolean;
    complete: boolean;
    disposed: boolean;
    pending: boolean;
    wrapper: HTMLElement;
    root?: ReturnType<OpenUIBundle['createRoot']>;
    bundle?: OpenUIBundle;
    code: HTMLElement;
    notice: HTMLElement;
    details: HTMLDetailsElement;
    themeObserver: MutationObserver;
    initialState: Record<string, unknown>;
    memoryOnly: boolean;
  }
  const containers = new WeakMap<HTMLElement, Map<HTMLElement, Mount>>();
  const activeMounts = new Set<Mount>();
  const removalObserver = new MutationObserver(() => {
    for (const mount of activeMounts) {
      if (!mount.host.isConnected) {
        release(mount);
      }
    }
  });
  const text = (en: string, zh: string) =>
    document.documentElement.lang.startsWith('zh') ? zh : en;
  const storageKey = (scope: string, blockId: string) =>
    `mp:openui:${scope}:${blockId}`;
  function storedState(
    scope: string,
    blockId: string,
  ): Record<string, unknown> {
    try {
      return JSON.parse(
        localStorage.getItem(storageKey(scope, blockId)) || '{}',
      );
    } catch {
      return {};
    }
  }
  function loadAssets(): Promise<{bundle: OpenUIBundle; css: string}> {
    if (!assets) {
      const javascript = globalThis.__OpenUI
        ? Promise.resolve(globalThis.__OpenUI)
        : new Promise<OpenUIBundle>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = new URL(
              '../vendor/openui/openui-bundle.min.js',
              scriptUrl,
            ).href;
            script.onload = () =>
              globalThis.__OpenUI
                ? resolve(globalThis.__OpenUI)
                : reject(new Error('OpenUI renderer did not load'));
            script.onerror = () => {
              script.remove();
              reject(new Error('OpenUI renderer could not be loaded'));
            };
            document.head.append(script);
          });
      const stylesheet = async (url: string) => {
        const response = await fetch(new URL(url, scriptUrl));
        if (!response.ok) {
          throw new Error('OpenUI stylesheet could not be loaded');
        }
        return response.text();
      };
      assets = Promise.all([
        javascript,
        stylesheet('../vendor/openui/openui-styles.css'),
        stylesheet('openui_host.css'),
      ])
        .then(([bundle, official, local]) => {
          if (!document.getElementById('mp-openui-portal-style')) {
            const style = document.createElement('style');
            style.id = 'mp-openui-portal-style';
            // Radix portals live outside the shadow tree. Official selectors
            // use openui names except these text helpers, which need a scope.
            style.textContent = official
              .replace(/data-openui-theme/g, 'data-mp-openui-theme')
              .replace(
                /\.text-content(?:-[\w-]+)?/g,
                ':where([class*="openui-"]) $&',
              );
            document.head.append(style);
          }
          return {
            bundle: {
              ...bundle,
              openuiChatLibrary: OpenUIGraphics.extend(bundle),
            },
            css:
              official
                .replace(/:root:not\(([^)]+)\)/g, ':host(:not($1))')
                .replace(/:root(\[[^\]]+\])/g, ':host($1)')
                .replace(/:root/g, ':host') +
              '\n' +
              local,
          };
        })
        .catch(error => {
          assets = null;
          throw error;
        });
    }
    return assets;
  }
  function failure(mount: Mount, error: unknown): void {
    if (mount.disposed) {
      return;
    }
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'object' && error && 'message' in error
          ? String(error.message)
          : String(error);
    mount.notice.textContent =
      text(
        'This interactive response could not be shown. ',
        '此交互内容无法显示。',
      ) + message;
    mount.notice.dataset.error = 'true';
    mount.details.open = true;
  }
  function render(mount: Mount, bundle: OpenUIBundle): void {
    if (mount.disposed || !mount.root) {
      return;
    }
    mount.code.textContent = mount.source;
    mount.wrapper.inert = mount.pending || mount.streaming || !mount.complete;
    mount.notice.textContent = mount.pending
      ? text('Sending to this task…', '正在发送到当前任务…')
      : mount.streaming || !mount.complete
        ? text('Generating interactive response…', '正在生成交互内容…')
        : '';
    delete mount.notice.dataset.error;
    mount.root.render(
      bundle.React.createElement(bundle.Renderer, {
        response: mount.source,
        library: bundle.openuiChatLibrary,
        isStreaming: mount.streaming || !mount.complete,
        initialState: mount.initialState,
        onStateUpdate: (state: Record<string, unknown>) => {
          if (mount.disposed || mount.streaming || !mount.complete) {
            return;
          }
          try {
            // A binding can also feed other state values, so keep the whole
            // password form in memory rather than guessing which keys to omit.
            mount.memoryOnly ||= Boolean(
              mount.wrapper.querySelector('input[type="password"]'),
            );
            if (mount.memoryOnly) {
              localStorage.removeItem(storageKey(mount.scope, mount.blockId));
              return;
            }
            localStorage.setItem(
              storageKey(mount.scope, mount.blockId),
              JSON.stringify(state),
            );
          } catch {
            mount.notice.textContent = text(
              'Form changes could not be saved on this device.',
              '无法在本机保存表单更改。',
            );
          }
        },
        onAction: (event: unknown) => {
          if (
            !mount.disposed &&
            !mount.streaming &&
            mount.complete &&
            !mount.pending &&
            /^.+#\d+$/.test(mount.scope)
          ) {
            mount.pending = true;
            mount.wrapper.inert = true;
            mount.notice.textContent = text(
              'Sending to this task…',
              '正在发送到当前任务…',
            );
            mount.host.dispatchEvent(
              new CustomEvent('mp:openui-action', {
                bubbles: true,
                composed: true,
                detail: {
                  scope: mount.scope,
                  blockId: mount.blockId,
                  event,
                  respond: (result: {ok: boolean; error?: string}) => {
                    if (mount.disposed) {
                      return;
                    }
                    mount.pending = false;
                    mount.wrapper.inert = mount.streaming || !mount.complete;
                    mount.notice.textContent = result.ok
                      ? text('Sent to this task.', '已发送到当前任务。')
                      : result.error ||
                        text(
                          'Could not send. Please retry.',
                          '未能发送，请重试。',
                        );
                    mount.notice.toggleAttribute('data-error', !result.ok);
                  },
                },
              }),
            );
          }
        },
        onError: (errors: Array<{message?: string}>) => {
          if (!mount.streaming && mount.complete && errors.length) {
            failure(
              mount,
              new Error(
                errors.map(error => error.message || String(error)).join('\n'),
              ),
            );
          }
        },
      }),
    );
  }
  function create(
    owner: HTMLElement,
    host: HTMLElement,
    scope: string,
    blockId: string,
  ): Mount {
    const shadow = host.shadowRoot || host.attachShadow({mode: 'open'});
    const wrapper = document.createElement('div');
    wrapper.className = 'mp-openui-content';
    const notice = document.createElement('p');
    notice.className = 'mp-openui-notice';
    notice.setAttribute('role', 'status');
    const details = document.createElement('details');
    details.className = 'mp-openui-source';
    const summary = document.createElement('summary');
    summary.textContent = text('View source', '查看源码');
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = text('Copy source', '复制源码');
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    pre.append(code);
    details.append(summary, copy, pre);
    shadow.replaceChildren(notice, wrapper, details);
    const applyTheme = () => {
      host.dataset.openuiTheme =
        document.documentElement.dataset.theme === 'dark' ||
        document.body.dataset.theme === 'dark'
          ? 'dark'
          : 'light';
      document.documentElement.dataset.mpOpenuiTheme = host.dataset.openuiTheme;
    };
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    applyTheme();
    const mount: Mount = {
      owner,
      host,
      scope,
      blockId,
      source: host.dataset.openuiSource || '',
      streaming: true,
      complete: false,
      disposed: false,
      pending: false,
      wrapper,
      code,
      notice,
      details,
      themeObserver,
      initialState: storedState(scope, blockId),
      memoryOnly: false,
    };
    activeMounts.add(mount);
    removalObserver.observe(document.body, {childList: true, subtree: true});
    code.textContent = mount.source;
    notice.textContent = text(
      'Loading interactive response…',
      '正在加载交互内容…',
    );
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(mount.source);
        copy.textContent = text('Copied', '已复制');
      } catch {
        details.open = true;
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(code);
        selection?.removeAllRanges();
        selection?.addRange(range);
        notice.textContent = text(
          'Select the source and copy it.',
          '请选中源码并复制。',
        );
      }
    });
    void loadAssets()
      .then(({bundle, css}) => {
        if (mount.disposed) {
          return;
        }
        const style = document.createElement('style');
        style.textContent = css;
        shadow.prepend(style);
        mount.bundle = bundle;
        mount.root = bundle.createRoot(wrapper, {
          onUncaughtError: (error: unknown) => failure(mount, error),
        });
        render(mount, bundle);
      })
      .catch(error => failure(mount, error));
    return mount;
  }
  function release(mount: Mount): void {
    if (mount.disposed) {
      return;
    }
    mount.disposed = true;
    mount.themeObserver.disconnect();
    mount.root?.unmount();
    containers.get(mount.owner)?.delete(mount.host);
    activeMounts.delete(mount);
    if (!activeMounts.size) {
      removalObserver.disconnect();
    }
  }
  globalThis.OpenUIHost = {
    clearConversation(conversationId) {
      if (!conversationId) {
        return;
      }
      const scopePrefix = `${conversationId}#`;
      for (const mount of activeMounts) {
        if (mount.scope.startsWith(scopePrefix)) {
          release(mount);
        }
      }
      const keyPrefix = `mp:openui:${scopePrefix}`;
      for (let index = localStorage.length - 1; index >= 0; index--) {
        const key = localStorage.key(index);
        if (key?.startsWith(keyPrefix)) {
          localStorage.removeItem(key);
        }
      }
    },
    sync(container, scope, isStreaming) {
      let mounts = containers.get(container);
      if (!mounts) {
        mounts = new Map();
        containers.set(container, mounts);
      }
      const hosts = [
        ...container.querySelectorAll<HTMLElement>('[data-openui-source]'),
      ];
      for (const [host, mount] of mounts) {
        if (!hosts.includes(host) || mount.scope !== scope) {
          release(mount);
          mounts.delete(host);
        }
      }
      hosts.forEach((host, index) => {
        const blockId = host.dataset.openuiBlockId || String(index);
        let mount = mounts.get(host);
        if (mount && mount.blockId !== blockId) {
          release(mount);
          mount = undefined;
        }
        if (!mount) {
          mount = create(container, host, scope, blockId);
          mounts.set(host, mount);
        }
        const source = host.dataset.openuiSource || '';
        const complete = host.dataset.openuiComplete === 'true';
        const changed =
          mount.source !== source ||
          mount.streaming !== isStreaming ||
          mount.complete !== complete;
        mount.source = source;
        mount.complete = complete;
        mount.streaming = isStreaming;
        if (changed && mount.bundle) {
          render(mount, mount.bundle);
        }
      });
    },
    dispose(container) {
      for (const mount of activeMounts) {
        if (mount.host === container || container.contains(mount.host)) {
          release(mount);
        }
      }
      containers.delete(container);
    },
  };
})();
