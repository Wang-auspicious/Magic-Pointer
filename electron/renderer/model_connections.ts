declare global {
  interface Window {
    ModelConnections: {
      mount(
        container: HTMLElement,
        settings: Record<string, any>,
        api: Pick<
          MagicPointerDashboardApi,
          'connectModel' | 'testModelConnection'
        > | null,
        onSaved: (
          response: import('../model_connection').ModelConnectionResponse,
        ) => void,
      ): void;
    };
  }
}

window.ModelConnections = (() => {
  type Input = import('../model_connection').ModelConnectionInput;
  type Profile = import('../model_connection').ConnectedModelProfile;
  type Response = import('../model_connection').ModelConnectionResponse;
  type Api = Pick<
    MagicPointerDashboardApi,
    'connectModel' | 'testModelConnection'
  >;

  const presets: Record<
    string,
    {name: string; url: string; mode: Input['apiMode']; model: string}
  > = {
    'opencode-go': {
      name: 'OpenCode Go',
      url: 'https://opencode.ai/zen/go/v1',
      mode: 'chat-completions',
      model: 'deepseek-v4.1-flash',
    },
    openai: {
      name: 'OpenAI',
      url: 'https://api.openai.com/v1',
      mode: 'responses',
      model: '',
    },
    anthropic: {
      name: 'Anthropic',
      url: 'https://api.anthropic.com/v1',
      mode: 'messages',
      model: '',
    },
    custom: {
      name: 'OpenAI compatible',
      url: '',
      mode: 'chat-completions',
      model: '',
    },
    local: {
      name: 'Local model',
      url: 'http://localhost:11434/v1',
      mode: 'local',
      model: '',
    },
  };
  let draft: Input | null = null;
  let busy = false;
  let message = '';
  let failed = false;
  let redraw: (() => void) | undefined;

  const t = (en: string, zh: string): string =>
    document.documentElement.lang.startsWith('zh') ? zh : en;
  const escape = (value: unknown): string =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  function fresh(provider = 'opencode-go'): Input {
    const preset = presets[provider];
    return {
      displayName: preset.name,
      provider,
      baseUrl: preset.url,
      model: preset.model,
      apiMode: preset.mode,
      useLocalOpenCode: provider === 'opencode-go',
      makeDefault: true,
    };
  }

  function mount(
    container: HTMLElement,
    settings: Record<string, any>,
    api: Api | null,
    onSaved: (response: Response) => void,
  ): void {
    const profiles: Profile[] = settings.models?.profiles || [];
    const defaultId = settings.models?.defaultProfileId;
    const render = (): void => {
      if (!container.isConnected) {
        return;
      }
      container.className = 'model-connections';
      container.innerHTML = `<section aria-label="${t('Model connections', '模型连接')}">
        <div class="model-connections-heading"><h3>${t('Connections', '已连接服务')}</h3>
        <button type="button" data-model-add ${busy ? 'disabled' : ''}>${t('Add connection', '添加连接')}</button></div>
        <div class="model-connections-list">${
          profiles
            .map(
              profile => `<div class="model-connection-row">
          <div><strong>${escape(profile.displayName)}</strong>${profile.id === defaultId ? `<span class="model-connection-default">${t('Default', '默认')}</span>` : ''}
          <small>${escape(profile.model)} · ${escape(profile.baseUrl)}</small></div>
          <button type="button" data-model-edit="${escape(profile.id)}" ${busy ? 'disabled' : ''}>${t('Edit', '编辑')}</button>
        </div>`,
            )
            .join('') ||
          `<p class="model-connection-hint">${t('Connect a provider to start using Magic Pointer.', '连接模型服务后即可使用 Magic Pointer。')}</p>`
        }</div>
        ${draft ? formMarkup(draft) : ''}
        <p class="model-connection-status" role="status" data-error="${failed}" ${message ? '' : 'hidden'}>${escape(message)}</p>
      </section>`;
      const form = container.querySelector<HTMLFormElement>('form');
      const credential = form?.elements.namedItem(
        'credential',
      ) as HTMLInputElement | null;
      if (credential) {
        credential.value = draft?.credential || '';
      }
      container
        .querySelector('[data-model-add]')
        ?.addEventListener('click', () => {
          draft = fresh();
          message = '';
          render();
        });
      container
        .querySelectorAll<HTMLButtonElement>('[data-model-edit]')
        .forEach(button => {
          button.addEventListener('click', () => {
            const profile = profiles.find(
              item => item.id === button.dataset.modelEdit,
            );
            if (!profile) {
              return;
            }
            draft = {
              profileId: profile.id,
              displayName: profile.displayName,
              provider: profile.provider,
              baseUrl: profile.baseUrl,
              model: profile.model,
              apiMode: profile.apiMode,
              makeDefault: profile.id === defaultId,
              useLocalOpenCode: false,
            };
            message = '';
            render();
          });
        });
      form?.addEventListener('input', () => {
        draft = readForm(form, draft!);
        message = '';
        const status = container.querySelector<HTMLElement>(
          '.model-connection-status',
        );
        if (status) {
          status.hidden = true;
        }
      });
      form
        ?.querySelector('[name="preset"]')
        ?.addEventListener('change', event => {
          const selected = (event.target as HTMLSelectElement).value;
          draft = {
            ...fresh(selected),
            profileId: draft?.profileId,
            credential: '',
            useLocalOpenCode: selected === 'opencode-go',
          };
          render();
        });
      form
        ?.querySelector('[name="useLocalOpenCode"]')
        ?.addEventListener('change', () => render());
      form
        ?.querySelector('[name="apiMode"]')
        ?.addEventListener('change', () => render());
      form
        ?.querySelector('[data-model-cancel]')
        ?.addEventListener('click', () => {
          draft = null;
          message = '';
          render();
        });
      const submit = async (test: boolean): Promise<void> => {
        if (busy || !draft || !form?.reportValidity()) {
          return;
        }
        draft = readForm(form, draft);
        const input = {...draft};
        busy = true;
        failed = false;
        message = test
          ? t('Testing connection…', '正在测试连接…')
          : t('Saving connection…', '正在保存连接…');
        render();
        let saved: Response | undefined;
        try {
          const response = test
            ? await api?.testModelConnection?.(input)
            : await api?.connectModel?.(input);
          if (!response?.ok) {
            throw new Error(
              response?.error ||
                t(
                  'The model connection bridge is unavailable.',
                  '模型连接通道不可用。',
                ),
            );
          }
          message = test
            ? `${t('Connection verified', '连接验证成功')} · ${response.usedBackend} · ${((response.latencyMs || 0) / 1000).toFixed(1)}s`
            : t(
                'Connection saved. You can select its models in the composer.',
                '连接已保存，可在输入框的模型菜单中选择。',
              );
          if (!test) {
            draft = null;
            saved = response;
          }
        } catch (error) {
          failed = true;
          message = error instanceof Error ? error.message : String(error);
        } finally {
          busy = false;
          if (saved) {
            onSaved(saved);
          } else {
            redraw?.();
          }
        }
      };
      form?.addEventListener('submit', event => {
        event.preventDefault();
        void submit(false);
      });
      form
        ?.querySelector('[data-model-test]')
        ?.addEventListener('click', () => void submit(true));
    };
    redraw = render;
    render();
  }

  function formMarkup(input: Input): string {
    const selected = presets[input.provider] ? input.provider : 'custom';
    const field = (
      name: keyof Input,
      label: string,
      placeholder = '',
    ): string =>
      `<label>${label}<input name="${name}" value="${escape(input[name])}" placeholder="${escape(placeholder)}" required autocomplete="off" spellcheck="false"></label>`;
    return `<form class="model-connection-form"><fieldset ${busy ? 'disabled' : ''}>
      <label>${t('Provider', '服务商')}<select name="preset">${Object.entries(
        presets,
      )
        .map(
          ([id, preset]) =>
            `<option value="${id}" ${id === selected ? 'selected' : ''}>${preset.name}</option>`,
        )
        .join('')}</select></label>
      ${field('displayName', t('Connection name', '连接名称'))}
      ${field('baseUrl', t('API base URL', 'API 地址'), 'https://…/v1')}
      <label>${t('API protocol', 'API 协议')}<select name="apiMode">${[
        ['chat-completions', 'Chat Completions'],
        ['responses', 'Responses'],
        ['messages', 'Anthropic Messages'],
        ['local', t('Local · no key', '本地 · 无需密钥')],
      ]
        .map(
          ([id, label]) =>
            `<option value="${id}" ${id === input.apiMode ? 'selected' : ''}>${label}</option>`,
        )
        .join('')}</select></label>
      ${field('model', t('Model ID', '模型 ID'), t('Exact model ID from your provider', '服务商提供的完整模型 ID'))}
      ${selected === 'opencode-go' ? `<label class="model-connection-check"><input type="checkbox" name="useLocalOpenCode" ${input.useLocalOpenCode ? 'checked' : ''}>${t('Use the OpenCode Go account on this computer', '使用本机已登录的 OpenCode Go 账户')}</label>` : ''}
      <label>${t('API key', 'API 密钥')}<input name="credential" type="password" autocomplete="new-password" ${input.useLocalOpenCode || input.apiMode === 'local' ? 'disabled' : ''} placeholder="${input.profileId ? t('Leave blank to keep the saved key', '留空以保留已存密钥') : t('Your provider API key', '服务商 API 密钥')}"></label>
      <label class="model-connection-check"><input type="checkbox" name="makeDefault" ${input.makeDefault ? 'checked' : ''}>${t('Use as the default for new chats', '作为新对话的默认连接')}</label>
      <p class="model-connection-hint">${t('Keys stay in encrypted local storage. Test connection sends a small request to the selected provider.', '密钥加密保存在本机。测试连接会向所选服务商发送一次小请求。')}</p>
      <div class="model-connection-actions"><button type="button" data-model-cancel>${t('Cancel', '取消')}</button><button type="button" data-model-test>${t('Test connection', '测试连接')}</button><button type="submit">${t('Save connection', '保存连接')}</button></div>
    </fieldset></form>`;
  }

  function readForm(form: HTMLFormElement, previous: Input): Input {
    const value = (name: string): string =>
      (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement)
        ?.value || '';
    const checked = (name: string): boolean =>
      (form.elements.namedItem(name) as HTMLInputElement)?.checked === true;
    return {
      ...previous,
      displayName: value('displayName'),
      baseUrl: value('baseUrl'),
      model: value('model'),
      apiMode: value('apiMode') as Input['apiMode'],
      credential: value('credential'),
      useLocalOpenCode: checked('useLocalOpenCode'),
      makeDefault: checked('makeDefault'),
    };
  }

  return {mount};
})();
