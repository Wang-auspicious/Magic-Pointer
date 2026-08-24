'use strict';

import fs from 'node:fs';
import path from 'node:path';

type ProjectEntryKind = 'directory' | 'file';

interface ProjectEntry {
  name: string;
  path: string;
  kind: ProjectEntryKind;
}

const HIDDEN_DIRECTORIES = new Set([
  '.git', '.idea', '.pytest_cache', '.ruff_cache', '.venv', '__pycache__',
  'build', 'coverage', 'dist', 'node_modules',
]);

function projectPath(root: string, relativePath = ''): string {
  const resolvedRoot = path.resolve(String(root || ''));
  const resolved = path.resolve(resolvedRoot, String(relativePath || ''));
  const relation = path.relative(resolvedRoot, resolved);
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error('invalid_project_path');
  }
  return resolved;
}

function portableRelative(root: string, absolutePath: string): string {
  return path.relative(path.resolve(root), absolutePath).split(path.sep).join('/');
}

function listProjectDirectory(root: string, relativePath = ''): ProjectEntry[] {
  const directory = projectPath(root, relativePath);
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => (entry.isDirectory() || entry.isFile())
      && !(entry.isDirectory() && HIDDEN_DIRECTORIES.has(entry.name)))
    .map((entry) => ({
      name: entry.name,
      path: portableRelative(root, path.join(directory, entry.name)),
      kind: entry.isDirectory() ? 'directory' as const : 'file' as const,
    }))
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' });
    });
}

function readProjectText(root: string, relativePath: string, maxBytes = 384 * 1024): {
  text: string;
  truncated: boolean;
} {
  const filePath = projectPath(root, relativePath);
  const data = fs.readFileSync(filePath);
  if (data.subarray(0, Math.min(data.length, 8192)).includes(0)) {
    throw new Error('binary_project_file');
  }
  const truncated = data.length > maxBytes;
  return {
    text: data.subarray(0, maxBytes).toString('utf8'),
    truncated,
  };
}

export { listProjectDirectory, projectPath, readProjectText };
export type { ProjectEntry };
