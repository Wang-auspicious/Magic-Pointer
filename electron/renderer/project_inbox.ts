import type {ResourceCollectionApi} from '../resource_collection_api';
import type {
  HandoffReceipt,
  HandoffState,
  ProjectInboxEntry,
} from '../resource_collection_contract';

declare global {
  var ProjectInboxView: {
    mount(
      host: HTMLElement,
      projectId: string,
      api: ResourceCollectionApi,
    ): void;
  };
}

(() => {
  const t = (en: string, zh: string) =>
    document.documentElement.lang.startsWith('zh') ? zh : en;
  const escape = (value: unknown) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      character =>
        ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[
          character
        ]!,
    );

  function mount(
    host: HTMLElement,
    projectId: string,
    api: ResourceCollectionApi,
  ): void {
    let entries: ProjectInboxEntry[] = [];
    let receipts: HandoffReceipt[] = [];
    let filter: HandoffState = 'unread';
    let error = '';
    let loading = true;
    let generation = 0;
    const pending = new Set<string>();
    const preview = ResourcePreviewView.create();
    const state = (entry: ProjectInboxEntry): HandoffState =>
      entry.state === 'snoozed' && entry.snoozedUntil <= Date.now()
        ? 'unread'
        : entry.state;

    function paint(): void {
      if (!host.isConnected) {
        return;
      }
      const rows = entries.filter(entry => state(entry) === filter);
      const active = document.activeElement as HTMLElement | null;
      const focusedFilter = host.contains(active)
        ? active?.dataset.handoffFilter
        : undefined;
      const focusedState = host.contains(active)
        ? active?.dataset.handoffState
        : undefined;
      const focusedId = focusedState ? active?.dataset.handoffId : undefined;
      host.innerHTML = `<div class="mp-project-section-heading"><h2>${t('Collected references', '项目交接')}</h2><button type="button" class="mp-project-button" data-handoff-refresh ${loading ? 'disabled' : ''}>${t('Refresh', '刷新')}</button></div>
        <p class="mp-project-context-note">${t('New references travel with your next task. Mark them handled when your work is done.', '新资料随下一次任务带入。工作完成后，可自行标记已处理。')}</p>
        <div class="mp-project-list-tabs" role="group" aria-label="${t('Reference status', '交接状态')}">${(['unread', 'snoozed', 'handled'] as const).map(value => `<button type="button" data-handoff-filter="${value}" aria-pressed="${filter === value}">${{unread: t('New', '待处理'), snoozed: t('Later', '稍后'), handled: t('Handled', '已处理')}[value]} <span>${entries.filter(entry => state(entry) === value).length}</span></button>`).join('')}</div>
        <p class="mp-project-status" role="status" ${error ? '' : 'hidden'}>${escape(error)}</p>
        <div class="mp-project-handoffs" aria-busy="${loading}">${rows
          .map(entry => {
            const receipt = receipts
              .filter(
                item =>
                  item.resourceId === entry.id &&
                  item.version === entry.version,
              )
              .sort((a, b) => b.acceptedAt - a.acceptedAt)[0];
            return `<article data-project-handoff="${escape(entry.id)}"><button type="button" data-handoff-read="${escape(entry.id)}" ${entry.available ? '' : 'disabled'}><strong>${escape(entry.title)}</strong><small>v${entry.version}</small></button><p>${escape(entry.summary || t('Open the saved handoff to read this reference.', '打开交接文件查看资料。'))}</p>
            ${entry.available ? '' : `<small class="mp-project-status">${t('Saved file is missing. Restore it or redeliver the reference.', '交接文件缺失，请恢复文件或重新交接。')}</small>`}
            ${receipt ? `<button type="button" class="mp-project-handoff-receipt" data-open="${escape(receipt.conversationId)}">${t('Sent to task', '已带入任务')} ↗</button>` : ''}
            <div class="mp-project-handoff-actions">${(filter === 'handled' ? (['unread'] as const) : filter === 'snoozed' ? (['unread', 'handled'] as const) : (['snoozed', 'handled'] as const)).map(value => `<button type="button" class="mp-project-button" data-handoff-state="${value}" data-handoff-id="${escape(entry.id)}" ${pending.has(entry.id) ? 'disabled' : ''}>${{unread: t('Bring back', '恢复待处理'), snoozed: t('Tomorrow', '明天提醒'), handled: t('Mark handled', '标记已处理')}[value]}</button>`).join('')}</div></article>`;
          })
          .join(
            '',
          )}${!rows.length ? `<p class="mp-project-empty">${loading ? t('Loading references…', '正在读取交接…') : t('No references here.', '此处暂无交接资料。')}</p>` : ''}</div>`;
      if (focusedFilter || focusedState) {
        const next = focusedState
          ? [
              ...host.querySelectorAll<HTMLButtonElement>(
                '[data-handoff-state]',
              ),
            ].find(
              button =>
                button.dataset.handoffId === focusedId &&
                button.dataset.handoffState === focusedState &&
                !button.disabled,
            )
          : undefined;
        (
          next ||
          host.querySelector<HTMLElement>(
            `[data-handoff-filter="${focusedFilter || filter}"]`,
          )
        )?.focus({preventScroll: true});
      }
    }

    async function refresh(): Promise<void> {
      const current = ++generation;
      loading = true;
      paint();
      try {
        const result = await api.request('project-inbox', {projectId});
        if (current !== generation || !host.isConnected) {
          return;
        }
        if (!result.ok) {
          throw new Error(
            result.error ||
              t('Could not load references.', '无法读取交接资料。'),
          );
        }
        entries = result.handoffs || [];
        receipts = result.handoffReceipts || [];
        error = '';
      } catch (reason) {
        if (current === generation) {
          error = String(reason instanceof Error ? reason.message : reason);
        }
      } finally {
        if (current === generation) {
          loading = false;
          paint();
        }
      }
    }

    host.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>(
        'button',
      );
      if (!button || button.disabled) {
        return;
      }
      if (button.dataset.handoffFilter) {
        filter = button.dataset.handoffFilter as HandoffState;
        paint();
        return;
      }
      if (button.hasAttribute('data-handoff-refresh')) {
        void refresh();
        return;
      }
      const id = button.dataset.handoffId || button.dataset.handoffRead;
      const entry = entries.find(item => item.id === id);
      if (!entry) {
        return;
      }
      if (button.dataset.handoffRead) {
        preview.show({
          title: entry.title,
          subtitle: t('Project handoff', '项目交接'),
          container: host,
          restoreFocus: () => {
            if (button.isConnected) {
              button.focus();
            }
          },
          load: async () => {
            const result = await api.request('preview', {
              id: entry.id,
              material: 'handoff',
            });
            if (!result.ok || !result.preview) {
              throw new Error(
                result.error ||
                  t('Could not open reference.', '无法打开交接资料。'),
              );
            }
            return result.preview;
          },
          openExternal: async () => {
            const result = await api.request('open-original', {
              id: entry.id,
              material: 'handoff',
            });
            if (!result.ok) {
              throw new Error(
                result.error || t('Could not open file.', '无法打开文件。'),
              );
            }
          },
        });
        return;
      }
      if (!button.dataset.handoffState || pending.has(entry.id)) {
        return;
      }
      pending.add(entry.id);
      paint();
      void (async () => {
        try {
          const result = await api.request('handoff-state', {
            id: entry.id,
            revision: entry.revision,
            handoffState: button.dataset.handoffState as HandoffState,
            snoozedUntil: Date.now() + 24 * 60 * 60 * 1000,
          });
          if (!result.ok) {
            throw new Error(
              result.error ||
                t('Could not update reference.', '无法更新交接状态。'),
            );
          }
          await refresh();
        } catch (reason) {
          error = reason instanceof Error ? reason.message : String(reason);
        } finally {
          pending.delete(entry.id);
          paint();
        }
      })();
    });
    void refresh();
  }
  globalThis.ProjectInboxView = {mount};
})();
