declare global {
  type StudioLocation =
    | {kind: 'view'; view: string}
    | {kind: 'project'; id: string}
    | {kind: 'conversation'; id: string}
    | {kind: 'draft'; id: string};

  type StudioComposerLocation = Extract<
    StudioLocation,
    {kind: 'conversation' | 'draft'}
  >;

  interface StudioComposerDraft {
    text: string;
    attachments: string[];
    sourceIds: string[];
    workspaceRoot: string;
    additionalFolders?: string[];
    returnToProject?: string;
    modelSelection?: MagicPointerModelSelection;
    projectId?: string;
  }

  interface StudioNavigationController {
    state(): {
      current: StudioLocation | null;
      canBack: boolean;
      canForward: boolean;
    };
    visit(location: StudioLocation): void;
    replace(location: StudioLocation): void;
    move(delta: -1 | 1): StudioLocation | null;
    isCurrent(location: StudioLocation): boolean;
    retarget(from: StudioLocation, to: StudioLocation): void;
    saveDraft(location: StudioLocation, draft: StudioComposerDraft): void;
    draft(location: StudioLocation): StudioComposerDraft | undefined;
    clearDraft(location: StudioLocation): void;
  }

  var StudioNavigation: {create(): StudioNavigationController};
}

(() => {
  function key(location: StudioLocation): string {
    return `${location.kind}:${location.kind === 'view' ? location.view : location.id}`;
  }

  function copyDraft(draft: StudioComposerDraft): StudioComposerDraft {
    return {
      ...draft,
      attachments: [...draft.attachments],
      sourceIds: [...draft.sourceIds],
      additionalFolders: [...(draft.additionalFolders || [])],
      modelSelection: draft.modelSelection
        ? {...draft.modelSelection}
        : undefined,
    };
  }

  function create(): StudioNavigationController {
    const entries: StudioLocation[] = [];
    const drafts = new Map<string, StudioComposerDraft>();
    let index = -1;
    const isCurrent = (location: StudioLocation) =>
      index >= 0 && key(entries[index]) === key(location);
    const api: StudioNavigationController = {
      state: () => ({
        current: index >= 0 ? {...entries[index]} : null,
        canBack: index > 0,
        canForward: index >= 0 && index < entries.length - 1,
      }),
      visit(location) {
        if (isCurrent(location)) {
          return;
        }
        entries.splice(index + 1);
        entries.push({...location});
        index = entries.length - 1;
      },
      replace(location) {
        if (index < 0) {
          api.visit(location);
        } else {
          entries[index] = {...location};
          if (index > 0 && key(entries[index - 1]) === key(location)) {
            entries.splice(index, 1);
            index -= 1;
          }
        }
      },
      move(delta) {
        const next = index + delta;
        if (next < 0 || next >= entries.length) {
          return null;
        }
        index = next;
        return {...entries[index]};
      },
      isCurrent,
      retarget(from, to) {
        const before = key(from);
        if (before === key(to)) {
          return;
        }
        for (let position = 0; position < entries.length; position++) {
          if (key(entries[position]) === before) {
            entries[position] = {...to};
          }
        }
        const draft = drafts.get(before);
        if (draft && !drafts.has(key(to))) {
          drafts.set(key(to), copyDraft(draft));
        }
        drafts.delete(before);
      },
      saveDraft(location, draft) {
        drafts.set(key(location), copyDraft(draft));
      },
      draft(location) {
        const draft = drafts.get(key(location));
        return draft ? copyDraft(draft) : undefined;
      },
      clearDraft(location) {
        drafts.delete(key(location));
      },
    };
    return api;
  }

  const api = {create};
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalThis.StudioNavigation = api;
})();
