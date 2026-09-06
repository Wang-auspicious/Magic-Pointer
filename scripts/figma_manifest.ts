export interface FigmaPluginManifest {
  name: string;
  id: string;
  api: '1.0.0';
  main: 'code.js';
  ui: 'ui.html';
  editorType: ['figma'];
  documentAccess: 'dynamic-page';
  networkAccess: {
    allowedDomains: string[];
    devAllowedDomains: string[];
    reasoning: string;
  };
}

export function normalizePublishedPluginId(value: unknown): string | null {
  const candidate = String(value || '').trim();
  if (!candidate || candidate === '__FIGMA_PLUGIN_ID__') return null;
  if (!/^\d{8,32}$/.test(candidate)) {
    throw new Error('Figma plugin ID must be the numeric ID assigned by Figma Create New Plugin');
  }
  return candidate;
}

export function manifestForPlugin(pluginId: string, port: number): FigmaPluginManifest {
  const id = normalizePublishedPluginId(pluginId);
  if (!id) throw new Error('A genuine Figma-assigned plugin ID is required to create manifest.json');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Figma bridge port must be an integer from 1 to 65535');
  }
  const origin = `http://127.0.0.1:${port}`;
  return {
    name: 'Magic Pointer',
    id,
    api: '1.0.0',
    main: 'code.js',
    ui: 'ui.html',
    editorType: ['figma'],
    documentAccess: 'dynamic-page',
    networkAccess: {
      allowedDomains: [origin],
      devAllowedDomains: [origin],
      reasoning: 'Connects this explicitly opened plugin to the Magic Pointer loopback bridge on the same computer.',
    },
  };
}
