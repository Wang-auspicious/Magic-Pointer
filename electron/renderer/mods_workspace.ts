import type {
  ModuleWorkspaceSnapshot,
  ModuleActionRequest,
  ModuleActionResult,
  ModuleContribution,
  ModsPanel,
} from '../runtime/module_contract';

declare global {
  interface ModsWorkspaceController {
    refresh(): Promise<void>;
    invalidate(): void;
    updateLanguage(): void;
    dispose(): void;
  }
  interface ModsWorkspaceOptions {
    list(): Promise<ModuleWorkspaceSnapshot>;
    invoke(
      request: Omit<ModuleActionRequest, 'sessionId'>,
    ): Promise<ModuleActionResult>;
    language(): string;
    visible?(): boolean;
    composeAgentRequest?(
      sessionId: string,
      request: NonNullable<ModuleActionResult['agentRequest']>,
    ): boolean;
  }
  var ModsWorkspace: {
    create(
      host: HTMLElement,
      options: ModsWorkspaceOptions,
    ): ModsWorkspaceController;
  };
}

(() => {
  let sequence = 0;
  function create(
    host: HTMLElement,
    options: ModsWorkspaceOptions,
  ): ModsWorkspaceController {
    let snapshot: ModuleWorkspaceSnapshot | null = null;
    let selected = '';
    let loading = false;
    let error = '';
    let generation = 0;
    let disposed = false;
    let updating = false;
    let invalidated = false;
    let updateQueued = false;
    const pending = new Set<string>();
    const results = new Map<
      string,
      ModuleActionResult & {elapsedMs: number; composed?: boolean}
    >();
    const contentId = `mp-module-content-${++sequence}`;
    const text = (english: string, chinese: string): string =>
      options.language() === 'zh-CN' ? chinese : english;
    const errorText = (message: string): string =>
      message === 'bridge_timeout' || message === 'runtime_snapshot_probe_timeout'
        ? `${text(
            'The module request timed out. Refresh the panel or retry the action.',
            '模块请求超时，请刷新面板或重试操作。',
          )} (${message})`
        : message;
    const element = <K extends keyof HTMLElementTagNameMap>(
      tag: K,
      className: string,
      value?: string,
    ): HTMLElementTagNameMap[K] => {
      const node = document.createElement(tag);
      node.className = className;
      if (value !== undefined) {
        node.textContent = value;
      }
      return node;
    };
    const key = (moduleId: string, panelId: string): string =>
      JSON.stringify([moduleId, panelId]);
    const root = element('section', 'mp-mods-workspace');
    const header = element('header', 'mp-mods-header');
    const heading = element('h2', '');
    const refresh = element('button', 'mp-mods-refresh');
    refresh.type = 'button';
    refresh.dataset.modRefresh = '';
    header.append(heading, refresh);
    const description = element('p', 'mp-mods-description');
    const notice = element('p', 'mp-mods-notice');
    notice.setAttribute('role', 'status');
    const navigation = element('nav', 'mp-mods-navigation');
    navigation.setAttribute('role', 'tablist');
    const content = element('article', 'mp-mods-content');
    content.id = contentId;
    content.setAttribute('role', 'tabpanel');
    root.append(header, description, notice, navigation, content);
    host.replaceChildren(root);

    function panels(): Array<{module: ModuleContribution; panel: ModsPanel}> {
      return (snapshot?.modules || []).flatMap(module =>
        module.panels.map(panel => ({module, panel})),
      );
    }

    function statusLabel(state: ModsPanel['status']['state']): string {
      return {
        ready: text('Ready', '就绪'),
        running: text('Running', '运行中'),
        error: text('Needs attention', '需要处理'),
        disabled: text('Disabled', '已停用'),
      }[state];
    }

    function select(value: string): void {
      selected = value;
      render();
      const active = navigation.querySelector<HTMLButtonElement>(
        '[aria-selected="true"]',
      );
      active?.focus();
    }

    function render(): void {
      if (disposed) {
        return;
      }
      heading.textContent = text('Modules', '模块');
      refresh.textContent =
        loading || updating
          ? text('Refreshing…', '正在刷新…')
          : text('Refresh', '刷新');
      refresh.disabled = loading || updating;
      description.textContent = text(
        'Live module panels for the current task. Actions run through Magic Pointer’s own Runtime.',
        '当前任务的模块面板。操作由 Magic Pointer 自有 Runtime 执行。',
      );
      navigation.setAttribute('aria-label', text('Module panels', '模块面板'));
      const failures = (snapshot?.errors || []).map(item =>
        item.moduleId ? `${item.moduleId}: ${item.message}` : item.message,
      );
      notice.textContent = [errorText(error), ...failures].filter(Boolean).join('\n');
      notice.hidden = !notice.textContent;
      notice.classList.toggle('is-error', Boolean(error || failures.length));
      const entries = panels();
      if (
        snapshot &&
        !entries.some(
          ({module, panel}) => key(module.id, panel.id) === selected,
        )
      ) {
        selected = entries[0]
          ? key(entries[0].module.id, entries[0].panel.id)
          : '';
      }
      navigation.replaceChildren();
      for (const {module, panel} of entries) {
        const identity = key(module.id, panel.id);
        const button = element('button', 'mp-mods-tab');
        button.type = 'button';
        button.id = `${contentId}-tab-${entries.findIndex(entry => entry.panel === panel && entry.module === module)}`;
        button.dataset.modPanel = panel.id;
        button.dataset.moduleId = module.id;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-controls', contentId);
        button.setAttribute('aria-selected', String(selected === identity));
        button.tabIndex = selected === identity ? 0 : -1;
        button.append(
          element('small', '', module.title),
          element('span', '', panel.title),
        );
        button.addEventListener('click', () => select(identity));
        navigation.append(button);
      }
      navigation.hidden = !entries.length;
      content.replaceChildren();
      const entry = entries.find(
        ({module, panel}) => key(module.id, panel.id) === selected,
      );
      if (!entry) {
        content.removeAttribute('aria-labelledby');
        content.append(
          element(
            'p',
            'mp-mods-empty',
            loading
              ? text('Reading module state…', '正在读取模块状态…')
              : errorText(error) ||
                  text(
                    'Open a task to inspect its registered modules and saved context.',
                    '打开一个任务，即可查看已注册模块与保存的上下文。',
                  ),
          ),
        );
        return;
      }
      content.setAttribute(
        'aria-labelledby',
        navigation.querySelector('[aria-selected="true"]')!.id,
      );
      const {module, panel} = entry;
      const identity = key(module.id, panel.id);
      const busy = pending.has(identity);
      const title = element('header', 'mp-mods-panel-header');
      title.append(element('h3', '', panel.title));
      const status = element(
        'span',
        'mp-mods-status',
        busy
          ? text('Working…', '正在执行…')
          : panel.status.label || statusLabel(panel.status.state),
      );
      status.dataset.state = busy ? 'running' : panel.status.state;
      title.append(status);
      content.append(title);
      if (panel.description) {
        content.append(element('p', 'mp-mods-description', panel.description));
      }
      if (panel.status.detail) {
        content.append(element('p', 'mp-mods-detail', panel.status.detail));
      }
      for (const section of panel.sections) {
        const sectionHost = element('section', 'mp-mods-section');
        if (section.title) {
          sectionHost.append(element('h4', '', section.title));
        }
        const rows = element('dl', 'mp-mods-rows');
        for (const row of section.rows) {
          const value = element('dd', '', row.value || '—');
          value.dataset.tone = row.tone || 'neutral';
          rows.append(element('dt', '', row.label), value);
        }
        sectionHost.append(rows);
        if (!section.rows.length && section.title) {
          sectionHost.append(
            element(
              'p',
              'mp-mods-section-empty',
              text('Nothing recorded.', '暂无记录。'),
            ),
          );
        }
        const actions = element('div', 'mp-mods-actions');
        for (const action of section.actions || []) {
          const button = element(
            'button',
            action.primary ? 'is-primary' : '',
            action.label,
          );
          button.type = 'button';
          button.dataset.modAction = action.id;
          button.disabled =
            busy ||
            loading ||
            updating ||
            action.disabled === true ||
            panel.status.state === 'disabled';
          button.addEventListener(
            'click',
            () => void invoke(module.id, panel.id, action.id),
          );
          actions.append(button);
        }
        if (actions.childElementCount) {
          sectionHost.append(actions);
        }
        content.append(sectionHost);
      }
      const result = results.get(identity);
      if (result) {
        const resultHost = element('section', 'mp-mods-result');
        resultHost.dataset.modResult = '';
        resultHost.setAttribute('role', 'status');
        resultHost.classList.toggle('is-error', !result.ok);
        resultHost.append(
          element(
            'h4',
            '',
            result.ok
              ? text('Result', '执行结果')
              : text('Action failed', '操作失败'),
          ),
        );
        resultHost.append(
          element(
            'p',
            '',
            result.ok
              ? result.result?.text || text('Action completed.', '操作已完成。')
              : errorText(result.error || '') ||
                  result.errors?.map(item => item.message).join('\n') ||
                  text('The action did not complete.', '操作未完成。'),
          ),
        );
        const metadata = [
          result.usedBackend,
          typeof result.timingMs === 'number'
            ? text(
                `Execution ${Math.round(result.timingMs)} ms`,
                `执行 ${Math.round(result.timingMs)} ms`,
              )
            : '',
          text(
            `Total ${Math.round(result.elapsedMs)} ms`,
            `总耗时 ${Math.round(result.elapsedMs)} ms`,
          ),
        ].filter(Boolean);
        if (metadata.length) {
          resultHost.append(element('small', '', metadata.join(' · ')));
        }
        if (!result.ok && result.agentRequest && options.composeAgentRequest) {
          const actions = element('div', 'mp-mods-actions');
          const continueButton = element(
            'button',
            '',
            result.composed
              ? text('Added to draft', '已添加到草稿')
              : text('Continue in task', '在任务中继续'),
          );
          continueButton.type = 'button';
          continueButton.dataset.modContinue = '';
          continueButton.disabled = result.composed === true;
          continueButton.addEventListener('click', () => {
            if (result.composed || results.get(identity) !== result) {
              return;
            }
            if (
              options.composeAgentRequest!(
                result.sessionId,
                result.agentRequest!,
              )
            ) {
              result.composed = true;
              render();
            } else {
              notice.textContent = text(
                'Reopen the original task before adding this request.',
                '请回到原任务后再添加此请求。',
              );
              notice.hidden = false;
              notice.classList.add('is-error');
            }
          });
          actions.append(continueButton);
          resultHost.append(
            element(
              'p',
              '',
              text(
                'Adds an editable request to this task’s draft. Review and send it to continue.',
                '将可编辑的请求添加到当前任务草稿。请检查后发送以继续。',
              ),
            ),
            actions,
          );
        }
        content.append(resultHost);
      }
    }

    async function invoke(
      moduleId: string,
      panelId: string,
      actionId: string,
    ): Promise<void> {
      const identity = key(moduleId, panelId);
      if (pending.has(identity) || disposed || loading || updating) {
        return;
      }
      const requestGeneration = generation;
      const started = performance.now();
      pending.add(identity);
      results.delete(identity);
      render();
      try {
        const result = await options.invoke({moduleId, panelId, actionId});
        if (disposed || requestGeneration !== generation) {
          return;
        }
        results.set(identity, {
          ...result,
          elapsedMs: performance.now() - started,
        });
        if (result.ok) {
          snapshot = result;
        }
      } catch (failure) {
        if (disposed || requestGeneration !== generation) {
          return;
        }
        results.set(identity, {
          ok: false,
          sessionId: snapshot?.sessionId || '',
          modules: [],
          errors: [],
          error: failure instanceof Error ? failure.message : String(failure),
          elapsedMs: performance.now() - started,
        });
      } finally {
        if (requestGeneration === generation) {
          pending.delete(identity);
          render();
          scheduleUpdate();
        }
      }
    }

    async function read(): Promise<void> {
      const requestGeneration = ++generation;
      invalidated = false;
      updating = false;
      pending.clear();
      results.clear();
      snapshot = null;
      loading = true;
      error = '';
      render();
      try {
        const next = await options.list();
        if (disposed || requestGeneration !== generation) {
          return;
        }
        snapshot = next;
        error = next.ok
          ? ''
          : next.error ||
            text(
              'Could not read modules for this task.',
              '无法读取当前任务的模块。',
            );
      } catch (failure) {
        if (disposed || requestGeneration !== generation) {
          return;
        }
        error = failure instanceof Error ? failure.message : String(failure);
      } finally {
        if (requestGeneration === generation) {
          loading = false;
          render();
          scheduleUpdate();
        }
      }
    }
    function scheduleUpdate(): void {
      if (
        !invalidated ||
        updateQueued ||
        disposed ||
        loading ||
        updating ||
        pending.size ||
        options.visible?.() === false
      ) {
        return;
      }
      updateQueued = true;
      queueMicrotask(() => {
        updateQueued = false;
        if (
          invalidated &&
          !disposed &&
          !loading &&
          !updating &&
          !pending.size &&
          options.visible?.() !== false
        ) {
          void update();
        }
      });
    }
    async function update(): Promise<void> {
      const requestGeneration = generation;
      invalidated = false;
      updating = true;
      render();
      try {
        const next = await options.list();
        if (disposed || requestGeneration !== generation) {
          return;
        }
        if (next.ok) {
          snapshot = next;
          error = '';
        } else {
          error =
            next.error ||
            text('Could not refresh module state.', '无法刷新模块状态。');
        }
      } catch (failure) {
        if (disposed || requestGeneration !== generation) {
          return;
        }
        error = failure instanceof Error ? failure.message : String(failure);
      } finally {
        if (requestGeneration === generation) {
          updating = false;
          render();
          scheduleUpdate();
        }
      }
    }
    function invalidate(): void {
      invalidated = true;
      scheduleUpdate();
    }
    refresh.addEventListener('click', invalidate);
    navigation.addEventListener('keydown', event => {
      const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
      if (!keys.includes(event.key)) {
        return;
      }
      const entries = panels();
      if (!entries.length) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const current = entries.findIndex(
        ({module, panel}) => key(module.id, panel.id) === selected,
      );
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? entries.length - 1
            : (current +
                (event.key === 'ArrowRight' ? 1 : -1) +
                entries.length) %
              entries.length;
      select(key(entries[next].module.id, entries[next].panel.id));
    });
    render();
    return {
      refresh: read,
      invalidate,
      updateLanguage: render,
      dispose() {
        disposed = true;
        generation++;
        root.remove();
      },
    };
  }
  const api = {create};
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalThis.ModsWorkspace = api;
})();
