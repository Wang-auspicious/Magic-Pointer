(() => {
  type StudioViewId =
    | 'chat'
    | 'resources'
    | 'design'
    | 'stash'
    | 'artifacts'
    | 'dashboard'
    | 'settings'
    | 'projects'
    | 'scheduled'
    | 'customize'
    | 'chats'
    | 'designs'
    | 'personal';

  interface StudioView {
    id: StudioViewId;
    title: string;
    description: string;
    eyebrow: string;
    allowsDetail: boolean;
  }

  // Shell copy is English by default; the locale layer owns any translation.
  const STUDIO_VIEWS: readonly StudioView[] = Object.freeze([
    Object.freeze({
      id: 'resources', title: 'Resources', description: 'A place for what you want to return to.', eyebrow: 'YOUR COLLECTION', allowsDetail: false,
    }),
    Object.freeze({
      id: 'personal',
      title: 'Review',
      description: 'Activity, file traces, and daily summaries.',
      eyebrow: 'PERSONAL MEMORY',
      allowsDetail: false,
    }),
    Object.freeze({
      id: 'chat',
      title: 'Chat',
      description: 'Continue working from what you just pointed at.',
      eyebrow: 'ACTIVE WORK',
      allowsDetail: true,
    }),
    Object.freeze({
      id: 'design',
      title: 'Design',
      description:
        'Start from project assets, visual canvases, and design outputs.',
      eyebrow: 'DESIGN WORKSPACE',
      allowsDetail: true,
    }),
    Object.freeze({
      id: 'stash',
      title: 'Stash',
      description: 'Organize locally saved screenshots, text, and quotes.',
      eyebrow: 'LOCAL STASH',
      allowsDetail: false,
    }),
    Object.freeze({
      id: 'artifacts',
      title: 'Artifacts',
      description: 'View, reuse, and export generated local artifacts.',
      eyebrow: 'LOCAL OUTPUTS',
      allowsDetail: true,
    }),
    Object.freeze({
      id: 'dashboard',
      title: 'Dashboards',
      description: 'Query-backed data panels that refresh on every open.',
      eyebrow: 'LIVE PANELS',
      allowsDetail: true,
    }),
    Object.freeze({
      id: 'settings',
      title: 'Settings',
      description: 'Control interaction, models, permissions, privacy, and appearance.',
      eyebrow: 'PREFERENCES',
      allowsDetail: false,
    }),
    Object.freeze({
      id: 'projects',
      title: 'Projects',
      description: 'Projects and conversations saved on this machine.',
      eyebrow: 'LOCAL PROJECTS',
      allowsDetail: false,
    }),
    Object.freeze({
      id: 'scheduled',
      title: 'Routines',
      description: 'Follow real materials daily and generate reports.',
      eyebrow: 'SCHEDULED WORK',
      allowsDetail: false,
    }),
    Object.freeze({
      id: 'customize',
      title: 'Customize',
      description: 'Skills, connections, and local harness plugins.',
      eyebrow: 'CUSTOMIZE',
      allowsDetail: false,
    }),
    Object.freeze({
      id: 'chats',
      title: 'Chats and tasks',
      description: 'View and organize all local conversations.',
      eyebrow: 'LOCAL TASKS',
      allowsDetail: false,
    }),
    Object.freeze({
      id: 'designs',
      title: 'Design',
      description: 'Design outputs, assets, and the design system.',
      eyebrow: 'DESIGN LIBRARY',
      allowsDetail: false,
    }),
  ]);

  const VIEW_BY_ID = new Map(STUDIO_VIEWS.map(view => [view.id, view]));

  function normalizeView(value: unknown): StudioViewId {
    const id = String(value || '')
      .trim()
      .toLowerCase() as StudioViewId;
    return VIEW_BY_ID.has(id) ? id : 'chat';
  }

  // Claude truncates window titles to 80 code points (report/20 §2.4).
  const TITLE_MAX_CODEPOINTS = 80;
  function truncateTitle(title: string): string {
    const points = Array.from(String(title));
    return points.length > TITLE_MAX_CODEPOINTS
      ? points.slice(0, TITLE_MAX_CODEPOINTS).join('') + '…'
      : String(title);
  }

  function shellState(value: unknown) {
    const activeView = normalizeView(value);
    const view = VIEW_BY_ID.get(activeView)!;
    return Object.freeze({
      activeView,
      title: truncateTitle(view.title),
      description: view.description,
      eyebrow: view.eyebrow,
      allowsDetail: view.allowsDetail,
    });
  }

  const StudioShell = {
    STUDIO_VIEWS,
    normalizeView,
    shellState,
    truncateTitle,
    TITLE_MAX_CODEPOINTS,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = StudioShell;
  }
  if (typeof globalThis !== 'undefined') {
    (
      globalThis as typeof globalThis & {StudioShell?: typeof StudioShell}
    ).StudioShell = StudioShell;
  }
})();
