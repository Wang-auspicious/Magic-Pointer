'use strict';

import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

type ProjectContextKind = 'directory' | 'file';

const BROWSER_PROJECT_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.htm',
  '.html',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.svg',
  '.webp',
  '.xml',
]);

function normalizeBrowserUrl(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) {
    throw new Error('invalid_browser_url');
  }
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
  return BROWSER_PROJECT_EXTENSIONS.has(
    path.extname(String(relativePath || '')).toLowerCase(),
  );
}

function projectBrowserFileUrl(root: string, relativePath: string): string {
  if (!String(root || '').trim()) {
    throw new Error('invalid_project_root');
  }
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, relativePath);
  const relation = path.relative(absoluteRoot, absolutePath);
  if (
    relation === '..' ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new Error('invalid_project_path');
  }
  return pathToFileURL(absolutePath).href;
}

function normalizeProjectBrowserUrl(value: string, root: string): string {
  const raw = String(value || '').trim();
  if (raw.startsWith('file:')) {
    return projectBrowserFileUrl(root, fileURLToPath(raw));
  }
  if (
    /^[a-zA-Z]:[\\/]/.test(raw) ||
    raw.startsWith('.') ||
    raw.startsWith('\\\\')
  ) {
    return projectBrowserFileUrl(root, raw);
  }
  return normalizeBrowserUrl(raw);
}

function isProjectBrowserNavigationAllowed(
  value: string,
  root: string,
): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return true;
    }
    if (url.protocol !== 'file:') {
      return false;
    }
    projectBrowserFileUrl(root, fileURLToPath(url));
    return true;
  } catch {
    return false;
  }
}

function projectContextActions(
  kind: ProjectContextKind,
  relativePath: string,
): string[] {
  if (kind === 'directory') {
    return ['open', 'reveal', 'terminal-here', 'copy-path'];
  }
  return [
    'preview',
    'open',
    'reveal',
    ...(isBrowserOpenableProjectPath(relativePath) ? ['open-in-browser'] : []),
    'copy-path',
  ];
}

export {
  isBrowserOpenableProjectPath,
  isProjectBrowserNavigationAllowed,
  normalizeBrowserUrl,
  normalizeProjectBrowserUrl,
  projectBrowserFileUrl,
  projectContextActions,
};
export type {ProjectContextKind};
