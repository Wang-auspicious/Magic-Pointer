/* exported Composer */
/* ============================================================================
   输入条
   ----------------------------------------------------------------------------
   三个界面共用的那根条。Vida 的形：底部居中、超大圆角、字号偏大、右侧一个
   「取一块屏幕」和一个圆形提交。提交之后**同一根条**变成生成态——圆钮变停止
   方块，底下一团模糊的暖色在游走（beam.css）。不是换一个组件，是同一根条换
   状态；换组件会让人觉得刚才那句话被吃掉了。

   附件在条的上沿以缩略图出现，图片直接预览——用户要能看见「它待会儿看的是
   这张」，而不是一个文件名。

   这里只管这根条自己。提交做什么由外面给 onSubmit。
   ============================================================================ */

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

  // 附件缩略图的来源。和卡片那道闸同一条规矩：只放行本地文件和图片 data:，
  // 一个 javascript: 就能在渲染进程里执行脚本。
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
      density = 'full',        // capsule | companion | full
      onSubmit = () => {},
      onStop = null,
      onSteer = null,
      onVoice = null,
      onScissor = null,        // 取一块屏幕；没给就不显示这个按钮
      allowAttachments = true,
      meta = [],               // 这一轮的口径：只读/模型/力度。见下。
      onMeta = () => {},
    } = options;

    let attachmentEntries: AttachmentEntry[] = [];
    let nextAttachmentId = 1;
    let attachmentEpoch = 0;
    const pendingAttachmentReads = new Map<number, Promise<void>>();
    const steerGate = createInFlightGate();
    const stopGate = createInFlightGate();
    let state: 'idle' | 'running' = 'idle';        // idle | running
    let idlePlaceholder = String(placeholder || '');

    const input = h('textarea', { rows: '1', placeholder: idlePlaceholder, class: 'mcomp-input' }, []) as HTMLTextAreaElement;
    const strip = h('div', { class: 'mcomp-strip', hidden: 'hidden' }, []);
    const attachmentError = h('div', {
      class: 'mcomp-error', hidden: 'hidden', role: 'status', 'aria-live': 'polite',
    }, []);
    const beam = h('div', { class: 'mbeam', 'data-on': 'false' }, [h('i', {}, []), h('i', {}, []), h('i', {}, [])]);

    // 「这一轮用哪个模型、能做到哪一步」是每次都可能改的口径，不是主操作。
    // 上一版把它们跟发送钮排成一排工具栏，一根条上七个按钮，用户第一句话
    // 还没打就先要读一遍工具栏。改成条上方一行淡的小字：需要时点得到，
    // 不需要时不抢眼——「不要这么直白」。
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

    // 图片保持 data: URL 以便原位预览；文本直接读字符串，避免 base64 膨胀。
    // 文本超过 200 KiB 时明确拒绝，提示用户改走 Studio 的路径附件链。
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

    // 输入框随内容长高，但有上限——一根越长越高的条会把结果挤出屏幕
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

    // Enter 发送，Shift+Enter 换行。中文输入法组词途中的 Enter 不算——
    // 少了 isComposing 判断，打「这段代码」按空格选词就会把半句话发出去。
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
      // 口径改了要能改回条上，否则用户点完菜单看到的还是旧值
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
