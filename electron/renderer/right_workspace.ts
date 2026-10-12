'use strict';

(() => {
  type ParagraphBlock = {
    kind: 'paragraph';
    text: string;
    style?: 'heading' | 'title';
    runs?: Array<{
      text: string;
      bold: boolean;
      italic: boolean;
      underline: boolean;
    }>;
  };
  type TableBlock = {kind: 'table'; rows: string[][]};
  type ProjectPreview =
    | {kind: 'text'; text: string; truncated: boolean}
    | {
        kind: 'document';
        blocks: Array<ParagraphBlock | TableBlock>;
        truncated: boolean;
      }
    | {
        kind: 'spreadsheet';
        sheets: Array<{name: string; rows: string[][]; truncated: boolean}>;
        truncated: boolean;
      };

  type WorkspaceResourceKind =
    'file' | 'artifact' | 'browser' | 'terminal' | 'transcript';

  interface WorkspaceResourceTab {
    id: string;
    kind: WorkspaceResourceKind;
    title: string;
    resourceKey: string;
    active: boolean;
    closable: boolean;
    url?: string;
  }

  interface WorkspaceResourceState {
    activeId: string;
    tabs: WorkspaceResourceTab[];
  }

  interface WorkspaceResourceActions {
    onNewTab?: () => void;
    onMoreActions?: (anchor: HTMLElement) => void;
  }

  interface BrowserPaneInput {
    url?: string;
    title?: string;
  }

  /*
   * Stable user-visible strings for the right pane, keyed by short ids so a
   * future locale layer can map them without touching call sites. English is
   * the default; every value here is the reference wording verbatim.
   */
  const RightPaneLabels = Object.freeze({
    'workspace-tabs': 'Workspace resource tabs',
    'new-tab': 'New tab',
    'more-actions': 'More actions',
    'browser-tab': 'Browser tab',
    'page-thumbnail': 'Page thumbnail',
    'browser-empty-dev-servers':
      'Claude can start your dev servers, browse the web in a built-in ' +
      'browser, and verify changes with screenshots, snapshots, and DOM ' +
      'inspection.',
    'browser-empty-preview':
      'Claude can start dev servers, open a live preview, and verify code ' +
      'changes with screenshots, snapshots, and DOM inspection.',
    'start-dev-server': 'start a dev server',
    'sheet-truncated': 'Showing the first 500 rows and 80 columns.',
    'preview-truncated':
      'Preview truncated. Open in the original app to see the full file.',
  });

  function closeTabLabel(title: string): string {
    return `Close ${title}`;
  }

  function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    return node;
  }

  function renderWorkspaceResourceTabs(
    host: HTMLElement,
    state: WorkspaceResourceState,
    onSelect: (tabId: string) => void,
    onClose: (tabId: string) => void,
    actions?: WorkspaceResourceActions,
  ): void {
    const strip = element('nav', 'mpw-workspace-tabs');
    strip.setAttribute('aria-label', RightPaneLabels['workspace-tabs']);
    state.tabs.forEach(tab => {
      const item = element('div', 'mpw-workspace-tab');
      item.dataset.tabId = tab.id;
      item.dataset.kind = tab.kind;
      item.classList.toggle('is-active', tab.id === state.activeId);
      const select = element('button', 'mpw-workspace-tab-select');
      select.type = 'button';
      select.textContent = tab.title;
      const hint =
        tab.kind === 'browser' && tab.url ? tab.url : tab.title;
      select.title = hint;
      select.setAttribute('aria-selected', String(tab.id === state.activeId));
      select.addEventListener('click', () => onSelect(tab.id));
      item.append(select);
      if (tab.closable) {
        const close = element('button', 'mpw-workspace-tab-close');
        close.type = 'button';
        close.textContent = '×';
        close.title = closeTabLabel(tab.title);
        close.setAttribute('aria-label', closeTabLabel(tab.title));
        close.addEventListener('click', event => {
          event.stopPropagation();
          onClose(tab.id);
        });
        item.append(close);
      }
      strip.append(item);
    });
    if (!actions || (!actions.onNewTab && !actions.onMoreActions)) {
      host.replaceChildren(strip);
      return;
    }
    const bar = element('div', 'mpw-workspace-bar');
    bar.append(strip);
    const toolbar = element('div', 'mpw-workspace-toolbar');
    toolbar.setAttribute('role', 'toolbar');
    if (actions.onNewTab) {
      const create = element('button', 'mpw-workspace-new-tab');
      create.type = 'button';
      create.textContent = '+';
      create.title = RightPaneLabels['new-tab'];
      create.setAttribute('aria-label', RightPaneLabels['new-tab']);
      create.addEventListener('click', () => actions.onNewTab?.());
      toolbar.append(create);
    }
    if (actions.onMoreActions) {
      const more = element('button', 'mpw-workspace-more');
      more.type = 'button';
      more.textContent = '⋯';
      more.title = RightPaneLabels['more-actions'];
      more.setAttribute('aria-label', RightPaneLabels['more-actions']);
      more.addEventListener('click', () => actions.onMoreActions?.(more));
      toolbar.append(more);
    }
    bar.append(toolbar);
    host.replaceChildren(bar);
  }

  function globeIcon(size: number): SVGSVGElement {
    const svg = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'svg',
    );
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'mpw-browser-globe');
    const use = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'use',
    );
    use.setAttribute('href', '#cds-globe-20');
    svg.append(use);
    return svg;
  }

  /*
   * Browser pane for a resource tab. Renders only from the passed input:
   * a real URL produces the address line, anything else produces the
   * truthful empty state. Never invents a URL or a dev server.
   */
  function renderBrowserPane(
    host: HTMLElement,
    input?: BrowserPaneInput,
  ): void {
    const url = String(input?.url || '').trim();
    host.classList.toggle('is-browser-pane', true);
    if (url) {
      const bar = element('div', 'mpw-browser-address');
      bar.append(globeIcon(16));
      const text = element('span', 'mpw-browser-address-text');
      text.textContent = url;
      text.title = url;
      bar.append(text);
      host.replaceChildren(bar);
      return;
    }
    const empty = element('div', 'mpw-browser-empty');
    empty.append(globeIcon(20));
    const heading = element('strong', 'mpw-browser-empty-title');
    heading.textContent = String(
      input?.title || RightPaneLabels['browser-tab'],
    );
    empty.append(heading);
    const first = element('p');
    first.textContent = RightPaneLabels['browser-empty-dev-servers'];
    empty.append(first);
    const second = element('p');
    second.textContent = RightPaneLabels['browser-empty-preview'];
    empty.append(second);
    const hint = element('p', 'mpw-browser-empty-hint');
    hint.textContent = RightPaneLabels['start-dev-server'];
    empty.append(hint);
    host.replaceChildren(empty);
  }

  function table(rows: string[][]): HTMLTableElement {
    const result = element('table', 'mp-preview-table');
    const body = element('tbody');
    rows.forEach((cells, rowIndex) => {
      const row = element('tr');
      const label = element('th');
      label.scope = 'row';
      label.textContent = String(rowIndex + 1);
      row.append(label);
      cells.forEach(value => {
        const cell = element('td');
        cell.textContent = value;
        row.append(cell);
      });
      body.append(row);
    });
    result.append(body);
    return result;
  }

  function renderDocument(
    host: HTMLElement,
    preview: Extract<ProjectPreview, {kind: 'document'}>,
  ): void {
    const page = element('div', 'mp-preview-page');
    preview.blocks.forEach(block => {
      if (block.kind === 'paragraph') {
        const paragraph = element('p');
        if (block.style) {
          paragraph.dataset.style = block.style;
        }
        if (block.runs?.length) {
          block.runs.forEach(run => {
            const span = element('span');
            span.textContent = run.text;
            if (run.bold) {
              span.style.fontWeight = '700';
            }
            if (run.italic) {
              span.style.fontStyle = 'italic';
            }
            if (run.underline) {
              span.style.textDecoration = 'underline';
            }
            paragraph.append(span);
          });
        } else {
          paragraph.textContent = block.text || '\u00a0';
        }
        page.append(paragraph);
      } else {
        const scroll = element('div', 'mp-preview-table-scroll');
        scroll.append(table(block.rows));
        page.append(scroll);
      }
    });
    host.replaceChildren(page);
  }

  function renderSpreadsheet(
    host: HTMLElement,
    preview: Extract<ProjectPreview, {kind: 'spreadsheet'}>,
  ): void {
    const tabs = element('div', 'mp-preview-sheet-tabs');
    tabs.setAttribute('role', 'tablist');
    const content = element('div', 'mp-preview-sheet-content');
    const buttons = preview.sheets.map((sheet, index) => {
      const button = element('button', 'mp-preview-sheet-tab');
      button.type = 'button';
      button.setAttribute('role', 'tab');
      button.textContent = sheet.name;
      button.addEventListener('click', () => {
        buttons.forEach((tab, tabIndex) =>
          tab.setAttribute('aria-selected', String(tabIndex === index)),
        );
        const scroll = element('div', 'mp-preview-table-scroll');
        scroll.append(table(sheet.rows));
        if (sheet.truncated) {
          const note = element('p', 'mp-preview-limit');
          note.textContent = RightPaneLabels['sheet-truncated'];
          scroll.prepend(note);
        }
        content.replaceChildren(scroll);
      });
      tabs.append(button);
      return button;
    });
    host.replaceChildren(tabs, content);
    buttons[0]?.click();
  }

  function renderProjectPreview(
    host: HTMLElement,
    preview: ProjectPreview,
  ): void {
    host.classList.toggle('is-browser-pane', false);
    host.classList.toggle('is-office-preview', preview.kind !== 'text');
    if (preview.kind === 'text') {
      const code = element('pre');
      code.textContent = preview.text;
      host.replaceChildren(code);
    } else if (preview.kind === 'document') {
      renderDocument(host, preview);
    } else {
      renderSpreadsheet(host, preview);
    }
    if (preview.truncated && preview.kind !== 'spreadsheet') {
      const note = element('p', 'mp-preview-limit');
      note.textContent = RightPaneLabels['preview-truncated'];
      host.append(note);
    }
  }

  const api = {
    renderProjectPreview,
    renderWorkspaceResourceTabs,
    renderBrowserPane,
    RightPaneLabels,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  (
    globalThis as typeof globalThis & {ProjectPreviewView?: typeof api}
  ).ProjectPreviewView = api;
})();
