/* exported Composer */

const Composer = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const TEXT_ATTACHMENT_EXTENSIONS = new Set(['txt', 'md', 'log', 'csv', 'json', 'py', 'ts', 'js']);
  const MAX_TEXT_ATTACHMENT_BYTES = 200 * 1024;

  function h(tag: string, attrs?: Record<string, unknown>, children?: unknown): HTMLElement {
    const ns = tag === 'svg' || tag === 'use' ? SVG_NS : null;
    const node = (ns ? document.createElementNS(ns, tag) : document.createElement(tag)) as HTMLElement;
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      node.setAttribute(k, String(v));
    }
    for (const child of [children || []].flat(4)) {
      if (child === null || child === undefined || child === false || child === '') continue;
      node.appendChild(typeof child === 'object' ? child as Node : document.createTextNode(String(child)));
    }
    return node;
  }

  const icon = (id: string, cls?: string) => h('svg', cls ? { class: cls } : {}, [h('use', { href: `#${id}` }, [])]);

  function safeThumb(value: unknown): string {
    const raw = String(value || '').trim();
    if (/^data:image\//i.test(raw)) return raw;
    if (/^file:\/\//i.test(raw)) return raw;
    if (/^([a-zA-Z]:[\\/]|\/)/.test(raw)) {
      const slashed = raw.replace(/\\/g, '/');
      return slashed.startsWith('/') ? `file://${slashed}` : `file:///${slashed}`;
    }
    return '';
  }

  function decideSubmission(
    state: 'idle' | 'running',
    value: unknown,
    attachments: MagicPointerAttachment[],
  ) {
    const text = String(value || '').trim();
    if (state === 'running') return text ? { action: 'steer' as const, text } : { action: 'stop' as const };
    if (!text && !attachments.length) return { action: 'ignore' as const };
    return {
      action: 'submit' as const,
      payload: { text, attachments: attachments.slice() },
    };
  }

  function shouldRestoreFocus(active: unknown, composerInput: unknown): boolean {
    if (active === composerInput) return true;
    const tagName = String((active as { tagName?: unknown } | null)?.tagName || '').toLowerCase();
    return tagName !== 'input' && tagName !== 'textarea';
  }

  function isTextAttachmentName(name: unknown): boolean {
    const match = String(name || '').trim().toLowerCase().match(/\.([a-z0-9]+)$/);
    return Boolean(match && TEXT_ATTACHMENT_EXTENSIONS.has(match[1]));
  }

  function textAttachmentWithinLimit(size: unknown): boolean {
    const bytes = Number(size);
    return Number.isFinite(bytes) && bytes >= 0 && bytes <= MAX_TEXT_ATTACHMENT_BYTES;
  }

  interface AttachmentEntry {
    id: number;
    item: MagicPointerAttachment;
  }

  function attachmentSubmissionSnapshot(
    entries: AttachmentEntry[],
    cutoff: number,
  ): AttachmentEntry[] {
    return entries.filter((entry) => entry.id <= cutoff);
  }

  function pendingReadsThrough(
    pending: Map<number, Promise<void>>,
    cutoff: number,
  ): Promise<void>[] {
    return [...pending]
      .filter(([id]) => id <= cutoff)
      .map(([, promise]) => promise);
  }

  function remainingAttachmentEntries(
    current: AttachmentEntry[],
    submitted: AttachmentEntry[],
  ): AttachmentEntry[] {
    const submittedIds = new Set(submitted.map((entry) => entry.id));
    return current.filter((entry) => !submittedIds.has(entry.id));
  }

  function createInFlightGate() {
    let inFlight = false;
    return {
      tryEnter(): boolean {
        if (inFlight) return false;
        inFlight = true;
        return true;
      },
      leave(): void { inFlight = false; },
      active(): boolean { return inFlight; },
    };
  }

  async function callAcknowledged(
    callback: () => boolean | void | Promise<boolean | void>,
  ): Promise<boolean> {
    try {
      return (await callback()) !== false;
    } catch {
      return false;
    }
  }

  function create(options: MagicPointerComposerOptions = {}) {
    const {
      placeholder = '说点什么',
      density = 'full',         
      onSubmit = () => {},
      onStop = null,
      onSteer = null,
      onVoice = null,
      onScissor = null,         
      allowAttachments = true,
      meta = [],                
      onMeta = () => {},
    } = options;

    let attachmentEntries: AttachmentEntry[] = [];
    let nextAttachmentId = 1;
    let attachmentEpoch = 0;
    const pendingAttachmentReads = new Map<number, Promise<void>>();
    const steerGate = createInFlightGate();
    const stopGate = createInFlightGate();
    let state: 'idle' | 'running' = 'idle';         
    let idlePlaceholder = String(placeholder || '');

    const input = h('textarea', { rows: '1', placeholder: idlePlaceholder, class: 'mcomp-input' }, []) as HTMLTextAreaElement;
    const strip = h('div', { class: 'mcomp-strip', hidden: 'hidden' }, []);
    const attachmentError = h('div', {
      class: 'mcomp-error', hidden: 'hidden', role: 'status', 'aria-live': 'polite',
    }, []);
    const beam = h('div', { class: 'mbeam', 'data-on': 'false' }, [h('i', {}, []), h('i', {}, []), h('i', {}, [])]);

    const metaRow = meta.length
      ? h('div', { class: 'mcomp-meta' }, meta.map((m) => {
        const btn = h('button', {
          type: 'button', class: 'mmeta', 'data-meta': m.id || '', title: m.title || m.label,
        }, [
          m.dot ? h('span', { class: 'mmeta-dot', style: `--dot:${m.dot}` }, []) : null,
          m.icon ? icon(m.icon) : null,
          h('span', { class: 'mmeta-label' }, [m.label || '']),
          icon('ic-chev', 'mmeta-chev'),
        ]);
        btn.addEventListener('click', () => onMeta(m.id as string, btn));
        return btn;
      }))
      : null;

    const submit = h('button', {
      type: 'submit', class: 'mcomp-go', title: '发送', 'aria-label': '发送',
    }, [icon('ic-send', 'mgo-send'), h('span', { class: 'mgo-stop' }, [])]);

    const scissor = onScissor
      ? h('button', { type: 'button', class: 'mcomp-tool', title: '取一块屏幕' }, [icon('ic-crop')])
      : null;
    if (scissor) scissor.addEventListener('click', () => onScissor!());

    const mic = onVoice
      ? h('button', { type: 'button', class: 'mcomp-tool', title: '说话' }, [icon('ic-mic')])
      : null;
    if (mic) mic.addEventListener('click', () => onVoice!());

    const clip = allowAttachments
      ? h('button', { type: 'button', class: 'mcomp-tool', title: '附件' }, [icon('ic-clip')])
      : null;
    const file = allowAttachments
      ? h('input', {
        type: 'file',
        accept: 'image/*,.txt,.md,.log,.csv,.json,.py,.ts,.js',
        multiple: 'multiple',
        class: 'mcomp-file',
      }, []) as HTMLInputElement
      : null;
    if (clip && file) clip.addEventListener('click', () => file.click());

    const form = h('form', { class: 'mcomp', 'data-state': 'idle', 'data-density': density }, [
      beam,
      metaRow,
      strip,
      attachmentError,
      h('div', { class: 'mcomp-line' }, [
        input,
        h('div', { class: 'mcomp-tools' }, [
          clip,
          scissor,
          mic,
          submit,
        ]),
      ]),
      file,
    ]) as HTMLFormElement;

    function showStatus(message: string, error = true) {
      attachmentError.textContent = message;
      attachmentError.hidden = !message;
      attachmentError.dataset.kind = error ? 'error' : 'status';
    }

    file?.addEventListener('change', () => {
      showStatus('');
      const epoch = attachmentEpoch;
      for (const f of Array.from(file.files || []).slice(0, 8)) {
        const image = f.type.startsWith('image/');
        const text = isTextAttachmentName(f.name);
        if (!image && !text) {
          showStatus(`不支持「${f.name}」这种附件。`);
          continue;
        }
        if (text && !textAttachmentWithinLimit(f.size)) {
          showStatus(`「${f.name}」超过 200 KiB，请在 Studio 中用文件路径添加。`);
          continue;
        }
        const id = nextAttachmentId++;
        let settle!: () => void;
        const pending = new Promise<void>((resolve) => { settle = resolve; });
        pendingAttachmentReads.set(id, pending);
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          pendingAttachmentReads.delete(id);
          settle();
        };
        const reader = new FileReader();
        reader.onerror = () => {
          if (epoch === attachmentEpoch) showStatus(`无法读取「${f.name}」。`);
          finish();
        };
        reader.onabort = reader.onerror;
        reader.onload = () => {
          try {
            if (epoch === attachmentEpoch) {
              attachmentEntries.push({
                id,
                item: image
                  ? { name: f.name, src: String(reader.result || '') }
                  : { name: f.name, text: String(reader.result || '') },
              });
              paintStrip();
            }
          } finally {
            finish();
          }
        };
        try {
          if (image) reader.readAsDataURL(f);
          else reader.readAsText(f);
        } catch {
          if (epoch === attachmentEpoch) showStatus(`无法读取「${f.name}」。`);
          finish();
        }
      }
      file.value = '';
    });

    function autoGrow() {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, density === 'capsule' ? 96 : 168)}px`;
    }
    input.addEventListener('input', () => {
      autoGrow();
      syncSubmitAffordance();
    });

    function paintStrip() {
      strip.replaceChildren(...attachmentEntries.map((entry) => {
        const a = entry.item;
        const thumb = safeThumb(a.src);
        const kill = h('button', { type: 'button', class: 'mchip-x', title: '移除' }, [icon('ic-x')]);
        kill.addEventListener('click', () => {
          attachmentEntries = attachmentEntries.filter((item) => item.id !== entry.id);
          paintStrip();
        });
        return h('span', { class: `mchip${thumb ? ' is-img' : ''}` }, [
          thumb
            ? h('img', { src: thumb, alt: a.name || '附件' }, [])
            : icon(a.icon || 'ic-file'),
          h('small', {}, [a.name || '附件']),
          kill,
        ]);
      }));
      strip.hidden = attachmentEntries.length === 0;
    }

    function setState(next: 'idle' | 'running') {
      state = next;
      form.dataset.state = next;
      beam.dataset.on = String(next === 'running');
      input.disabled = false;
      input.placeholder = next === 'running' ? '插一句（下一轮生效）…' : idlePlaceholder;
      syncSubmitAffordance();
      if (next === 'idle' && shouldRestoreFocus(document.activeElement, input)) {
        input.focus();
      }
    }

    function syncSubmitAffordance() {
      const label = state === 'running' ? (input.value.trim() ? '插话' : '停止') : '发送';
      submit.title = label;
      submit.setAttribute('aria-label', label);
    }

    async function requestStop() {
      if (!onStop) {
        showStatus('停止功能不可用。');
        return;
      }
      if (!stopGate.tryEnter()) return;
      showStatus('正在停止…', false);
      let accepted = false;
      try {
        accepted = await callAcknowledged(onStop);
      } finally {
        stopGate.leave();
      }
      showStatus(accepted ? '已请求停止。' : '停止请求未送达，请重试。', !accepted);
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (state === 'running') {
        const decision = decideSubmission(
          state,
          input.value,
          attachmentEntries.map((entry) => entry.item),
        );
        if (decision.action === 'stop') {
          await requestStop();
          return;
        }
        if (decision.action !== 'steer') return;
        if (!onSteer) {
          await requestStop();
          return;
        }
        if (!steerGate.tryEnter()) return;
        showStatus('正在插话…', false);
        let accepted = false;
        try {
          accepted = await callAcknowledged(() => onSteer(decision.text));
        } finally {
          steerGate.leave();
        }
        if (!accepted) {
          showStatus('插话未送达，请重试。');
          return;
        }
        if (input.value.trim() === decision.text) {
          input.value = '';
          autoGrow();
          syncSubmitAffordance();
        }
        showStatus('');
        return;
      }

      const attachmentCutoff = nextAttachmentId - 1;
      const submittedText = input.value;
      await Promise.all(pendingReadsThrough(pendingAttachmentReads, attachmentCutoff));
      if (state !== 'idle') return;
      const submittedEntries = attachmentSubmissionSnapshot(
        attachmentEntries,
        attachmentCutoff,
      );
      const decision = decideSubmission(
        'idle',
        submittedText,
        submittedEntries.map((entry) => entry.item),
      );
      if (decision.action === 'ignore') return;
      if (decision.action !== 'submit') return;
      const accepted = await callAcknowledged(() => onSubmit(decision.payload));
      if (!accepted) {
        showStatus('发送未完成，请重试。');
        return;
      }
      attachmentEntries = remainingAttachmentEntries(
        attachmentEntries,
        submittedEntries,
      );
      paintStrip();
      if (input.value.trim() === decision.payload.text) {
        input.value = '';
        autoGrow();
      }
      showStatus('');
    });

    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      form.requestSubmit();
    });

    return {
      el: form,
      focus: () => input.focus(),
      setPlaceholder: (text: string) => {
        idlePlaceholder = String(text || '');
        if (state === 'idle') input.placeholder = idlePlaceholder;
      },
      attach(item: MagicPointerAttachment) {
        attachmentEntries.push({ id: nextAttachmentId++, item });
        paintStrip();
      },
      setAttachments(list: MagicPointerAttachment[]) {
        attachmentEpoch += 1;
        pendingAttachmentReads.clear();
        attachmentEntries = (Array.isArray(list) ? list : []).map((item) => ({
          id: nextAttachmentId++,
          item,
        }));
        paintStrip();
      },
      attachments: () => attachmentEntries.map((entry) => entry.item),
      running: (on: boolean) => setState(on ? 'running' : 'idle'),
      state: () => state,
      setMeta(id: string, label: string) {
        const btn = metaRow && metaRow.querySelector(`[data-meta="${id}"] .mmeta-label`);
        if (btn) btn.textContent = String(label || '');
      },
    };
  }

  return {
    create,
    safeThumb,
    decideSubmission,
    shouldRestoreFocus,
    isTextAttachmentName,
    textAttachmentWithinLimit,
    attachmentSubmissionSnapshot,
    pendingReadsThrough,
    remainingAttachmentEntries,
    createInFlightGate,
    callAcknowledged,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Composer;
