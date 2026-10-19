declare global {
  interface Window {
    ModelConnections: {
      mount(
        container: HTMLElement,
        settings: Record<string, any>,
        api: Pick<
          MagicPointerDashboardApi,
          | 'connectModel'
          | 'testModelConnection'
          | 'modelsCatalog'
          | 'listModelConnectionModels'
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
    | 'connectModel'
    | 'testModelConnection'
    | 'modelsCatalog'
    | 'listModelConnectionModels'
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
  let advancedOpen = false;
  let manualModel = false;
  let catalog: MagicPointerModelGroup[] = [];
  let discoveredModels: string[] = [];
  let modelsLoading = false;
  let discoveryVersion = 0;

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
      useLocalOpenCode: false,
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
    const modelChoices = (input: Input): string[] => {
      const profile = profiles.find(
        item =>
          item.id === input.profileId &&
          item.provider === input.provider &&
          item.baseUrl === input.baseUrl &&
          item.apiMode === input.apiMode,
      );
      const entries = catalog
        .filter(group =>
          input.profileId
            ? Boolean(profile && group.profileId === profile.id)
            : group.provider === input.provider,
        )
        .flatMap(group => group.models.map(model => model.id));
      return [
        ...new Set([
          ...discoveredModels,
          ...entries,
          ...(profile?.models || [])
            .map(model => String(model.id || ''))
            .filter(Boolean),
          ...(input.model ? [input.model] : []),
        ]),
      ];
    };
    const render = (): void => {
      if (!container.isConnected) {
        return;
      }
      const active = container.contains(document.activeElement)
        ? document.activeElement
        : null;
      const focusName =
        active instanceof HTMLInputElement ||
        active instanceof HTMLSelectElement
          ? active.name
          : '';
      const caret =
        active instanceof HTMLInputElement &&
        ['text', 'password'].includes(active.type)
          ? [active.selectionStart, active.selectionEnd]
          : null;
      container.className = 'model-connections';
      container.innerHTML = `<section aria-label="${t('Model connections', '模型连接')}">
        <div class="model-connections-heading"><h3>${t('Connections', '已连接服务')}</h3>
        <button type="button" data-model-add ${busy ? 'disabled' : ''}>${t('Add connection', '添加连接')}</button></div>
        <div class="model-connections-list">${
          profiles
            .map(
              profile => `<div class="model-connection-row">
          <div><strong>${escape(profile.displayName)}</strong>${profile.id === defaultId ? `<span class="model-connection-default">${t('Default', '默认')}</span>` : ''}
          <small>${escape(profile.model)}</small></div>
          <button type="button" data-model-edit="${escape(profile.id)}" ${busy ? 'disabled' : ''}>${t('Change model', '更换模型')}</button>
        </div>`,
            )
            .join('') ||
          `<p class="model-connection-hint">${t('Connect a provider to start using Magic Pointer.', '连接模型服务后即可使用 Magic Pointer。')}</p>`
        }</div>
        ${draft ? formMarkup(draft, modelChoices(draft)) : ''}
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
          advancedOpen = false;
          manualModel = false;
          discoveredModels = [];
          modelsLoading = false;
          discoveryVersion++;
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
            advancedOpen = false;
            manualModel = false;
            discoveredModels = [];
            modelsLoading = false;
            discoveryVersion++;
            render();
          });
        });
      form?.addEventListener('input', event => {
        draft = readForm(form, draft!);
        if (
          (event.target as HTMLInputElement).name === 'credential' &&
          draft.credential
        ) {
          draft.useLocalOpenCode = false;
          const local = form.elements.namedItem(
            'useLocalOpenCode',
          ) as HTMLInputElement | null;
          if (local) {
            local.checked = false;
          }
        }
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
            useLocalOpenCode: false,
          };
          advancedOpen = selected === 'custom';
          manualModel = false;
          discoveredModels = [];
          modelsLoading = false;
          discoveryVersion++;
          render();
        });
      form
        ?.querySelector('[data-model-choice]')
        ?.addEventListener('change', event => {
          if ((event.target as HTMLSelectElement).value === '__custom__') {
            manualModel = true;
            draft = {...draft!, model: ''};
            render();
            container
              .querySelector<HTMLInputElement>('[name="model"]')
              ?.focus();
          }
        });
      form?.querySelector('details')?.addEventListener('toggle', event => {
        advancedOpen = (event.target as HTMLDetailsElement).open;
      });
      form?.addEventListener(
        'invalid',
        event => {
          const details = (event.target as HTMLElement).closest('details');
          if (details) {
            details.open = true;
          }
        },
        true,
      );
      form
        ?.querySelector('[data-model-discover]')
        ?.addEventListener('click', async () => {
          if (
            modelsLoading ||
            busy ||
            !draft ||
            !form ||
            !api?.listModelConnectionModels
          ) {
            return;
          }
          draft = readForm(form, draft);
          const input = {...draft};
          const request = ++discoveryVersion;
          const current = () =>
            request === discoveryVersion &&
            draft &&
            [
              'provider',
              'baseUrl',
              'apiMode',
              'credential',
              'profileId',
              'useLocalOpenCode',
            ].every(
              key => draft![key as keyof Input] === input[key as keyof Input],
            );
          modelsLoading = true;
          message = '';
          render();
          try {
            const response = await api.listModelConnectionModels(input);
            if (!current() || !draft) {
              return;
            }
            if (!response.ok) {
              throw new Error(
                response.error ||
                  t(
                    'Could not fetch models. You can enter a model manually.',
                    '未能获取模型，可以手动输入模型名称。',
                  ),
              );
            }
            discoveredModels = (response.models || []).map(model => model.id);
            if (!draft.model && discoveredModels.length) {
              draft.model = discoveredModels[0];
            }
            manualModel = discoveredModels.length === 0;
            failed = false;
            message = discoveredModels.length
              ? ''
              : t(
                  'No models returned. Enter the model name from your provider.',
                  '服务商未返回模型，请输入其提供的模型名称。',
                );
          } catch (error) {
            if (current()) {
              failed = true;
              message = error instanceof Error ? error.message : String(error);
            }
          } finally {
            if (request === discoveryVersion) {
              modelsLoading = false;
              redraw?.();
            }
          }
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
          discoveryVersion++;
          modelsLoading = false;
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
          : t('Testing and saving…', '正在测试并保存…');
        render();
        let saved: Response | undefined;
        try {
          const verified = await api?.testModelConnection?.(input);
          if (!verified?.ok) {
            throw new Error(
              verified?.error ||
                t(
                  'The connection could not be verified.',
                  '连接验证失败，请检查服务和密钥。',
                ),
            );
          }
          const response = test ? verified : await api?.connectModel?.(input);
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
            render();
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
      const focusTarget = focusName
        ? form?.elements.namedItem(focusName)
        : null;
      if (
        focusTarget instanceof HTMLInputElement ||
        focusTarget instanceof HTMLSelectElement
      ) {
        focusTarget.focus();
        if (
          caret &&
          focusTarget instanceof HTMLInputElement &&
          ['text', 'password'].includes(focusTarget.type)
        ) {
          focusTarget.setSelectionRange(caret[0], caret[1]);
        }
      }
    };
    redraw = render;
    render();
    void api
      ?.modelsCatalog?.()
      .then(response => {
        if (!container.isConnected || !response.catalog) {
          return;
        }
        catalog = response.catalog.groups || [];
        if (!draft && !busy) {
          render();
        }
      })
      .catch(() => {});
  }

  function formMarkup(input: Input, models: string[]): string {
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
      ${input.apiMode !== 'local' ? `<label>${t('API key', 'API 密钥')}<input name="credential" type="password" autocomplete="new-password" placeholder="${input.profileId ? t('Leave blank to keep the saved key', '留空以保留已存密钥') : t('Paste your provider API key', '粘贴服务商 API 密钥')}"></label>` : `<p class="model-connection-hint">${t('Local models do not need an API key.', '本地模型无需 API 密钥。')}</p>`}
      ${models.length && !manualModel ? `<label>${t('Model', '模型')}<select name="model" data-model-choice>${models.map(model => `<option value="${escape(model)}" ${model === input.model ? 'selected' : ''}>${escape(model)}</option>`).join('')}<option value="__custom__">${t('Other model…', '其他模型…')}</option></select></label>` : field('model', t('Model', '模型'), t('Choose or enter a model', '选择或输入模型名称'))}
      <button type="button" class="model-connection-discover" data-model-discover ${modelsLoading ? 'disabled' : ''}>${modelsLoading ? t('Fetching models…', '正在获取模型…') : t('Fetch models', '获取模型')}</button>
      <details class="model-connection-advanced" ${advancedOpen ? 'open' : ''}><summary>${t('Advanced', '高级设置')}</summary><div>
      ${field('displayName', t('Connection name', '连接名称'))}
      ${field('baseUrl', t('Service address', '服务地址'), 'https://…/v1')}
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
      ${selected === 'opencode-go' ? `<label class="model-connection-check"><input type="checkbox" name="useLocalOpenCode" ${input.useLocalOpenCode ? 'checked' : ''}>${t('Use the OpenCode Go account on this computer', '使用本机已登录的 OpenCode Go 账户')}</label>` : ''}
      <label class="model-connection-check"><input type="checkbox" name="makeDefault" ${input.makeDefault ? 'checked' : ''}>${t('Use as the default for new chats', '作为新对话的默认连接')}</label>
      <button type="button" data-model-test>${t('Test only', '仅测试连接')}</button>
      </div></details>
      <p class="model-connection-hint">${t('Keys stay in encrypted local storage. Test connection sends a small request to the selected provider.', '密钥加密保存在本机。测试连接会向所选服务商发送一次小请求。')}</p>
      <div class="model-connection-actions"><button type="button" data-model-cancel>${t('Cancel', '取消')}</button><button type="submit">${t('Test and save', '测试并保存')}</button></div>
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
