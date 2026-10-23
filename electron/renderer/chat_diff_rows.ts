/** Indexed retained-file rows and event-driven, measured viewport rendering. */
export interface DiffRowBlock {
  kind: 'context' | 'add' | 'del';
  text: string;
}

// Matching structured-patch defaults and the inline renderer's simple mode.
const CONTEXT_LINES = 4;
const COLLAPSED_CONTEXT_THRESHOLD = 1;
const SIMPLE_SEPARATOR_HEIGHT = 4;

export function indexDiffRows(blocks: readonly DiffRowBlock[]) {
  let oldLine = 1;
  let newLine = 1;
  const sections = blocks
    .map(block => {
      let length = block.text ? 1 : 0;
      for (let i = 0; i < block.text.length - 1; i++) {
        if (block.text.charCodeAt(i) === 10) {
          length++;
        }
      }
      const offsets = new Uint32Array(length);
      let row = 1;
      for (let i = 0; i < block.text.length - 1; i++) {
        if (block.text.charCodeAt(i) === 10) {
          offsets[row++] = i + 1;
        }
      }
      const section = {
        block,
        offsets,
        number: block.kind === 'del' ? oldLine : newLine,
      };
      if (block.kind !== 'add') {
        oldLine += length;
      }
      if (block.kind !== 'del') {
        newLine += length;
      }
      return section;
    })
    .filter(section => section.offsets.length);
  type Section = (typeof sections)[number];
  const runs: Array<{
    start: number;
    length: number;
    from: number;
    section: Section | null;
  }> = [];
  const separators: number[] = [];
  let count = 0;
  const append = (
    section: Section | null,
    from: number,
    length: number,
  ): void => {
    if (length) {
      runs.push({start: count, length, from, section});
      count += length;
    }
  };
  if (sections.some(section => section.block.kind !== 'context')) {
    for (const [i, section] of sections.entries()) {
      const length = section.offsets.length;
      if (section.block.kind !== 'context') {
        append(section, 0, length);
        continue;
      }
      const head = i === 0 ? 0 : Math.min(CONTEXT_LINES, length);
      const tail =
        i === sections.length - 1 ? 0 : Math.min(CONTEXT_LINES, length - head);
      if (length - head - tail <= COLLAPSED_CONTEXT_THRESHOLD) {
        append(section, 0, length);
        continue;
      }
      append(section, 0, head);
      // Simple inline mode has neither an initial/final separator nor expand UI.
      if (head && tail) {
        separators.push(count);
        append(null, 0, 1);
      }
      append(section, length - tail, tail);
    }
  }
  return {
    count,
    separators,
    digits: String(Math.max(oldLine - 1, newLine - 1, 1)).length,
    get(index: number) {
      let lo = 0;
      let hi = runs.length;
      while (lo + 1 < hi) {
        const middle = (lo + hi) >>> 1;
        if (runs[middle].start <= index) {
          lo = middle;
        } else {
          hi = middle;
        }
      }
      const run = runs[lo];
      const section = run.section;
      if (!section) {
        return {kind: 'separator' as const, number: null, text: ''};
      }
      const offset = run.from + index - run.start;
      const start = section.offsets[offset];
      const end = section.offsets[offset + 1] ?? section.block.text.length;
      return {
        kind: section.block.kind,
        number: section.number + offset,
        text: section.block.text
          .slice(start, end)
          .replace(/\n$/, '')
          .replace(/\r/g, '␍'),
      };
    },
  };
}

type DiffRowIndex = ReturnType<typeof indexDiffRows>;

/** Only measured deltas are retained; untouched rows cost one typed-array cell. */
export class DiffRowHeights {
  private readonly tree: Float64Array;
  private readonly measured = new Map<number, number>();

  constructor(
    readonly count: number,
    public lineHeight: number,
  ) {
    this.tree = new Float64Array(count + 1);
  }

  reset(lineHeight: number): void {
    this.lineHeight = lineHeight;
    this.measured.clear();
    this.tree.fill(0);
  }

  set(index: number, height: number): void {
    if (height <= 0) {
      return;
    }
    const previous = this.measured.get(index) ?? this.lineHeight;
    if (height === previous) {
      return;
    }
    this.measured.set(index, height);
    for (let i = index + 1; i <= this.count; i += i & -i) {
      this.tree[i] += height - previous;
    }
  }

  offset(index: number): number {
    let value = index * this.lineHeight;
    for (let i = index; i > 0; i -= i & -i) {
      value += this.tree[i];
    }
    return value;
  }

  at(offset: number): number {
    let lo = 0;
    let hi = this.count;
    while (lo + 1 < hi) {
      const middle = (lo + hi) >>> 1;
      if (this.offset(middle) <= offset) {
        lo = middle;
      } else {
        hi = middle;
      }
    }
    return lo;
  }
}

type BrowserWindow = Window & typeof globalThis;
type Lifecycle = {connected: boolean; refresh(): void; dispose(): void};
const documents = new WeakMap<
  Document,
  {
    entries: Map<HTMLElement, Lifecycle>;
    observer: MutationObserver;
  }
>();

function watchRemoval(card: HTMLElement, lifecycle: Lifecycle): () => void {
  const doc = card.ownerDocument;
  let shared = documents.get(doc);
  if (!shared) {
    const entries = new Map<HTMLElement, Lifecycle>();
    const win = doc.defaultView as BrowserWindow;
    const observer = new win.MutationObserver((records = []) => {
      for (const [element, state] of entries) {
        if (!element.isConnected) {
          if (
            state.connected ||
            records.some(record =>
              Array.from(record.removedNodes).some(node =>
                node.contains(element),
              ),
            )
          ) {
            state.dispose();
          }
        } else if (!state.connected) {
          state.connected = true;
          state.refresh();
        }
      }
    });
    observer.observe(doc.documentElement, {childList: true, subtree: true});
    shared = {entries, observer};
    documents.set(doc, shared);
  }
  shared.entries.set(card, lifecycle);
  return () => {
    shared.entries.delete(card);
    if (!shared.entries.size) {
      shared.observer.disconnect();
      documents.delete(doc);
    }
  };
}

// Initial admission is an MP node budget, not a Claude collapse threshold.
export const INITIAL_DIFF_ROWS = 50;

export function mountDiffRows(
  card: HTMLElement,
  index: DiffRowIndex,
  render: (first: number, last: number, before: number, after: number) => void,
): () => void {
  if (index.count <= INITIAL_DIFF_ROWS) {
    return () => {};
  }
  const win = card.ownerDocument.defaultView as BrowserWindow;
  const heights = new DiffRowHeights(index.count, 17);
  index.separators.forEach(i => heights.set(i, SIMPLE_SEPARATOR_HEIGHT));
  let first = 0;
  let last = INITIAL_DIFF_ROWS;
  let width = 0;
  let padding = 0;
  let frame: number | null = null;
  let disposed = false;
  let rendered: HTMLElement[] = [];
  const observeRows = (): void => {
    rendered.forEach(row => resize.unobserve(row));
    rendered = Array.from(
      card.querySelectorAll<HTMLElement>('.mp-chat-diff-window-row'),
    );
    rendered.forEach(row => resize.observe(row));
  };
  const paint = (): void => {
    frame = null;
    if (disposed || !card.isConnected || !card.clientHeight) {
      return;
    }
    const top = Math.max(0, card.scrollTop - padding);
    // One viewport of overscan keeps scroll updates bounded without idle work.
    const nextFirst = heights.at(Math.max(0, top - card.clientHeight));
    const nextLast = Math.min(
      index.count,
      heights.at(top + card.clientHeight * 2) + 1,
    );
    if (nextFirst !== first || nextLast !== last) {
      first = nextFirst;
      last = nextLast;
      render(
        first,
        last,
        heights.offset(first),
        heights.offset(index.count) - heights.offset(last),
      );
      observeRows();
    } else {
      const spacers = card.querySelectorAll<HTMLElement>(
        '.mp-chat-diff-virtual-spacer',
      );
      spacers[0].style.height = `${heights.offset(first)}px`;
      spacers[1].style.height = `${heights.offset(index.count) - heights.offset(last)}px`;
    }
  };
  const schedule = (): void => {
    if (!disposed && frame === null) {
      frame = win.requestAnimationFrame(paint);
    }
  };
  const resize = new win.ResizeObserver(entries => {
    if (disposed || !card.isConnected || !card.clientHeight) {
      return;
    }
    const anchor = heights.at(Math.max(0, card.scrollTop - padding));
    const oldOffset = heights.offset(anchor);
    const style = win.getComputedStyle(card);
    const lineHeight = Number.parseFloat(style.lineHeight) || 17;
    padding = Number.parseFloat(style.paddingTop) || 0;
    const reset =
      width !== card.clientWidth || lineHeight !== heights.lineHeight;
    if (reset) {
      width = card.clientWidth;
      heights.reset(lineHeight);
      index.separators.forEach(i => heights.set(i, SIMPLE_SEPARATOR_HEIGHT));
      rendered.forEach(row =>
        heights.set(
          Number(row.dataset.diffRow),
          row.getBoundingClientRect().height,
        ),
      );
    }
    for (const entry of entries) {
      if (entry.target !== card) {
        const row = entry.target as HTMLElement;
        heights.set(
          Number(row.dataset.diffRow),
          entry.borderBoxSize[0]?.blockSize ??
            row.getBoundingClientRect().height,
        );
      }
    }
    // Keep the first visible logical row stable when wrapped heights settle.
    card.scrollTop += heights.offset(anchor) - oldOffset;
    schedule();
  });
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    if (frame !== null) {
      win.cancelAnimationFrame(frame);
    }
    card.removeEventListener('scroll', schedule);
    resize.disconnect();
    rendered = [];
    unwatch();
  };
  const unwatch = watchRemoval(card, {
    connected: card.isConnected,
    refresh: schedule,
    dispose,
  });
  card.addEventListener('scroll', schedule, {passive: true});
  resize.observe(card);
  observeRows();
  schedule();
  return dispose;
}
