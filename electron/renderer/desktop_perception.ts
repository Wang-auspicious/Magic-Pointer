declare global {
  interface DesktopPerceptionStatus {
    paused: boolean;
    onboardingRequired: boolean;
    wakeMode: string;
    detectWiggle: boolean;
    detectMouseButton: boolean;
    polling: boolean;
    pointerStateFresh?: boolean;
    hotkeys: Array<{name: string; accelerator: string; registered: boolean}>;
    lastError?: string;
    activity?: import('../perception_activity').PerceptionActivity;
  }

  interface DesktopPerceptionController {
    refresh(): Promise<void>;
    updateStatus(status: DesktopPerceptionStatus): void;
    updateContext(context: MagicPointerTaskContext | null): void;
    updateEvidence(object: unknown): void;
    updateLanguage(): void;
    dispose(): void;
  }

  interface DesktopPerceptionOptions {
    readStatus(): Promise<DesktopPerceptionStatus>;
    activate(): Promise<{ok: boolean; error?: string; state?: string}>;
    setPaused?(paused: boolean): Promise<{ok: boolean; error?: string}>;
    toggleClickyCoach?(): boolean;
    isClickyCoachActive?(): boolean;
    toggleDemoRecord?(): boolean;
    isDemoRecording?(): boolean;
    openSettings(page: 'general' | 'privacy'): void;
    openMaterials(sourceId?: string): void;
    language(): string;
  }

  var DesktopPerception: {
    create(
      host: HTMLElement,
      options: DesktopPerceptionOptions,
    ): DesktopPerceptionController;
    summarize(
      status: DesktopPerceptionStatus | null,
      language: string,
    ): DesktopPerceptionSummary;
  };
}

interface DesktopPerceptionSummary {
  state: 'unknown' | 'setup' | 'paused' | 'ready' | 'unavailable';
  label: string;
  wiggle: string;
  pointer: string;
  hotkeys: Array<{label: string; ready: boolean}>;
}

(() => {
  function summarize(
    status: DesktopPerceptionStatus | null,
    language: string,
  ): DesktopPerceptionSummary {
    const zh = language === 'zh-CN';
    const state = !status
      ? 'unknown'
      : status.onboardingRequired
        ? 'setup'
        : status.paused
          ? 'paused'
          : (status.polling &&
                status.pointerStateFresh !== false &&
                (status.detectWiggle || status.detectMouseButton)) ||
              status.hotkeys.some(key => key.registered)
            ? 'ready'
            : 'unavailable';
    const labels = {
      unknown: zh ? '状态未读取' : 'Status unknown',
      setup: zh ? '需要完成首次设置' : 'Setup required',
      paused: zh ? '已暂停' : 'Paused',
      ready: zh ? '可唤醒' : 'Ready to point',
      unavailable: zh ? '唤醒不可用' : 'Wake unavailable',
    };
    const pointer = !status
      ? labels.unknown
      : status.paused
        ? labels.paused
        : status.wakeMode === 'mouse_button' && !status.detectMouseButton
          ? zh
            ? '已关闭'
            : 'Off'
          : status.pointerStateFresh === false
            ? zh
              ? '鼠标输入不可用'
              : 'Pointer input unavailable'
            : status.polling
              ? zh
                ? '正在监听'
                : 'Listening'
              : zh
                ? '未在监听'
                : 'Not listening';
    return {
      state,
      label: labels[state],
      pointer,
      wiggle: !status
        ? labels.unknown
        : status.paused
          ? labels.paused
          : !status.detectWiggle
            ? zh
              ? '已关闭'
              : 'Off'
            : pointer,
      hotkeys: (status?.hotkeys || []).map(key => ({
        label: key.accelerator,
        ready: key.registered,
      })),
    };
  }

  function create(
    host: HTMLElement,
    options: DesktopPerceptionOptions,
  ): DesktopPerceptionController {
    let status: DesktopPerceptionStatus | null = null;
    let context: MagicPointerTaskContext | null = null;
    let error = '';
    let activating = false;
    let changingPause = false;
    let disposed = false;
    let readGeneration = 0;
    const text = (english: string, chinese: string): string =>
      options.language() === 'zh-CN' ? chinese : english;
    const node = <K extends keyof HTMLElementTagNameMap>(
      tag: K,
      className: string,
      value?: string,
    ): HTMLElementTagNameMap[K] => {
      const element = document.createElement(tag);
      element.className = className;
      if (value !== undefined) {
        element.textContent = value;
      }
      return element;
    };

    const root = node('div', 'mp-perception-menu');
    root.setAttribute('role', 'menu');

    // Row 1: Point at screen
    const actionBtn = node('button', 'mp-perception-menu-item');
    actionBtn.type = 'button';
    const actionIcon = node('span', 'cds-icon', '\uE059');
    actionIcon.dataset.size = 'small';
    actionIcon.setAttribute('aria-hidden', 'true');
    const actionLabel = node('span', 'mp-perception-menu-label');
    const actionKbd = node('span', 'mp-perception-menu-kbd');
    actionBtn.append(actionIcon, actionLabel, actionKbd);

    // Row 2: Clicky guided coach mode (Ctrl+Alt+G)
    const clickyBtn = node('button', 'mp-perception-menu-item');
    clickyBtn.type = 'button';
    clickyBtn.dataset.perceptionClicky = '';
    clickyBtn.hidden = !options.toggleClickyCoach;
    const clickyIcon = node('span', 'cds-icon', '\uE00E');
    clickyIcon.dataset.size = 'small';
    clickyIcon.setAttribute('aria-hidden', 'true');
    const clickyLabel = node('span', 'mp-perception-menu-label');
    const clickyDot = node('span', 'mp-perception-menu-dot');
    clickyDot.setAttribute('aria-hidden', 'true');
    const clickyKbd = node('span', 'mp-perception-menu-kbd', 'Ctrl+Alt+G');
    clickyBtn.append(clickyIcon, clickyLabel, clickyDot, clickyKbd);

    // Row 3: Demo record tutorial
    const recordBtn = node('button', 'mp-perception-menu-item');
    recordBtn.type = 'button';
    recordBtn.dataset.perceptionRecord = '';
    recordBtn.hidden = !options.toggleDemoRecord;
    const recordIcon = node('span', 'cds-icon', '\uE025');
    recordIcon.dataset.size = 'small';
    recordIcon.setAttribute('aria-hidden', 'true');
    const recordLabel = node('span', 'mp-perception-menu-label');
    const recordDot = node('span', 'mp-perception-menu-dot is-recording');
    recordDot.setAttribute('aria-hidden', 'true');
    recordBtn.append(recordIcon, recordLabel, recordDot);

    // Row 4: Mouse wiggle toggle
    const pauseBtn = node('button', 'mp-perception-menu-item');
    pauseBtn.type = 'button';
    pauseBtn.dataset.perceptionPause = '';
    pauseBtn.hidden = !options.setPaused;
    const pauseIcon = node('span', 'cds-icon', '\uE0E7');
    pauseIcon.dataset.size = 'small';
    pauseIcon.setAttribute('aria-hidden', 'true');
    const pauseLabel = node('span', 'mp-perception-menu-label');
    const pauseSwitch = node('span', 'mp-perception-menu-switch');
    pauseSwitch.setAttribute('aria-hidden', 'true');
    pauseBtn.append(pauseIcon, pauseLabel, pauseSwitch);

    const materialsSep = node('div', 'mp-perception-menu-sep');
    const materialsSection = node('div', 'mp-perception-menu-section');
    const materialsList = node('div', 'mp-perception-source-list');

    const settingsSep = node('div', 'mp-perception-menu-sep');
    const settingsBtn = node('button', 'mp-perception-menu-item');
    settingsBtn.type = 'button';
    settingsBtn.dataset.perceptionSettings = '';
    const settingsIcon = node('span', 'cds-icon', '\uE0D6');
    settingsIcon.dataset.size = 'small';
    settingsIcon.setAttribute('aria-hidden', 'true');
    const settingsLabel = node('span', 'mp-perception-menu-label');
    settingsBtn.append(settingsIcon, settingsLabel);

    const notice = node('div', 'mp-perception-menu-note');
    notice.setAttribute('role', 'status');

    const liveHost = node('div', 'mp-perception-live');
    liveHost.dataset.perceptionLive = '';
    liveHost.hidden = true;

    root.append(
      actionBtn,
      clickyBtn,
      recordBtn,
      pauseBtn,
      materialsSep,
      materialsSection,
      materialsList,
      settingsSep,
      settingsBtn,
      notice,
      liveHost,
    );
    host.replaceChildren(root);

    function renderMaterials(): void {
      const sources = context?.sources || [];
      const hasMaterials = sources.length > 0;
      materialsSep.hidden = !hasMaterials;
      materialsSection.hidden = !hasMaterials;
      materialsList.hidden = !hasMaterials;
      materialsList.replaceChildren();
      if (!hasMaterials) {
        return;
      }
      materialsSection.textContent = text(
        `Captured materials (${sources.length})`,
        `已捕获画面 (${sources.length})`,
      );
      for (const source of sources.slice(0, 4)) {
        const row = node('button', 'mp-perception-menu-item');
        row.type = 'button';
        row.dataset.sourceId = source.sourceId;
        const rowLabel = node(
          'span',
          'mp-perception-menu-label',
          source.title || source.kind,
        );
        row.append(rowLabel);
        row.addEventListener('click', () => options.openMaterials(source.sourceId));
        materialsList.append(row);
      }
    }

    function renderLive(): void {
      const activity = status?.activity;
      liveHost.hidden = !activity || activity.state !== 'reading';
      liveHost.textContent = liveHost.hidden
        ? ''
        : text('Reading frozen screen…', '正在读取画面…');
    }

    function render(): void {
      if (disposed) {
        return;
      }
      const value = summarize(status, options.language());
      root.dataset.state = value.state;
      actionLabel.textContent = activating
        ? text('Preparing…', '正在准备…')
        : text('Point at screen', '指屏圈选');
      const primaryHotkey = value.hotkeys[0]?.label || 'Ctrl+Alt+M';
      actionKbd.textContent = primaryHotkey
        .replace(/Control\+/g, 'Ctrl+')
        .replace(/CommandOrControl\+/g, 'Ctrl+');
      actionKbd.hidden = !actionKbd.textContent;
      actionBtn.disabled =
        activating ||
        changingPause ||
        !status ||
        status.paused ||
        status.onboardingRequired;

      const clickyOn = Boolean(options.isClickyCoachActive?.());
      clickyLabel.textContent = text('Clicky guided pointer', 'Clicky 飞指带练');
      clickyBtn.dataset.active = clickyOn ? 'true' : 'false';
      clickyDot.hidden = !clickyOn;

      const recordingOn = Boolean(options.isDemoRecording?.());
      recordLabel.textContent = recordingOn
        ? text('Finish tutorial recording', '完成示范录制')
        : text('Record tutorial demo', '示范录制为教程');
      recordBtn.dataset.active = recordingOn ? 'true' : 'false';
      recordDot.hidden = !recordingOn;

      const wiggleEnabled = Boolean(status && !status.paused);
      pauseLabel.textContent = changingPause
        ? text('Saving…', '保存中…')
        : text('Mouse wiggle wake', '晃动鼠标唤起');
      pauseSwitch.classList.toggle('is-on', wiggleEnabled);
      pauseBtn.disabled = changingPause || !status || status.onboardingRequired;

      settingsLabel.textContent = text('Wake settings', '唤醒设置');

      const alertText =
        error ||
        status?.lastError ||
        (status?.onboardingRequired
          ? text('Complete setup to enable screen pointing.', '完成初始设置后即可指屏选取。')
          : '');
      notice.hidden = !alertText;
      notice.textContent = alertText;
      notice.classList.toggle('is-error', Boolean(error || status?.lastError));

      renderMaterials();
      renderLive();
    }

    async function read(): Promise<void> {
      const generation = ++readGeneration;
      error = '';
      render();
      try {
        const result = await options.readStatus();
        if (generation !== readGeneration || disposed) {
          return;
        }
        status = result;
      } catch (failure) {
        if (generation !== readGeneration || disposed) {
          return;
        }
        status = null;
        error = failure instanceof Error ? failure.message : String(failure);
      } finally {
        if (generation === readGeneration) {
          render();
        }
      }
    }

    actionBtn.addEventListener('click', async () => {
      if (activating || actionBtn.disabled) {
        return;
      }
      activating = true;
      error = '';
      render();
      try {
        const result = await options.activate();
        if (!result.ok) {
          error =
            result.error ||
            text(
              'Could not start selection. Try again.',
              '未能启动指向，请重试。',
            );
        }
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      } finally {
        activating = false;
        render();
      }
    });
    clickyBtn.addEventListener('click', () => {
      options.toggleClickyCoach?.();
      render();
    });
    recordBtn.addEventListener('click', () => {
      options.toggleDemoRecord?.();
      render();
    });
    settingsBtn.addEventListener('click', () =>
      options.openSettings('general'),
    );
    pauseBtn.addEventListener('click', async () => {
      if (!options.setPaused || changingPause || !status || pauseBtn.disabled) {
        return;
      }
      changingPause = true;
      error = '';
      render();
      try {
        const result = await options.setPaused(!status.paused);
        if (!result.ok) {
          throw new Error(
            result.error ||
              text('Could not change pointing state.', '未能更改指向状态。'),
          );
        }
        await read();
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      } finally {
        changingPause = false;
        render();
      }
    });
    render();
    void read();
    return {
      refresh: read,
      updateStatus(next) {
        readGeneration += 1;
        status = next;
        error = '';
        render();
      },
      updateContext(next) {
        if (disposed) {
          return;
        }
        context = next;
        renderMaterials();
      },
      updateEvidence(object) {
        if (disposed || !object || typeof object !== 'object') {
          return;
        }
      },
      updateLanguage: render,
      dispose() {
        disposed = true;
        readGeneration += 1;
        root.remove();
      },
    };
  }

  const api = {create, summarize};
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalThis.DesktopPerception = api;
})();
