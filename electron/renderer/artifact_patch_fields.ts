declare global {
  var ArtifactPatchFields: {
    render(
      operation: Record<string, unknown>,
      index: number,
      disabled: boolean,
    ): string;
    read(
      host: HTMLElement,
      operations: Array<Record<string, unknown>>,
    ): Array<Record<string, unknown>>;
    editText(event: KeyboardEvent | ClipboardEvent): void;
  };
}

(() => {
  type Data = Record<string, unknown>;
  type ValuePath = Array<string | number>;
  const object = (value: unknown): Data =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Data)
      : {};
  const escape = (value: unknown): string =>
    String(value ?? '').replace(
      /[&<>"']/g,
      char =>
        ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[
          char
        ]!,
    );
  const t = (key: string): string => studioT(`patch.${key}`);
  const kind = (value: unknown): string =>
    value === null ? 'blank' : typeof value;
  const color = (value: number): string =>
    `#${[value & 255, (value >> 8) & 255, (value >> 16) & 255]
      .map(channel => channel.toString(16).padStart(2, '0'))
      .join('')}`;
  function label(key: string): string {
    const known = [
      'text',
      'path',
      'content',
      'width',
      'height',
      'left',
      'top',
      'x',
      'y',
      'rotation',
      'fontSize',
      'fontName',
      'bold',
      'italic',
      'underline',
      'fillRgb',
      'lineRgb',
      'colorRgb',
      'spacing',
      'itemSpacing',
      'paddingLeft',
      'paddingRight',
      'paddingTop',
      'paddingBottom',
    ];
    return known.includes(key)
      ? t(key)
      : key.replace(/([a-z])([A-Z])/g, '$1 $2');
  }
  function display(value: unknown, key = ''): string {
    if (value === null || value === undefined) {
      return t('blank');
    }
    if (typeof value === 'boolean') {
      return t(value ? 'true' : 'false');
    }
    if (/Rgb$/.test(key) && typeof value === 'number') {
      return color(value);
    }
    return String(value);
  }
  function address(range: string, row: number, column: number): string {
    const match = /^\$?([A-Z]+)\$?(\d+)/i.exec(range);
    if (!match) {
      return `${row + 1}, ${column + 1}`;
    }
    let ordinal =
      [...match[1].toUpperCase()].reduce(
        (n, char) => n * 26 + char.charCodeAt(0) - 64,
        0,
      ) + column;
    let letters = '';
    while (ordinal > 0) {
      ordinal--;
      letters = String.fromCharCode(65 + (ordinal % 26)) + letters;
      ordinal = Math.floor(ordinal / 26);
    }
    return `${letters}${Number(match[2]) + row}`;
  }
  function target(operation: Data): string {
    const locator = object(operation.locator);
    const value = object(locator.value);
    if (locator.kind === 'cell-range') {
      return `${value.sheet || ''}!${value.range || ''}`;
    }
    if (locator.kind === 'slide-shape') {
      return `${t('slide')} ${value.slideId ?? value.slideIndex ?? ''} · ${t('shape')} ${value.shapeId ?? value.shapeIndex ?? ''}`;
    }
    if (value.story) {
      return `${t(String(value.story))}${value.sectionIndex === undefined ? '' : ` · ${t('section')} ${Number(value.sectionIndex) + 1}`}`;
    }
    if (value.nodeId) {
      return `${t('node')} ${value.nodeId}`;
    }
    if (value.page !== undefined || value.pageIndex !== undefined) {
      return `${t('page')} ${value.page ?? Number(value.pageIndex) + 1}`;
    }
    return String(
      value.path || object(operation.after).path || operation.referenceId || '',
    );
  }
  function attrs(
    index: number,
    path: ValuePath,
    valueKind: string,
    disabled: boolean,
  ): string {
    return `data-artifact-operation-index="${index}" data-value-path="${escape(JSON.stringify(path))}" data-value-kind="${valueKind}" ${disabled ? 'disabled' : ''}`;
  }
  function scalar(
    value: unknown,
    index: number,
    path: ValuePath,
    disabled: boolean,
    cell = false,
  ): string {
    const key = String(path.at(-1) ?? '');
    const valueKind = kind(value);
    const attributes = attrs(index, path, valueKind, disabled);
    if (cell) {
      return `<div class="mp-patch-cell-input" data-cell-editor>
        <textarea rows="${Math.min(4, String(value ?? '').split('\n').length)}" ${attributes} aria-label="${escape(t('after'))}" ${valueKind === 'blank' ? 'readonly' : ''}>${escape(value ?? '')}</textarea>
        <select data-cell-type aria-label="${escape(t('value_type'))}" ${disabled ? 'disabled' : ''}>${['number', 'string', 'boolean', 'blank'].map(type => `<option value="${type}" ${valueKind === type ? 'selected' : ''}>${escape(t(type))}</option>`).join('')}</select>
      </div>`;
    }
    if (typeof value === 'boolean') {
      return `<input type="checkbox" ${attributes} ${value ? 'checked' : ''}>`;
    }
    if (/Rgb$/.test(key) && (value === null || typeof value === 'number')) {
      return `<div class="mp-patch-color" data-optional-color><input type="color" ${attrs(index, path, 'color', disabled)} value="${color(Number(value))}" ${value === null ? 'disabled' : ''}><label><input type="checkbox" data-color-none ${value === null ? 'checked' : ''} ${disabled ? 'disabled' : ''}>${escape(t('no_color'))}</label></div>`;
    }
    if (value === null) {
      return scalar(value, index, path, disabled, true);
    }
    if (typeof value === 'number') {
      return `<input type="number" step="any" ${attributes} value="${value}" required>`;
    }
    return `<textarea rows="${String(value).includes('\n') || ['text', 'content'].includes(key) || !path.length ? '4' : '1'}" ${attributes}>${escape(value)}</textarea>`;
  }
  function before(value: unknown, key = ''): string {
    if (value !== null && typeof value === 'object') {
      return `<dl class="mp-patch-values">${Object.entries(value)
        .map(
          ([name, child]) =>
            `<div><dt>${escape(label(name))}</dt><dd>${before(child, name)}</dd></div>`,
        )
        .join('')}</dl>`;
    }
    return `<span>${escape(display(value, key))}</span>`;
  }
  function fields(
    value: unknown,
    index: number,
    path: ValuePath,
    disabled: boolean,
  ): string {
    if (value !== null && typeof value === 'object') {
      return `<div class="mp-patch-fields">${Object.entries(value)
        .map(
          ([key, child]) =>
            `<fieldset><legend>${escape(Array.isArray(value) ? `${t('item')} ${Number(key) + 1}` : label(key))}</legend>${fields(child, index, [...path, Array.isArray(value) ? Number(key) : key], disabled)}</fieldset>`,
        )
        .join('')}</div>`;
    }
    return scalar(value, index, path, disabled);
  }
  function richText(
    value: Data,
    editable: boolean,
    index: number,
    disabled: boolean,
  ): string {
    const text = String(value.text || '');
    const spans = Array.isArray(value.styleSpans)
      ? value.styleSpans.map(object)
      : [];
    let offset = 0;
    let html = '';
    for (const span of spans) {
      const start = Number(span.start);
      const end = start + Number(span.length);
      html += escape(text.slice(offset, start));
      const style = `font-family:${String(span.fontName).replace(/[;"<>]/g, '')};font-size:${Number(span.fontSize)}pt;font-weight:${span.bold ? '700' : '400'};font-style:${span.italic ? 'italic' : 'normal'};text-decoration:${span.underline ? 'underline' : 'none'};color:${color(Number(span.colorRgb))}`;
      html += `<span data-font-size="${Number(span.fontSize)}" style="${escape(style)}">${escape(text.slice(start, end))}</span>`;
      offset = end;
    }
    html += escape(text.slice(offset));
    return `<div class="mp-patch-rich-text" ${editable ? `${attrs(index, [], 'styled-text', false)} contenteditable="${disabled ? 'false' : 'true'}" role="textbox" aria-multiline="true" aria-label="${escape(t('after'))}"` : ''}>${html}</div>`;
  }
  function render(operation: Data, index: number, disabled: boolean): string {
    const previous = operation.before;
    const next = operation.after;
    const header = `<header><strong>${escape(t(String(operation.operation)))}</strong><span>${escape(target(operation))}</span></header>`;
    if (operation.operation === 'set_cell_values' && Array.isArray(next)) {
      const old = Array.isArray(previous) ? previous : [];
      const range = String(object(object(operation.locator).value).range || '');
      return `${header}<div class="mp-patch-table-scroll"><table class="mp-patch-cell-table"><thead><tr><th>${escape(t('cell'))}</th><th>${escape(t('before'))}</th><th>${escape(t('after'))}</th></tr></thead><tbody>${next.flatMap((raw: unknown, row: number) => (Array.isArray(raw) ? raw : []).map((value: unknown, column: number) => `<tr><th scope="row">${escape(address(range, row, column))}</th><td>${escape(display(old[row]?.[column]))}</td><td>${scalar(value, index, [row, column], disabled, true)}</td></tr>`)).join('')}</tbody></table></div>`;
    }
    const styled =
      operation.operation === 'set_shape_text' &&
      Array.isArray(object(next).styleSpans);
    return `${header}<section class="mp-patch-before"><h4>${escape(t('before'))}</h4>${styled ? richText(object(previous), false, index, disabled) : before(previous)}</section><section class="mp-patch-after"><h4>${escape(t('after'))}</h4>${styled ? richText(object(next), true, index, disabled) : fields(next, index, [], disabled)}</section>`;
  }
  function styledValue(field: HTMLElement, original: Data): Data {
    let text = '';
    const styleSpans: Data[] = [];
    const walker = document.createTreeWalker(field, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const content = node.textContent || '';
      if (content) {
        const style = getComputedStyle(node.parentElement!);
        const inherited =
          node.parentElement!.closest<HTMLElement>('[data-font-size]');
        const fontSize =
          inherited && getComputedStyle(inherited).fontSize === style.fontSize
            ? Number(inherited.dataset.fontSize)
            : Math.round(Number.parseFloat(style.fontSize) * 750) / 1000;
        const rgb = style.color.match(/[\d.]+/g)?.map(Number) || [0, 0, 0];
        const span: Data = {
          start: text.length,
          length: content.length,
          bold: Number(style.fontWeight) >= 600,
          italic: style.fontStyle === 'italic',
          underline: style.textDecorationLine.includes('underline'),
          fontName: style.fontFamily
            .split(',')[0]
            .trim()
            .replace(/^['"]|['"]$/g, ''),
          fontSize,
          colorRgb: rgb[0] + rgb[1] * 256 + rgb[2] * 65536,
        };
        text += content;
        const prior = styleSpans.at(-1);
        if (
          prior &&
          [
            'bold',
            'italic',
            'underline',
            'fontName',
            'fontSize',
            'colorRgb',
          ].every(key => prior[key] === span[key])
        ) {
          prior.length = Number(prior.length) + content.length;
        } else {
          styleSpans.push(span);
        }
      }
      node = walker.nextNode();
    }
    return {...original, text, styleSpans};
  }
  function read(host: HTMLElement, operations: Data[]): Data[] {
    const next = structuredClone(operations);
    let error = '';
    for (const node of host.querySelectorAll<HTMLElement>(
      '[data-value-path]',
    )) {
      const index = Number(node.dataset.artifactOperationIndex);
      const path = JSON.parse(node.dataset.valuePath || '[]') as ValuePath;
      const field = node as HTMLInputElement | HTMLTextAreaElement;
      if (field.setCustomValidity) {
        field.setCustomValidity('');
      }
      const cellType = node
        .closest('[data-cell-editor]')
        ?.querySelector<HTMLSelectElement>('[data-cell-type]');
      const type = cellType?.value || node.dataset.valueKind;
      let value: unknown = field.value;
      let invalid = '';
      if (type === 'styled-text') {
        value = styledValue(node, object(next[index].after));
      } else if (type === 'number') {
        value = Number(field.value);
        if (
          !field.value.trim() ||
          !Number.isFinite(value) ||
          !field.validity.valid
        ) {
          invalid = t('invalid_number');
        }
      } else if (type === 'boolean') {
        if (cellType) {
          if (!/^(true|false)$/i.test(field.value.trim())) {
            invalid = t('invalid_boolean');
          }
          value = field.value.trim().toLowerCase() === 'true';
        } else {
          value = (field as HTMLInputElement).checked;
        }
      } else if (type === 'blank') {
        value = cellType || !field.value ? null : field.value;
      } else if (type === 'color') {
        const hex = field.value.slice(1);
        value =
          Number.parseInt(hex.slice(0, 2), 16) +
          Number.parseInt(hex.slice(2, 4), 16) * 256 +
          Number.parseInt(hex.slice(4, 6), 16) * 65536;
        if (
          node
            .closest('[data-optional-color]')
            ?.querySelector<HTMLInputElement>('[data-color-none]')?.checked
        ) {
          value = null;
        }
      }
      if (field.setCustomValidity) {
        field.setCustomValidity(invalid);
      }
      node.setAttribute('aria-invalid', String(Boolean(invalid)));
      if (invalid) {
        error ||= invalid;
        continue;
      }
      if (!path.length) {
        next[index].after = value;
      } else {
        let parent = next[index].after as Record<string | number, unknown>;
        for (const key of path.slice(0, -1)) {
          parent = parent[key] as Record<string | number, unknown>;
        }
        parent[path.at(-1)!] = value;
      }
    }
    if (error) {
      throw new Error(error);
    }
    return next;
  }
  function editText(event: KeyboardEvent | ClipboardEvent): void {
    const host = (event.target as Element)?.closest<HTMLElement>(
      '[data-value-kind="styled-text"]',
    );
    if (!host) {
      return;
    }
    let text: string;
    if (event.type === 'paste') {
      text =
        (event as ClipboardEvent).clipboardData?.getData('text/plain') || '';
    } else {
      const key = event as KeyboardEvent;
      if (key.key !== 'Enter' || key.isComposing) {
        return;
      }
      text = '\n';
    }
    const selection = window.getSelection();
    if (!selection?.rangeCount || !host.contains(selection.anchorNode)) {
      return;
    }
    event.preventDefault();
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    host.dispatchEvent(new Event('input', {bubbles: true}));
  }
  globalThis.ArtifactPatchFields = {render, read, editText};
})();
