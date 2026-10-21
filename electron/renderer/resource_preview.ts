import type {ResourcePreview} from '../resource_preview';

interface PreviewOptions {
  title: string;
  restoreFocus(): void;
  load(): Promise<ResourcePreview>;
  openExternal(): Promise<void>;
}

declare global {
  var ResourcePreviewView: {
    create(): {show(options: PreviewOptions): void; close(): void};
  };
}

(() => {
  const clamp = (value: number, limit: number) =>
    Math.min(limit, Math.max(-limit, value));
  // Pan/zoom geometry follows the reviewed MediaLightboxViewer reference.
  const panLimit = (size: number, viewport: number, scale: number) =>
    Math.max(
      0,
      (size * scale + viewport) / 2 - Math.min(size * scale, viewport * 0.7),
    ) * Math.min(1, Math.max(0, (scale - 1.05) / 0.95));

  function create() {
    let dismiss: (() => void) | null = null;
    const close = () => dismiss?.();
    function show(options: PreviewOptions): void {
      close();
      const t = (en: string, zh: string) =>
        document.documentElement.lang.startsWith('zh') ? zh : en;
      const dialog = document.createElement('dialog');
      dialog.className = 'rl-preview';
      dialog.setAttribute('aria-label', options.title);
      dialog.innerHTML = `<header><div><small>${t('Saved original', '保存的原件')}</small><h2></h2></div><button type="button" data-preview-close aria-label="${t('Close preview', '关闭预览')}">×</button></header>
        <div class="rl-preview-toolbar" hidden><button type="button" data-preview-fit>${t('Fit', '适应窗口')}</button><button type="button" data-preview-actual>100%</button><button type="button" data-preview-out aria-label="${t('Zoom out', '缩小')}">−</button><output></output><button type="button" data-preview-in aria-label="${t('Zoom in', '放大')}">+</button><span data-preview-size></span></div>
        <div class="rl-preview-body" aria-busy="true"></div><footer><p data-preview-error role="status"></p><button type="button" data-preview-retry hidden>${t('Try again', '重试')}</button><button type="button" data-preview-external>${t('Open in app', '在应用中打开')} ↗</button></footer>`;
      dialog.querySelector('h2')!.textContent = options.title;
      const body = dialog.querySelector<HTMLElement>('.rl-preview-body')!;
      const toolbar = dialog.querySelector<HTMLElement>('.rl-preview-toolbar')!;
      const error = dialog.querySelector<HTMLElement>('[data-preview-error]')!;
      const retry = dialog.querySelector<HTMLButtonElement>(
        '[data-preview-retry]',
      )!;
      const external = dialog.querySelector<HTMLButtonElement>(
        '[data-preview-external]',
      )!;
      let generation = 0;
      let image: HTMLImageElement | null = null;
      let scale = 1;
      let tx = 0;
      let ty = 0;
      let idealX = 0;
      let idealY = 0;
      let maxX = 0;
      let maxY = 0;
      let dragged = false;
      let drag: {
        id: number;
        x: number;
        y: number;
        tx: number;
        ty: number;
      } | null = null;

      const paint = () => {
        if (!image) {
          return;
        }
        image.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
        image.style.cursor =
          scale > 1 ? (drag ? 'grabbing' : 'grab') : 'zoom-in';
        toolbar.querySelector('output')!.textContent =
          `${Math.round((image.clientWidth / image.naturalWidth) * scale * 100)}%`;
        toolbar
          .querySelector('[data-preview-fit]')!
          .setAttribute('aria-pressed', String(scale === 1));
      };
      const reset = () => {
        scale = 1;
        tx = 0;
        ty = 0;
        idealX = 0;
        idealY = 0;
        maxX = 0;
        maxY = 0;
        drag = null;
        paint();
      };
      const zoom = (
        next: number,
        pointer?: {clientX: number; clientY: number},
      ) => {
        if (!image?.naturalWidth || !image.clientWidth) {
          return;
        }
        const target = Math.min(
          Math.max(next, 1),
          Math.max(image.naturalWidth / image.clientWidth, 2),
        );
        if (target <= 1.05) {
          reset();
          return;
        }
        const rect = body.getBoundingClientRect();
        const offsetX = pointer
          ? pointer.clientX - rect.left - rect.width / 2
          : 0;
        const offsetY = pointer
          ? pointer.clientY - rect.top - rect.height / 2
          : 0;
        const ratio = target / scale;
        const nextMaxX = panLimit(image.clientWidth, body.clientWidth, target);
        const nextMaxY = panLimit(
          image.clientHeight,
          body.clientHeight,
          target,
        );
        const nextIdealX = offsetX - (offsetX - idealX) * ratio;
        const nextIdealY = offsetY - (offsetY - idealY) * ratio;
        tx = clamp(nextIdealX, nextMaxX);
        ty = clamp(nextIdealY, nextMaxY);
        idealX = nextMaxX < maxX ? tx : nextIdealX;
        idealY = nextMaxY < maxY ? ty : nextIdealY;
        maxX = nextMaxX;
        maxY = nextMaxY;
        scale = target;
        paint();
      };
      const stopMedia = () => {
        for (const media of body.querySelectorAll<HTMLMediaElement>(
          'audio,video',
        )) {
          media.pause();
          media.removeAttribute('src');
          media.load();
        }
      };
      const resize = new ResizeObserver(() => reset());
      dismiss = () => {
        generation++;
        resize.disconnect();
        stopMedia();
        if (dialog.open) {
          dialog.close();
        }
        dialog.remove();
        dismiss = null;
        options.restoreFocus();
      };
      dialog
        .querySelector('[data-preview-close]')!
        .addEventListener('click', close);
      dialog.addEventListener('cancel', event => {
        event.preventDefault();
        close();
      });
      dialog.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
        if (!image || event.ctrlKey || event.metaKey || event.altKey) {
          return;
        }
        if (event.key === '+' || event.key === '=') {
          event.preventDefault();
          zoom(scale * 1.25);
        }
        if (event.key === '-') {
          event.preventDefault();
          zoom(scale / 1.25);
        }
        if (event.key === '0') {
          event.preventDefault();
          reset();
        }
      });
      dialog.addEventListener('click', event => {
        if (event.target === dialog) {
          close();
        }
      });
      toolbar
        .querySelector('[data-preview-fit]')!
        .addEventListener('click', reset);
      toolbar
        .querySelector('[data-preview-actual]')!
        .addEventListener('click', () => {
          if (image) {
            zoom(image.naturalWidth / image.clientWidth);
          }
        });
      toolbar
        .querySelector('[data-preview-in]')!
        .addEventListener('click', () => zoom(scale * 1.25));
      toolbar
        .querySelector('[data-preview-out]')!
        .addEventListener('click', () => zoom(scale / 1.25));
      body.addEventListener(
        'wheel',
        event => {
          if (!image) {
            return;
          }
          event.preventDefault();
          if (drag) {
            return;
          }
          if (event.ctrlKey) {
            const unit =
              event.deltaMode === WheelEvent.DOM_DELTA_LINE
                ? 16
                : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
                  ? body.clientHeight
                  : 1;
            const target = scale * Math.exp(-event.deltaY * unit * 0.01);
            zoom(
              scale === 1 && target > 1 ? Math.max(target, 1.25) : target,
              event,
            );
          } else if (scale > 1) {
            const unitX =
              event.deltaMode === 2
                ? body.clientWidth
                : event.deltaMode === 1
                  ? 16
                  : 1;
            const unitY =
              event.deltaMode === 2
                ? body.clientHeight
                : event.deltaMode === 1
                  ? 16
                  : 1;
            tx = clamp(tx - event.deltaX * unitX, maxX);
            ty = clamp(ty - event.deltaY * unitY, maxY);
            idealX = tx;
            idealY = ty;
            paint();
          }
        },
        {passive: false},
      );
      body.addEventListener('pointerdown', event => {
        if (
          !image ||
          event.target !== image ||
          event.button !== 0 ||
          scale === 1
        ) {
          return;
        }
        dragged = false;
        drag = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          tx,
          ty,
        };
        image.setPointerCapture(event.pointerId);
        paint();
      });
      body.addEventListener('pointermove', event => {
        if (!drag || drag.id !== event.pointerId) {
          return;
        }
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!dragged && Math.hypot(dx, dy) < 4) {
          return;
        }
        dragged = true;
        tx = clamp(drag.tx + dx, maxX);
        ty = clamp(drag.ty + dy, maxY);
        idealX = tx;
        idealY = ty;
        paint();
      });
      const endDrag = (event: PointerEvent) => {
        if (!drag || drag.id !== event.pointerId) {
          return;
        }
        drag = null;
        paint();
        if (event.type === 'pointercancel') {
          dragged = false;
        }
      };
      body.addEventListener('pointerup', endDrag);
      body.addEventListener('pointercancel', endDrag);
      body.addEventListener('lostpointercapture', endDrag);
      body.addEventListener('click', event => {
        if (!image || event.target !== image) {
          return;
        }
        if (dragged) {
          dragged = false;
          return;
        }
        if (scale > 1) {
          reset();
        } else {
          zoom(Math.max(image.naturalWidth / image.clientWidth, 2), event);
        }
      });
      external.addEventListener('click', () => {
        if (external.disabled) {
          return;
        }
        external.disabled = true;
        void options
          .openExternal()
          .catch(reason => {
            if (dialog.isConnected) {
              error.textContent = String(reason);
            }
          })
          .finally(() => {
            external.disabled = false;
          });
      });
      const load = async () => {
        const current = ++generation;
        stopMedia();
        resize.disconnect();
        image = null;
        reset();
        toolbar.hidden = true;
        retry.hidden = true;
        error.textContent = '';
        body.setAttribute('aria-busy', 'true');
        body.textContent = t('Loading saved original…', '正在读取保存的原件…');
        const failed = () => {
          if (current !== generation || !dialog.isConnected) {
            return;
          }
          body.removeAttribute('aria-busy');
          error.textContent = t(
            'Could not display this saved file. Retry or open it in its application.',
            '无法预览这份原件，可重试或在关联应用中打开。',
          );
          retry.hidden = false;
          toolbar.hidden = true;
        };
        try {
          const preview = await options.load();
          if (current !== generation || !dialog.isConnected) {
            return;
          }
          body.replaceChildren();
          body.className = 'rl-preview-body';
          if (preview.kind === 'image') {
            image = document.createElement('img');
            image.className = 'rl-preview-image';
            image.alt = options.title;
            image.draggable = false;
            image.onload = () => {
              if (current !== generation || !dialog.isConnected || !image) {
                return;
              }
              body.removeAttribute('aria-busy');
              toolbar.hidden = false;
              toolbar.querySelector('[data-preview-size]')!.textContent =
                `${image.naturalWidth} × ${image.naturalHeight}`;
              reset();
              resize.observe(body);
            };
            image.onerror = failed;
            body.classList.add('is-image');
            body.append(image);
            image.src = preview.url;
          } else if (preview.kind === 'video' || preview.kind === 'audio') {
            const media = document.createElement(preview.kind);
            media.controls = true;
            media.preload = 'metadata';
            media.setAttribute('aria-label', options.title);
            media.onerror = failed;
            media.onloadedmetadata = () => {
              if (current === generation) {
                body.removeAttribute('aria-busy');
              }
            };
            body.classList.add('is-media');
            body.append(media);
            media.src = preview.url;
          } else {
            ProjectPreviewView.renderProjectPreview(body, preview);
            body.removeAttribute('aria-busy');
          }
        } catch (reason) {
          if (current !== generation || !dialog.isConnected) {
            return;
          }
          body.textContent = t('Preview unavailable.', '暂时无法预览。');
          failed();
          error.textContent += ` ${String(reason)}`;
        }
      };
      retry.addEventListener('click', () => {
        void load();
      });
      document.body.append(dialog);
      dialog.showModal();
      dialog.querySelector<HTMLButtonElement>('[data-preview-close]')!.focus();
      void load();
    }
    return {show, close};
  }
  globalThis.ResourcePreviewView = {create};
})();
