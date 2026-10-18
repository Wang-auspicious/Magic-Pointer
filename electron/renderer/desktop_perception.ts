declare global {
  interface DesktopPerceptionStatus {
    paused: boolean;
    onboardingRequired: boolean;
    wakeMode: string;
    detectWiggle: boolean;
    detectMouseButton: boolean;
    polling: boolean;
    pointerStateFresh?: boolean;
    hotkeys: Array<{name: string; accelerator: string; registered: boolean}>;
    lastError?: string;
    activity?: import('../perception_activity').PerceptionActivity;
  }

  interface DesktopPerceptionController {
    refresh(): Promise<void>;
    updateStatus(status: DesktopPerceptionStatus): void;
    updateContext(context: MagicPointerTaskContext | null): void;
    updateEvidence(object: unknown): void;
    updateLanguage(): void;
    dispose(): void;
  }

  interface DesktopPerceptionOptions {
    readStatus(): Promise<DesktopPerceptionStatus>;
    activate(): Promise<{ok: boolean; error?: string; state?: string}>;
    setPaused?(paused: boolean): Promise<{ok: boolean; error?: string}>;
    openSettings(page: 'interaction' | 'perception-privacy'): void;
    openMaterials(sourceId?: string): void;
    language(): string;
  }

  var DesktopPerception: {
    create(
      host: HTMLElement,
      options: DesktopPerceptionOptions,
    ): DesktopPerceptionController;
    summarize(
      status: DesktopPerceptionStatus | null,
      language: string,
    ): DesktopPerceptionSummary;
  };
}

interface DesktopPerceptionSummary {
  state: 'unknown' | 'setup' | 'paused' | 'ready' | 'unavailable';
  label: string;
  wiggle: string;
  hotkeys: Array<{label: string; ready: boolean}>;
}

(() => {
  function summarize(
    status: DesktopPerceptionStatus | null,
    language: string,
  ): DesktopPerceptionSummary {
    const zh = language === 'zh-CN';
    const state = !status
      ? 'unknown'
      : status.onboardingRequired
        ? 'setup'
        : status.paused
          ? 'paused'
          : (status.polling &&
                status.pointerStateFresh !== false &&
                (status.detectWiggle || status.detectMouseButton)) ||
              status.hotkeys.some(key => key.registered)
            ? 'ready'
            : 'unavailable';
    const labels = {
      unknown: zh ? '状态未读取' : 'Status unknown',
      setup: zh ? '需要完成首次设置' : 'Setup required',
      paused: zh ? '已暂停' : 'Paused',
      ready: zh ? '可唤醒' : 'Ready to point',
      unavailable: zh ? '唤醒不可用' : 'Wake unavailable',
    };
    return {
      state,
      label: labels[state],
      wiggle: !status
        ? labels.unknown
        : status.paused
          ? labels.paused
          : !status.detectWiggle
            ? zh
              ? '已关闭'
              : 'Off'
            : status.pointerStateFresh === false
              ? zh
                ? '鼠标输入不可用'
                : 'Pointer input unavailable'
              : status.polling
                ? zh
                  ? '正在监听'
                  : 'Listening'
                : zh
                  ? '未在监听'
                  : 'Not listening',
      hotkeys: (status?.hotkeys || []).map(key => ({
        label: key.accelerator,
        ready: key.registered,
      })),
    };
  }

  function create(
    host: HTMLElement,
    options: DesktopPerceptionOptions,
  ): DesktopPerceptionController {
    let status: DesktopPerceptionStatus | null = null;
    let context: MagicPointerTaskContext | null = null;
    let evidence: Record<string, unknown> = {};
    let error = '';
    let loading = false;
    let activating = false;
    let changingPause = false;
    let disposed = false;
    let readGeneration = 0;
    const text = (english: string, chinese: string): string =>
      options.language() === 'zh-CN' ? chinese : english;
    const node = <K extends keyof HTMLElementTagNameMap>(
      tag: K,
      className: string,
      value?: string,
    ): HTMLElementTagNameMap[K] => {
      const element = document.createElement(tag);
      element.className = className;
      if (value !== undefined) {
        element.textContent = value;
      }
      return element;
    };
    const root = node('details', 'mp-desktop-perception');
    const summary = node('summary', 'mp-perception-summary');
    const mark = node('span', 'mp-perception-mark', '↗');
    mark.setAttribute('aria-hidden', 'true');
    const title = node('span', 'mp-perception-title');
    const state = node('span', 'mp-perception-state');
    const count = node('span', 'mp-perception-count');
    summary.append(mark, title, state, count);
    const body = node('div', 'mp-perception-body');
    const intro = node('p', 'mp-perception-intro');
    const channels = node('dl', 'mp-perception-channels');
    const action = node('button', 'mp-perception-action');
    action.type = 'button';
    const actions = node('div', 'mp-perception-actions');
    const pause = node('button', 'mp-perception-link');
    pause.type = 'button';
    pause.dataset.perceptionPause = '';
    pause.hidden = !options.setPaused;
    const settings = node('button', 'mp-perception-link');
    settings.type = 'button';
    settings.dataset.perceptionSettings = '';
    const refresh = node('button', 'mp-perception-link');
    refresh.type = 'button';
    actions.append(action, pause, settings, refresh);
    const notice = node('p', 'mp-perception-notice');
    notice.setAttribute('role', 'status');
    const materials = node('section', 'mp-perception-materials');
    const evidenceHost = node('section', 'mp-perception-evidence');
    const liveHost = node('section', 'mp-perception-live');
    liveHost.dataset.perceptionLive = '';
    liveHost.setAttribute('aria-live', 'polite');
    body.append(intro, channels, actions, notice, liveHost, evidenceHost, materials);
    root.append(summary, body);
    host.replaceChildren(root);

    function record(value: unknown): Record<string, unknown> {
      return value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    }

    function renderEvidence(): void {
      const trace = record(
        evidence.perceptionTrace ?? record(evidence.source).perceptionTrace,
      );
      const attempts = Array.isArray(trace.attempts)
        ? trace.attempts.map(record)
        : [];
      evidenceHost.hidden = !evidence.frameLeaseId && !attempts.length;
      evidenceHost.replaceChildren();
      if (evidenceHost.hidden) {
        return;
      }
      evidenceHost.append(
        node('h3', '', text('Saved screen observation', '已保存的屏幕观察')),
      );
      const capturedAt =
        typeof evidence.capturedAt === 'string'
          ? Date.parse(evidence.capturedAt)
          : NaN;
      const summary = [
        Number.isFinite(capturedAt)
          ? new Date(capturedAt).toLocaleString(options.language())
          : '',
        typeof trace.selectedAdapter === 'string'
          ? text('Selected: ', '采用来源：') + trace.selectedAdapter
          : '',
      ]
        .filter(Boolean)
        .join(' · ');
      evidenceHost.append(
        node(
          'p',
          'mp-perception-evidence-note',
          summary ||
            text(
              'Historical capture; current screen may differ.',
              '历史画面，当前屏幕可能已变化。',
            ),
        ),
      );
      if (!attempts.length) {
        evidenceHost.append(
          node(
            'p',
            'mp-perception-empty',
            text(
              'No provider details were saved with this capture.',
              '此画面未保存读取通道明细。',
            ),
          ),
        );
        return;
      }
      const labels: Record<string, string> =
        options.language() === 'zh-CN'
          ? {
              ok: '已读取',
              degraded: '部分读取',
              empty_confirmed: '已确认无内容',
              busy: '繁忙',
              timeout: '超时',
              unsupported: '不支持',
              denied: '未授权',
              error: '读取失败',
            }
          : {
              ok: 'Read',
              degraded: 'Partial',
              empty_confirmed: 'Empty',
              busy: 'Busy',
              timeout: 'Timed out',
              unsupported: 'Unsupported',
              denied: 'Denied',
              error: 'Failed',
            };
      const list = node('dl', 'mp-perception-providers');
      for (const attempt of attempts) {
        const provider =
          typeof attempt.adapter === 'string'
            ? attempt.adapter
            : text('Unknown provider', '未知通道');
        const state = typeof attempt.status === 'string' ? attempt.status : '';
        const detail = node(
          'dd',
          state === 'error' || state === 'timeout' ? 'is-warning' : '',
        );
        detail.append(
          node('span', '', labels[state] || state || text('Unknown', '未知')),
        );
        const note = [
          typeof attempt.usedBackend === 'string' ? attempt.usedBackend : '',
          typeof attempt.latencyMs === 'number' ? `${Math.round(attempt.latencyMs)} ms` : '',
          attempt.coversMark === false
            ? text('Does not cover selection', '未覆盖指向区域')
            : '',
          typeof attempt.reason === 'string' && attempt.reason !== state
            ? attempt.reason
            : '',
        ]
          .filter(Boolean)
          .join(' · ');
        if (note) {
          detail.append(node('small', '', note));
        }
        list.append(node('dt', '', provider), detail);
      }
      evidenceHost.append(list);
    }

    function renderLive(): void {
      const activity = status?.activity;
      liveHost.hidden = !activity;
      liveHost.replaceChildren();
      if (!activity) {
        return;
      }
      liveHost.append(node('h3', '', activity.state === 'reading'
        ? text('Reading frozen screen', '正在读取已冻结画面')
        : activity.state === 'ready' ? text('Last capture', '最近一次捕获') : text('Capture failed', '捕获失败')));
      const labels: Record<string, string> = {
        reading: text('Reading', '正在读取'), slow: text('Still reading', '仍在读取'),
        fulfilled: text('Completed', '已完成'), rejected: text('Failed', '失败'),
        timeout: text('Timed out', '超时'), cancelled: text('Cancelled', '已取消'),
      };
      const list = node('dl', 'mp-perception-providers');
      for (const provider of activity.providers) {
        const detail = node('dd', '', `${labels[provider.state] || provider.state} · ${Math.round(provider.latencyMs)} ms`);
        if (provider.error) {
          detail.append(node('small', '', provider.error));
        }
        list.append(node('dt', '', provider.provider), detail);
      }
      liveHost.append(list);
      if (activity.error) {
        liveHost.append(node('p', 'mp-perception-notice is-error', activity.error));
      }
    }

    function renderMaterials(): void {
      const sources = context?.sources || [];
      const references = (context?.references || []).filter(
        reference => reference.active,
      );
      count.textContent = sources.length
        ? text(
            `${sources.length} ${sources.length === 1 ? 'source' : 'sources'}`,
            `${sources.length} 份材料`,
          )
        : '';
      const heading = node(
        'h3',
        '',
        text('Evidence in this task', '本任务的现场材料'),
      );
      const description = node(
        'p',
        'mp-perception-evidence-note',
        text(
          'Pointed material is a saved observation. It does not mean the Agent is watching your current screen.',
          '指向材料保留的是当时的证据，不代表 Agent 正在读取你此刻的屏幕。',
        ),
      );
      materials.replaceChildren(heading, description);
      if (!sources.length) {
        materials.append(
          node(
            'p',
            'mp-perception-empty',
            text(
              'No screen material yet. Point at a window, draw a line or circle, then ask about it.',
              '还没有屏幕材料。切到目标窗口，划线或圈选，再告诉 Agent 要做什么。',
            ),
          ),
        );
        return;
      }
      const list = node('div', 'mp-perception-source-list');
      for (const source of sources) {
        const related = references.filter(
          reference => reference.sourceId === source.sourceId,
        );
        const row = node('button', 'mp-perception-source');
        row.type = 'button';
        row.dataset.sourceId = source.sourceId;
        const label = node('strong', '', source.title || source.kind);
        const origin =
          source.origin === 'user-pointed'
            ? text('Pointed on screen', '屏幕指向')
            : source.origin === 'user-attached'
              ? text('Added by you', '你添加的材料')
              : source.origin === 'project'
                ? text('Project material', '项目材料')
                : text('Found during task', '任务中发现');
        const meta = node('small', '', origin);
        if (related.length) {
          const roles: Record<string, string> =
            options.language() === 'zh-CN'
              ? {
                  target: '操作目标',
                  source: '来源',
                  reference: '参考',
                  exclude: '排除',
                  unresolved: '待确认',
                }
              : {
                  target: 'target',
                  source: 'source',
                  reference: 'reference',
                  exclude: 'excluded',
                  unresolved: 'unresolved',
                };
          meta.textContent +=
            ' · ' +
            related
              .map(reference => `${reference.label} (${roles[reference.role]})`)
              .join(', ');
          const captured = Math.max(
            ...related.map(reference => reference.capturedAtMs),
          );
          if (captured > 0) {
            meta.textContent +=
              ' · ' + new Date(captured).toLocaleString(options.language());
          }
        }
        row.append(label, meta);
        row.addEventListener('click', () =>
          options.openMaterials(source.sourceId),
        );
        list.append(row);
      }
      materials.append(list);
    }

    function render(): void {
      if (disposed) {
        return;
      }
      const value = summarize(status, options.language());
      root.dataset.state = value.state;
      title.textContent = text('Point at your screen', '指向屏幕');
      state.textContent = value.label;
      intro.textContent = text(
        'Wiggle the mouse in your target app, then draw a line or circle. Magic Pointer freezes that view before reading the selected material.',
        '在目标应用里晃动鼠标，再划线或圈选。Magic Pointer 会先固定当时画面，再读取你指向的材料。',
      );
      channels.replaceChildren();
      const addChannel = (
        name: string,
        value: string,
        warning = false,
      ): void => {
        const detail = node('dd', warning ? 'is-warning' : '', value);
        channels.append(node('dt', '', name), detail);
      };
      addChannel(
        text('Mouse wiggle', '晃动鼠标'),
        value.wiggle,
        status?.detectWiggle === true && status?.polling === false,
      );
      addChannel(
        text('Shortcut', '快捷键'),
        value.hotkeys.length
          ? value.hotkeys
              .map(
                key =>
                  key.label +
                  (key.ready ? '' : text(' (unavailable)', '（不可用）')),
              )
              .join(' · ')
          : text('None registered', '未注册'),
        value.hotkeys.some(key => !key.ready),
      );
      if (status?.detectMouseButton) {
        addChannel(
          text('Mouse button', '鼠标侧键'),
          status.polling
            ? text('Listening', '正在监听')
            : text('Not listening', '未在监听'),
          !status.polling,
        );
      }
      action.textContent = activating
        ? text('Preparing…', '正在准备…')
        : text('Hide window and point', '隐藏窗口并指向');
      action.disabled =
        activating ||
        changingPause ||
        !status ||
        status.paused ||
        status.onboardingRequired;
      pause.textContent = changingPause
        ? text('Saving…', '正在保存…')
        : status?.paused
          ? text('Resume pointing', '恢复指向')
          : text('Pause pointing', '暂停指向');
      pause.disabled = changingPause || !status || status.onboardingRequired;
      pause.title = text(
        'This changes desktop activation. Running tasks keep going.',
        '此项控制桌面唤醒，不停止正在运行的任务。',
      );
      settings.textContent = text('Wake settings', '唤醒设置');
      refresh.textContent = loading
        ? text('Refreshing…', '正在刷新…')
        : text('Refresh status', '刷新状态');
      refresh.disabled = loading;
      notice.textContent =
        error ||
        status?.lastError ||
        (status?.paused
          ? text(
              'Desktop activation is paused. Running tasks keep going.',
              '桌面唤醒已暂停，正在运行的任务会继续。',
            )
          : status?.onboardingRequired
            ? text(
                'Complete initial setup to use desktop selection.',
                '完成首次设置后即可使用桌面指向。',
              )
            : text(
                'The button hides this window so you can select the app underneath. Esc cancels selection.',
                '点击按钮会隐藏此窗口，让你选择后面的应用；按 Esc 取消。',
              ));
      notice.classList.toggle('is-error', Boolean(error || status?.lastError));
      renderMaterials();
      renderEvidence();
      renderLive();
    }

    async function read(): Promise<void> {
      const generation = ++readGeneration;
      loading = true;
      error = '';
      render();
      try {
        const result = await options.readStatus();
        if (generation !== readGeneration || disposed) {
          return;
        }
        status = result;
      } catch (failure) {
        if (generation !== readGeneration || disposed) {
          return;
        }
        status = null;
        error = failure instanceof Error ? failure.message : String(failure);
      } finally {
        if (generation === readGeneration) {
          loading = false;
          render();
        }
      }
    }

    action.addEventListener('click', async () => {
      if (activating || action.disabled) {
        return;
      }
      activating = true;
      error = '';
      render();
      try {
        const result = await options.activate();
        if (!result.ok) {
          error =
            result.error ||
            text(
              'Could not start selection. Try again.',
              '未能启动指向，请重试。',
            );
        }
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      } finally {
        activating = false;
        render();
      }
    });
    settings.addEventListener('click', () =>
      options.openSettings('interaction'),
    );
    pause.addEventListener('click', async () => {
      if (!options.setPaused || changingPause || !status || pause.disabled) {
        return;
      }
      changingPause = true;
      error = '';
      render();
      try {
        const result = await options.setPaused(!status.paused);
        if (!result.ok) {
          throw new Error(
            result.error ||
              text('Could not change pointing state.', '未能更改指向状态。'),
          );
        }
        await read();
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      } finally {
        changingPause = false;
        render();
      }
    });
    refresh.addEventListener('click', () => void read());
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && root.open) {
        event.preventDefault();
        event.stopPropagation();
        root.open = false;
        summary.focus();
      }
    });
    root.addEventListener('toggle', () => {
      if (root.open) {
        void read();
      }
    });
    render();
    void read();
    return {
      refresh: read,
      updateStatus(next) {
        readGeneration += 1;
        loading = false;
        status = next;
        error = '';
        render();
      },
      updateContext(next) {
        context = next;
        renderMaterials();
      },
      updateEvidence(object) {
        evidence = record(object);
        renderEvidence();
      },
      updateLanguage: render,
      dispose() {
        disposed = true;
        readGeneration += 1;
        root.remove();
      },
    };
  }

  const api = {create, summarize};
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalThis.DesktopPerception = api;
})();
