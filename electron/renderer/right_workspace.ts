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
          note.textContent = '仅显示前 500 行、80 列。';
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
      note.textContent = '预览已截断；在原应用中打开可查看完整文件。';
      host.append(note);
    }
  }

  const api = {renderProjectPreview};
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  (
    globalThis as typeof globalThis & {ProjectPreviewView?: typeof api}
  ).ProjectPreviewView = api;
})();
