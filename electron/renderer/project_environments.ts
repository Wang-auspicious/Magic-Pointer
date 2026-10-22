type ProjectRunEnvironment = import('../project_context').ProjectRunEnvironment;

interface ProjectEnvironmentsApi {
  open(
    project: MagicPointerProject,
    data: MagicPointerDataApi,
    onSaved: (project: MagicPointerProject) => Promise<void>,
    trigger: HTMLElement,
  ): Promise<void>;
}

declare global {
  var ProjectEnvironments: ProjectEnvironmentsApi;
}

(() => {
  const permissions = (
    globalThis as {
      PermissionPresets?: {
        PRESETS: Array<{value: string; name: string; label: string}>;
      };
    }
  ).PermissionPresets!;
  const efforts = (
    globalThis as {
      EffortLevels?: {EFFORT_LEVELS: Array<{value: string; label: string}>};
    }
  ).EffortLevels!;
  function escape(value: unknown): string {
    return String(value ?? '').replace(/[&<>"']/g, character => {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[character]!;
    });
  }

  async function open(
    project: MagicPointerProject,
    data: MagicPointerDataApi,
    onSaved: (project: MagicPointerProject) => Promise<void>,
    trigger: HTMLElement,
  ): Promise<void> {
    const [catalog, repository] = await Promise.all([
      data.models().catch(() => null),
      project.root ? data.projectEnvironment(project.root).catch(() => null) : null,
    ]);
    if (document.querySelector('[data-project-environments]')) {
      return;
    }
    const models: Array<MagicPointerModelSelection & {label: string}> = [];
    for (const group of catalog?.groups || []) {
      for (const entry of group.models) {
        models.push({
          model: entry.id,
          profileId: entry.profileId || group.profileId,
          label: `${entry.id} · ${group.name}`,
        });
      }
    }
    const environments = structuredClone(project.environments || []);
    for (const environment of environments) {
      const saved = environment.modelSelection;
      if (
        saved &&
        !models.some(
          item =>
            item.model === saved.model && item.profileId === saved.profileId,
        )
      ) {
        models.push({
          ...saved,
          label: `${saved.model}${saved.profileId ? ` · ${saved.profileId}` : ''}`,
        });
      }
    }
    let defaultId = project.defaultEnvironmentId || '';
    let selectedId = defaultId || environments[0]?.id || '';
    let saving = false;
    const dialog = document.createElement('dialog');
    dialog.className = 'mp-environment-editor';
    dialog.dataset.projectEnvironments = ProjectScope.key(project);
    document.body.append(dialog);
    const selected = () => environments.find(item => item.id === selectedId);
    const input = <T extends HTMLElement>(name: string): T =>
      dialog.querySelector<T>(`[name="${name}"]`)!;

    function readForm(): void {
      const environment = selected();
      if (!environment) {
        return;
      }
      environment.name = input<HTMLInputElement>('environmentName').value;
      const model = models[Number(input<HTMLSelectElement>('model').value)];
      environment.modelSelection = model
        ? {
            model: model.model,
            ...(model.profileId ? {profileId: model.profileId} : {}),
          }
        : undefined;
      environment.permissionPreset =
        (input<HTMLSelectElement>('permission')
          .value as MagicPointerPermissionPreset) || undefined;
      environment.effort =
        (input<HTMLSelectElement>('effort')
          .value as ProjectRunEnvironment['effort']) || undefined;
      environment.additionalFolders = input<HTMLTextAreaElement>('folders')
        .value.split('\n')
        .map(value => value.trim())
        .filter(Boolean);
      environment.branch = input<HTMLInputElement>('branch').value.trim();
      environment.worktree = input<HTMLInputElement>('worktree').checked;
      if (input<HTMLInputElement>('default').checked) {
        defaultId = environment.id;
      } else if (defaultId === environment.id) {
        defaultId = '';
      }
    }

    function close(): void {
      window.removeEventListener('mp:language-change', updateLanguage);
      dialog.close();
      dialog.remove();
      const currentTrigger = trigger.isConnected
        ? trigger
        : document.querySelector<HTMLElement>(
            `[data-project-tools="${CSS.escape(ProjectScope.key(project))}"]`,
          );
      currentTrigger?.focus({preventScroll: true});
    }

    function paint(): void {
      const environment = selected();
      const modelIndex = models.findIndex(
        item =>
          item.model === environment?.modelSelection?.model &&
          item.profileId === environment?.modelSelection?.profileId,
      );
      dialog.setAttribute('aria-label', studioT('environment.title'));
      dialog.innerHTML = `<form>
        <header><h2>${studioT('environment.title')}</h2><p>${escape(project.name)}${project.root ? ` · ${escape(project.root)}` : ''}</p></header>
        <label>${studioT('environment.saved')}<select name="environment" ${environments.length ? '' : 'disabled'}>${environments.length ? environments.map(item => `<option value="${escape(item.id)}" ${item.id === selectedId ? 'selected' : ''}>${escape(item.name)}</option>`).join('') : `<option>${studioT('environment.empty')}</option>`}</select></label>
        <div class="mp-environment-actions"><button type="button" data-env-new>${studioT('environment.new')}</button><button type="button" data-env-duplicate ${environment ? '' : 'disabled'}>${studioT('environment.duplicate')}</button><button type="button" data-env-remove ${environment ? '' : 'disabled'}>${studioT('environment.remove')}</button></div>
        <fieldset ${environment ? '' : 'disabled'}>
          <label>${studioT('environment.name')}<input name="environmentName" maxlength="120" required value="${escape(environment?.name)}"></label>
          <label>${studioT('environment.model')}<select name="model"><option value="-1">${studioT('environment.inherit')}</option>${models.map((item, index) => `<option value="${index}" ${index === modelIndex ? 'selected' : ''}>${escape(item.label)}</option>`).join('')}</select></label>
          <label>${studioT('environment.permission')}<select name="permission"><option value="">${studioT('environment.inherit')}</option>${permissions.PRESETS.map(item => `<option value="${item.value}" ${item.value === environment?.permissionPreset ? 'selected' : ''}>${escape(getStudioLanguage() === 'zh-CN' ? item.name : item.label)}</option>`).join('')}</select></label>
          <p class="mp-environment-note" data-env-permission></p>
          <label>${studioT('environment.effort')}<select name="effort"><option value="">${studioT('environment.inherit')}</option>${efforts.EFFORT_LEVELS.map(item => `<option value="${item.value}" ${item.value === environment?.effort ? 'selected' : ''}>${escape(studioT(`environment.effort_${item.value}`))}</option>`).join('')}</select></label>
          <label>${studioT('environment.folders')}<textarea name="folders" rows="2" placeholder="${studioT('environment.folders_hint')}">${escape(environment?.additionalFolders?.join('\n'))}</textarea></label>
          <label>${studioT('environment.branch')}<input name="branch" list="mp-environment-branches" value="${escape(environment?.branch)}" placeholder="${studioT('environment.current_branch')}"><datalist id="mp-environment-branches">${(repository?.branches || []).map(branch => `<option value="${escape(branch)}"></option>`).join('')}</datalist></label>
          <label class="mp-environment-default"><input type="checkbox" name="worktree" ${environment?.worktree ? 'checked' : ''}>${studioT('environment.worktree')}</label>
          <p class="mp-environment-note">${studioT('environment.git_hint')}</p>
          <label class="mp-environment-default"><input type="checkbox" name="default" ${environment && defaultId === environment.id ? 'checked' : ''}>${studioT('environment.default')}</label>
        </fieldset>
        <p class="mp-environment-note">${studioT('environment.hint')}</p>
        <p class="mp-environment-error" data-env-error role="status"></p>
        <footer><button type="button" data-env-cancel>${studioT('environment.cancel')}</button><button type="submit" class="is-primary">${studioT('environment.save')}</button></footer>
      </form>`;
      permissionDescription();
    }

    function permissionDescription(): void {
      const value = input<HTMLSelectElement>('permission').value;
      dialog.querySelector('[data-env-permission]')!.textContent = value
        ? studioT(`environment.permission_${value}`)
        : '';
    }

    function updateLanguage(): void {
      readForm();
      const active = document.activeElement as HTMLInputElement | null;
      const name = active?.name;
      const start = active?.selectionStart;
      const end = active?.selectionEnd;
      paint();
      const restored = name
        ? dialog.querySelector<HTMLInputElement>(`[name="${name}"]`)
        : null;
      restored?.focus({preventScroll: true});
      if (start != null && end != null) {
        restored?.setSelectionRange(start, end);
      }
      setSaving(saving);
    }

    function setSaving(value: boolean): void {
      saving = value;
      dialog.setAttribute('aria-busy', String(value));
      for (const control of dialog.querySelectorAll<
        HTMLButtonElement | HTMLFieldSetElement
      >('button, fieldset, [name="environment"]')) {
        control.disabled = value;
      }
      if (!value && !selected()) {
        dialog.querySelector<HTMLFieldSetElement>('fieldset')!.disabled = true;
        for (const button of dialog.querySelectorAll<HTMLButtonElement>(
          '[data-env-duplicate], [data-env-remove]',
        )) {
          button.disabled = true;
        }
      }
    }

    dialog.addEventListener('change', event => {
      const target = event.target as HTMLElement;
      if (target.matches('[name="environment"]')) {
        readForm();
        selectedId = input<HTMLSelectElement>('environment').value;
        paint();
        input<HTMLSelectElement>('environment').focus();
      } else if (target.matches('[name="permission"]')) {
        permissionDescription();
      }
    });
    dialog.addEventListener('click', event => {
      const target = (event.target as Element).closest('button');
      if (!target || saving) {
        return;
      }
      if (target.matches('[data-env-cancel]')) {
        close();
        return;
      }
      if (
        target.matches(
          '[data-env-new], [data-env-duplicate], [data-env-remove]',
        )
      ) {
        readForm();
        const current = selected();
        if (target.matches('[data-env-remove]')) {
          environments.splice(
            environments.findIndex(item => item.id === selectedId),
            1,
          );
          if (defaultId === selectedId) {
            defaultId = '';
          }
          selectedId = environments[0]?.id || '';
        } else {
          const environment: ProjectRunEnvironment = {
            ...(target.matches('[data-env-duplicate]') && current
              ? structuredClone(current)
              : {}),
            id: crypto.randomUUID(),
            name: studioT('environment.new_name', {n: environments.length + 1}),
          };
          environments.push(environment);
          selectedId = environment.id;
        }
        paint();
        input<HTMLInputElement>('environmentName').focus();
      }
    });
    dialog.addEventListener('submit', event => {
      event.preventDefault();
      if (saving) {
        return;
      }
      readForm();
      setSaving(true);
      void (async () => {
        try {
          const result = await data.updateProject(ProjectScope.key(project), {
            environments,
            defaultEnvironmentId: defaultId,
          });
          if (!result.ok || !result.project) {
            throw new Error(result.error || studioT('environment.save_failed'));
          }
          await onSaved(result.project);
          close();
        } catch (error) {
          setSaving(false);
          dialog.querySelector('[data-env-error]')!.textContent =
            error instanceof Error ? error.message : String(error);
          dialog.querySelector<HTMLButtonElement>('[type="submit"]')?.focus();
        }
      })();
    });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (saving || event.repeat) {
          event.preventDefault();
        }
      }
    });
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      if (!saving) {
        close();
      }
    });
    window.addEventListener('mp:language-change', updateLanguage);
    paint();
    dialog.showModal();
    (environments.length
      ? input('environment')
      : dialog.querySelector<HTMLElement>('[data-env-new]')
    )?.focus();
  }

  globalThis.ProjectEnvironments = {open};
})();
