'use strict';

import path from 'node:path';

type ProjectContextKind = 'directory' | 'file';

const BROWSER_PROJECT_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.htm', '.html', '.jpeg', '.jpg', '.pdf', '.png', '.svg', '.webp', '.xml',
]);

function normalizeBrowserUrl(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('invalid_browser_url');
  const withScheme = /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch (_) {
    throw new Error('invalid_browser_url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('invalid_browser_url');
  }
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

function isBrowserOpenableProjectPath(relativePath: string): boolean {
  return BROWSER_PROJECT_EXTENSIONS.has(path.extname(String(relativePath || '')).toLowerCase());
}

function projectContextActions(kind: ProjectContextKind, relativePath: string): string[] {
  if (kind === 'directory') return ['open', 'reveal', 'terminal-here', 'copy-path'];
  return [
    'preview',
    'open',
    'reveal',
    ...(isBrowserOpenableProjectPath(relativePath) ? ['open-in-browser'] : []),
    'copy-path',
  ];
}

export { isBrowserOpenableProjectPath, normalizeBrowserUrl, projectContextActions };
export type { ProjectContextKind };
