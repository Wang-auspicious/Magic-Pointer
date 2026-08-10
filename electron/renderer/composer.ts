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

  function create(options: MagicPointerComposerOptions = {}) {
    const {
      placeholder = '说点什么',
      density = 'full',        // capsule | companion | full
      onSubmit = () => {},
      onStop = () => {},
      onScissor = null,        // 取一块屏幕；没给就不显示这个按钮
      meta = [],               // 这一轮的口径：只读/模型/力度。见下。
      onMeta = () => {},
    } = options;

    let attachments: MagicPointerAttachment[] = [];
    let state: 'idle' | 'running' = 'idle';        // idle | running

    const input = h('textarea', { rows: '1', placeholder, class: 'mcomp-input' }, []) as HTMLTextAreaElement;
    const strip = h('div', { class: 'mcomp-strip', hidden: 'hidden' }, []);
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

    const clip = h('button', { type: 'button', class: 'mcomp-tool', title: '附件' }, [icon('ic-clip')]);
    const file = h('input', { type: 'file', accept: 'image/*', multiple: 'multiple', class: 'mcomp-file' }, []) as HTMLInputElement;
    clip.addEventListener('click', () => file.click());

    const form = h('form', { class: 'mcomp', 'data-state': 'idle', 'data-density': density }, [
      beam,
      metaRow,
      strip,
      h('div', { class: 'mcomp-line' }, [
        input,
        h('div', { class: 'mcomp-tools' }, [
          clip,
          scissor,
          h('button', { type: 'button', class: 'mcomp-tool', title: '说话' }, [icon('ic-mic')]),
          submit,
        ]),
      ]),
      file,
    ]) as HTMLFormElement;

    // 挑了图就该马上看见它，而不是看见一个文件名——「回答框里可以直接预览图片」。
    // 只读进 data: URL，不碰路径：渲染层拿不到也不需要拿到用户的文件系统。
    file.addEventListener('change', () => {
      for (const f of Array.from(file.files || []).slice(0, 8)) {
        const reader = new FileReader();
        reader.onload = () => {
          attachments.push({ name: f.name, src: String(reader.result || '') });
          paintStrip();
        };
        reader.readAsDataURL(f);
      }
      file.value = '';
    });

    // 输入框随内容长高，但有上限——一根越长越高的条会把结果挤出屏幕
    function autoGrow() {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, density === 'capsule' ? 96 : 168)}px`;
    }
    input.addEventListener('input', autoGrow);

    function paintStrip() {
      strip.replaceChildren(...attachments.map((a, i) => {
        const thumb = safeThumb(a.src);
        const kill = h('button', { type: 'button', class: 'mchip-x', title: '移除' }, [icon('ic-x')]);
        kill.addEventListener('click', () => {
          attachments.splice(i, 1);
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
      strip.hidden = attachments.length === 0;
    }

    function setState(next: 'idle' | 'running') {
      state = next;
      form.dataset.state = next;
      beam.dataset.on = String(next === 'running');
      input.disabled = next === 'running';
      submit.title = next === 'running' ? '停下' : '发送';
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (state === 'running') {
        onStop();
        return;
      }
      const text = input.value.trim();
      if (!text && !attachments.length) return;
      (onSubmit as (payload: { text: string; attachments: MagicPointerAttachment[] }) => void)({ text, attachments: attachments.slice() });
      input.value = '';
      autoGrow();
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
      setPlaceholder: (text: string) => { input.placeholder = String(text || ''); },
      attach(item: MagicPointerAttachment) {
        attachments.push(item);
        paintStrip();
      },
      setAttachments(list: MagicPointerAttachment[]) {
        attachments = Array.isArray(list) ? list.slice() : [];
        paintStrip();
      },
      attachments: () => attachments.slice(),
      running: (on: boolean) => setState(on ? 'running' : 'idle'),
      state: () => state,
      // 口径改了要能改回条上，否则用户点完菜单看到的还是旧值
      setMeta(id: string, label: string) {
        const btn = metaRow && metaRow.querySelector(`[data-meta="${id}"] .mmeta-label`);
        if (btn) btn.textContent = String(label || '');
      },
    };
  }

  return { create, safeThumb };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Composer;
