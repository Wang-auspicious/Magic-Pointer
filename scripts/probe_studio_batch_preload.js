// Probe-only preload: installs the fake dashboard bridge BEFORE page scripts
// run, so studio.ts boot() sees a project and renders the real tree path.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('magicPointerDashboard', {
  conversations: {
    list: async () => [],
    get: async () => undefined,
    send: async () => ({ ok: false, error: 'probe' }),
    pickWorkspace: async () => ({ ok: true, path: 'C:/probe' }),
    timeline: async () => [],
    memories: async () => [],
    artifacts: async () => [],
    stash: async () => [],
    models: async () => null,
    slashDirectory: async () => null,
    selectModel: async () => ({ ok: true }),
    onProgress: () => {},
    onTurn: () => {},
    onChange: () => {},
    export: async () => ({ ok: false }),
  },
  projects: {
    open: async () => ({ ok: true, project: { root: 'C:/probe', name: 'probe', lastOpenedAt: Date.now() } }),
    list: async () => [{ root: 'C:/probe', name: 'probe', lastOpenedAt: Date.now() }],
    tree: async () => ({
      ok: true,
      entries: [
        { name: 'src', path: 'src', kind: 'directory' },
        { name: 'package.json', path: 'package.json', kind: 'file' },
      ],
    }),
    readFile: async () => ({ ok: true, content: 'file body' }),
    openPath: async () => ({ ok: true }),
    openUrl: async () => ({ ok: true }),
  },
});