interface ProjectConversation
  extends ConversationActivityInput, ProjectMembership {
  id: string;
  title?: string;
  workspaceRoot?: string;
  updatedAt?: number;
}

interface ProjectWorkspaceOptions {
  data: MagicPointerDataApi;
  onBack(): void;
  onCompose(root: string, prompt: string, projectId?: string): void;
  onChanged(project: MagicPointerProject): void;
  draft?: string;
  onDraftChange?(text: string): void;
}

interface ProjectWorkspaceApi {
  create(
    host: HTMLElement,
    data: MagicPointerDataApi,
    onCreated: (project: MagicPointerProject) => void,
    initialName?: string,
  ): void;
  mount(
    host: HTMLElement,
    project: MagicPointerProject,
    conversations: readonly ProjectConversation[],
    options: ProjectWorkspaceOptions,
  ): void;
}

declare global {
  var ProjectWorkspace: ProjectWorkspaceApi;
}

(() => {
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

  function fileName(file: string): string {
    return file.split(/[\\/]/).pop() || file;
  }

  function action(label: string, key: string, primary = false): string {
    return `<button type="button" class="mp-project-button${primary ? ' is-primary' : ''}" data-project-action="${key}">${label}</button>`;
  }

  function create(
    host: HTMLElement,
    data: MagicPointerDataApi,
    onCreated: (project: MagicPointerProject) => void,
    initialName = '',
  ): void {
    const dialog = document.createElement('dialog');
    dialog.className = 'mp-project-editor';
    dialog.innerHTML = `<form>
      <header><h2>Create project</h2><button type="button" data-project-editor-close aria-label="Close">×</button></header>
      <label>Name<input name="name" value="${escape(initialName)}" maxlength="120" placeholder="Name your project" required></label>
      <label>Description (optional)<textarea name="description" rows="4" maxlength="2000" placeholder="What are you working on?"></textarea></label>
      <p class="mp-project-status" data-project-edit-error role="status"></p>
      <footer><button type="button" class="mp-project-button" data-project-editor-close>Cancel</button><button type="submit" class="mp-project-button is-primary">Create project</button></footer>
    </form>`;
    host.append(dialog);
    dialog
      .querySelectorAll('[data-project-editor-close]')
      .forEach(button =>
        button.addEventListener('click', () => dialog.close()),
      );
    dialog.addEventListener('close', () => dialog.remove(), {once: true});
    dialog.querySelector('form')!.addEventListener('submit', event => {
      event.preventDefault();
      event.stopPropagation();
      const submit =
        dialog.querySelector<HTMLButtonElement>('[type="submit"]')!;
      if (submit.disabled) {
        return;
      }
      const values = new FormData(event.currentTarget as HTMLFormElement);
      submit.disabled = true;
      void data
        .createProject({
          name: String(values.get('name') || ''),
          description: String(values.get('description') || ''),
        })
        .then(result => {
          if (!result.ok || !result.project) {
            throw new Error(
              result.error || 'Could not create project. Try again.',
            );
          }
          if (dialog.isConnected && dialog.open) {
            dialog.close();
            onCreated(result.project);
          }
        })
        .catch(error => {
          dialog.querySelector('[data-project-edit-error]')!.textContent =
            error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          submit.disabled = false;
        });
    });
    dialog.showModal();
  }

  function mount(
    host: HTMLElement,
    initialProject: MagicPointerProject,
    conversations: readonly ProjectConversation[],
    options: ProjectWorkspaceOptions,
  ): void {
    let project = initialProject;
    let chatDraft = options.draft || '';
    let saving = false;
    const root = document.createElement('section');
    root.className = 'mp-project-workspace';
    root.setAttribute('aria-label', project.name);
    host.replaceChildren(root);
    const rows = conversations
      .filter(row => ProjectScope.contains(project, row))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    function status(message: string): void {
      const target = root.querySelector<HTMLElement>('[data-project-status]');
      if (target) {
        target.textContent = message;
        target.hidden = !message;
      }
    }

    function paint(): void {
      chatDraft =
        root.querySelector<HTMLTextAreaElement>('.mp-project-compose textarea')
          ?.value ?? chatDraft;
      const search =
        root.querySelector<HTMLInputElement>('[data-project-chat-search]')
          ?.value || '';
      root.innerHTML = `
        <nav class="mp-project-breadcrumb" aria-label="Project navigation">
          ${action('Projects', 'back')}<span aria-hidden="true">/</span><span>${escape(project.name)}</span>
        </nav>
        <header class="mp-project-heading">
          <div><h1>${escape(project.name)}</h1>${project.description ? `<p>${escape(project.description)}</p>` : '<p>Add a description to keep your work in focus.</p>'}</div>
          <div class="mp-project-heading-actions">
            ${action('Edit details', 'details')}
            <details class="mp-project-menu">
              <summary class="mp-project-button" aria-label="Project actions">···</summary>
              <div>
                ${action(project.starred ? 'Unstar project' : 'Star project', 'star')}
                ${action(project.archived ? 'Restore project' : 'Archive project', project.archived ? 'restore' : 'archive')}
              </div>
            </details>
          </div>
        </header>
        <p class="mp-project-status" data-project-status role="status" hidden></p>
        ${project.archived ? `<div class="mp-project-archive-note"><p>This project is archived. Your chats, instructions, and files are saved.</p>${action('Restore project', 'restore')}</div>` : ''}
        <div class="mp-project-columns">
          <div class="mp-project-chats">
            ${
              project.archived
                ? ''
                : `<form class="mp-project-compose">
              <textarea name="prompt" rows="3" aria-label="New chat in ${escape(project.name)}" placeholder="Start a chat in this project" required></textarea>
              <div><span>Uses this project's instructions and files</span><button class="mp-project-button is-primary" type="submit">Start chat <span aria-hidden="true">↑</span></button></div>
            </form>`
            }
            <div class="mp-project-section-heading"><h2>Chats</h2><span>${rows.length}</span></div>
            <label class="mp-project-chat-search"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m12.5 12.5 4.5 4.5"/></svg><input type="search" placeholder="Search chats" aria-label="Search project chats" data-project-chat-search></label>
            <div class="mp-project-chat-list">${rows
              .map(
                row => `
              <button type="button" class="mp-project-chat" data-open="${escape(row.id)}" data-project-chat-title="${escape(row.title || 'Untitled')}">
                <span><strong>${escape(row.title || 'Untitled')}</strong>${row.hasPendingWork || row.lastFailed ? `<small>${escape(ConversationState.label(ConversationState.derive(row)))}</small>` : ''}</span>
                ${row.updatedAt ? `<time datetime="${new Date(row.updatedAt).toISOString()}">${escape(new Date(row.updatedAt).toLocaleDateString(undefined, {month: 'short', day: 'numeric'}))}</time>` : ''}
              </button>`,
              )
              .join('')}
              <p class="mp-project-empty" data-project-no-chats ${rows.length ? 'hidden' : ''}>Your project chats will appear here.</p>
            </div>
          </div>
          <aside class="mp-project-context" aria-label="Project context">
            <section>
              <div class="mp-project-section-heading"><h2>Instructions</h2>${action('Edit', 'instructions')}</div>
              <p class="mp-project-instructions ${project.instructions ? '' : 'is-empty'}">${escape(project.instructions || 'Set how Magic Pointer should respond in this project.')}</p>
            </section>
            <section>
              <div class="mp-project-section-heading"><h2>Files <span>${project.sharedFiles?.length || 0}</span></h2>${action('Add files', 'files')}</div>
              <p class="mp-project-context-note">Available to every chat in this project.</p>
              <ul class="mp-project-files">${(project.sharedFiles || []).map((file, index) => `<li title="${escape(file)}"><span>${escape(fileName(file))}</span><button type="button" data-project-action="remove-file" data-file-index="${index}" aria-label="Remove ${escape(fileName(file))} from project">×</button></li>`).join('')}</ul>
              ${project.sharedFiles?.length ? '' : '<p class="mp-project-empty">Add reference documents, notes, or images.</p>'}
            </section>
            ${project.root ? `<section class="mp-project-location"><h2>Local folder</h2><p>${escape(project.root)}</p>${action('Open folder', 'folder')}</section>` : ''}
          </aside>
        </div>`;
      const composer = root.querySelector<HTMLTextAreaElement>(
        '.mp-project-compose textarea',
      );
      if (composer) {
        composer.value = chatDraft;
      }
      const searchInput = root.querySelector<HTMLInputElement>(
        '[data-project-chat-search]',
      )!;
      searchInput.value = search;
      searchInput.dispatchEvent(new Event('input', {bubbles: true}));
    }

    async function save(patch: MagicPointerProjectPatch): Promise<boolean> {
      if (saving) {
        return false;
      }
      saving = true;
      root.setAttribute('aria-busy', 'true');
      try {
        const result = await options.data.updateProject(
          ProjectScope.key(project),
          patch,
        );
        if (!result.ok || !result.project) {
          throw new Error(result.error || 'Could not save project. Try again.');
        }
        project = result.project;
        options.onChanged(project);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        status(message);
        const dialogError = root.querySelector<HTMLElement>(
          '[data-project-edit-error]',
        );
        if (dialogError) {
          dialogError.textContent = message;
        }
        return false;
      } finally {
        saving = false;
        root.removeAttribute('aria-busy');
      }
    }

    function edit(kind: 'details' | 'instructions'): void {
      const dialog = document.createElement('dialog');
      dialog.className = 'mp-project-editor';
      const instructions = kind === 'instructions';
      dialog.innerHTML = `<form>
        <header><h2>${instructions ? 'Project instructions' : 'Edit project details'}</h2><button type="button" data-project-editor-close aria-label="Close">×</button></header>
        ${
          instructions
            ? `<p>Applies to every new message in this project.</p><label>Instructions<textarea name="instructions" rows="9" maxlength="12000" placeholder="What should Magic Pointer know about this project?">${escape(project.instructions)}</textarea></label>`
            : `<label>Name<input name="name" value="${escape(project.name)}" maxlength="120" required></label><label>Description<textarea name="description" rows="4" maxlength="2000" placeholder="What are you working on?">${escape(project.description)}</textarea></label>`
        }
        <p class="mp-project-status" data-project-edit-error role="status"></p>
        <footer><button type="button" class="mp-project-button" data-project-editor-close>Cancel</button><button type="submit" class="mp-project-button is-primary">Save</button></footer>
      </form>`;
      root.append(dialog);
      const close = () => dialog.close();
      dialog
        .querySelectorAll('[data-project-editor-close]')
        .forEach(button => button.addEventListener('click', close));
      dialog.addEventListener('close', () => dialog.remove(), {once: true});
      dialog.querySelector('form')!.addEventListener('submit', event => {
        event.preventDefault();
        event.stopPropagation();
        const form = event.currentTarget as HTMLFormElement;
        const values = new FormData(form);
        const patch: MagicPointerProjectPatch = instructions
          ? {instructions: String(values.get('instructions') || '')}
          : {
              name: String(values.get('name') || ''),
              description: String(values.get('description') || ''),
            };
        const submit =
          form.querySelector<HTMLButtonElement>('[type="submit"]')!;
        submit.disabled = true;
        void save(patch).then(saved => {
          submit.disabled = false;
          if (saved && root.isConnected) {
            close();
            paint();
          }
        });
      });
      dialog.showModal();
    }

    function confirmArchive(): void {
      const dialog = document.createElement('dialog');
      dialog.className = 'mp-project-editor mp-project-archive-dialog';
      dialog.innerHTML = `<form>
        <header><h2>Archive project?</h2></header>
        <p>Archive ${escape(project.name)}? It will leave your active projects. Your chats, instructions, and files will be kept, and you can restore it later.</p>
        <p class="mp-project-status" data-project-edit-error role="status"></p>
        <footer><button type="button" class="mp-project-button" data-project-editor-close>Cancel</button><button type="submit" class="mp-project-button is-primary">Archive project</button></footer>
      </form>`;
      root.append(dialog);
      dialog
        .querySelector('[data-project-editor-close]')!
        .addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => dialog.remove(), {once: true});
      dialog.querySelector('form')!.addEventListener('submit', event => {
        event.preventDefault();
        event.stopPropagation();
        const submit =
          dialog.querySelector<HTMLButtonElement>('[type="submit"]')!;
        submit.disabled = true;
        void save({archived: true}).then(saved => {
          submit.disabled = false;
          if (saved && root.isConnected) {
            dialog.close();
            paint();
            options.onBack();
          }
        });
      });
      dialog.showModal();
    }

    root.addEventListener('input', event => {
      const input = event.target as HTMLInputElement;
      if (input.matches('.mp-project-compose textarea')) {
        chatDraft = input.value;
        options.onDraftChange?.(chatDraft);
        return;
      }
      if (!input.matches('[data-project-chat-search]')) {
        return;
      }
      const query = input.value.trim().toLocaleLowerCase();
      let visible = 0;
      root
        .querySelectorAll<HTMLElement>('[data-project-chat-title]')
        .forEach(row => {
          row.hidden = !row.dataset
            .projectChatTitle!.toLocaleLowerCase()
            .includes(query);
          visible += Number(!row.hidden);
        });
      const empty = root.querySelector<HTMLElement>('[data-project-no-chats]')!;
      empty.hidden = visible > 0;
      empty.textContent = query
        ? 'No matching chats.'
        : 'Your project chats will appear here.';
    });

    root.addEventListener('submit', event => {
      const form = event.target as HTMLFormElement;
      if (!form.matches('.mp-project-compose')) {
        return;
      }
      event.preventDefault();
      const prompt = String(new FormData(form).get('prompt') || '').trim();
      if (prompt) {
        options.onCompose(project.root, prompt, project.id);
        chatDraft = '';
        form.querySelector<HTMLTextAreaElement>('textarea')!.value = '';
        options.onDraftChange?.('');
      }
    });

    root.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>(
        '[data-project-action]',
      );
      if (!button || saving) {
        return;
      }
      const key = button.dataset.projectAction;
      if (key === 'back') {
        options.onBack();
      } else if (key === 'star' || key === 'restore') {
        const patch =
          key === 'star' ? {starred: !project.starred} : {archived: false};
        void save(patch).then(saved => {
          if (saved && root.isConnected) {
            paint();
          }
        });
      } else if (key === 'archive') {
        confirmArchive();
      } else if (key === 'details' || key === 'instructions') {
        edit(key);
      } else if (key === 'files') {
        button.disabled = true;
        void options.data
          .pickProjectFiles(project.root)
          .then(async result => {
            if (result.canceled) {
              return;
            }
            if (!result.ok) {
              status(result.error || 'Could not add files. Try again.');
              return;
            }
            const saved = await save({
              sharedFiles: [
                ...new Set([
                  ...(project.sharedFiles || []),
                  ...(result.paths || []),
                ]),
              ],
            });
            if (saved && root.isConnected) {
              paint();
            }
          })
          .catch(error => status(String(error)))
          .finally(() => {
            button.disabled = false;
          });
      } else if (key === 'remove-file') {
        const index = Number(button.dataset.fileIndex);
        void save({
          sharedFiles:
            project.sharedFiles?.filter((_, position) => position !== index) ||
            [],
        }).then(saved => {
          if (saved && root.isConnected) {
            paint();
          }
        });
      } else if (key === 'folder') {
        void options.data
          .openProjectPath(project.root, '')
          .then(result => {
            if (!result.ok) {
              status(result.error || 'Could not open folder.');
            }
          })
          .catch(error => status(String(error)));
      }
    });
    paint();
  }

  globalThis.ProjectWorkspace = {mount, create};
})();
