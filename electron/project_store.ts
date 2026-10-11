import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {ProjectContext, ProjectDetailsPatch} from './project_context';

export interface ProjectRecord extends ProjectContext {
  id: string;
  addedAt: number;
  lastOpenedAt: number;
  updatedAt?: number;
  starred?: boolean;
  archived?: boolean;
}

export interface ProjectCreateInput {
  name: string;
  description?: string;
}

export type ProjectMutationResult =
  {ok: true; project: ProjectRecord} | {ok: false; error: string};

interface ProjectImportSource {
  workspaceRoot?: string;
  projectId?: string;
  createdAt: number;
  updatedAt: number;
}

function folderKey(root: string): string {
  if (!root.trim()) {
    return '';
  }
  const normalized = path.resolve(root).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function copy(project: ProjectRecord): ProjectRecord {
  return {...project, sharedFiles: [...(project.sharedFiles || [])]};
}

export function createProjectStore({
  baseDir,
  now = Date.now,
}: {
  baseDir: string;
  now?: () => number;
}) {
  const file = path.join(baseDir, 'projects.json');
  const worktrees = path.resolve(path.dirname(baseDir), 'worktrees');
  let items: ProjectRecord[] | undefined;

  function persist(next: ProjectRecord[]): void {
    fs.mkdirSync(baseDir, {recursive: true});
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(next), 'utf8');
    fs.renameSync(`${file}.tmp`, file);
    items = next;
  }

  function load(): ProjectRecord[] {
    if (items) {
      return items;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      items = [];
      return items;
    }
    if (!Array.isArray(parsed)) {
      throw new Error('The project store must contain a project list.');
    }
    const records = parsed as ProjectRecord[];
    const needsIds = records.some(project => !project.id);
    const next = records.map(project => ({
      ...project,
      id: project.id || randomUUID(),
      root: project.root || '',
    }));
    if (needsIds) {
      persist(next);
    } else {
      items = next;
    }
    return next;
  }

  function isManagedWorktree(root: string): boolean {
    const relative = path.relative(worktrees, path.resolve(root));
    return Boolean(
      relative &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    );
  }

  function find(key: string): ProjectRecord | undefined {
    if (!key.trim()) {
      return undefined;
    }
    const records = load();
    return (
      records.find(project => project.id === key) ||
      records.find(
        project => project.root && folderKey(project.root) === folderKey(key),
      )
    );
  }

  function get(key: string): ProjectRecord | undefined {
    const project = find(key);
    return project ? copy(project) : undefined;
  }

  function create(input: ProjectCreateInput): ProjectMutationResult {
    const name = input.name.trim();
    if (!name) {
      return {ok: false, error: 'Enter a project name.'};
    }
    const timestamp = now();
    const project: ProjectRecord = {
      id: randomUUID(),
      root: '',
      name,
      description: input.description?.trim(),
      addedAt: timestamp,
      lastOpenedAt: timestamp,
    };
    try {
      persist([project, ...load()]);
      return {ok: true, project: copy(project)};
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : 'Could not create project.',
      };
    }
  }

  function register(rawRoot: unknown): ProjectRecord | null {
    const root = String(rawRoot || '').trim();
    if (!root || isManagedWorktree(root)) {
      return null;
    }
    const records = load();
    const existing = records.find(
      project => project.root && folderKey(project.root) === folderKey(root),
    );
    const openedAt = now();
    const project: ProjectRecord = existing
      ? {...existing, lastOpenedAt: openedAt}
      : {
          id: randomUUID(),
          root,
          name: path.basename(path.normalize(root)) || root,
          addedAt: openedAt,
          lastOpenedAt: openedAt,
        };
    persist(
      existing
        ? records.map(row => (row.id === project.id ? project : row))
        : [project, ...records],
    );
    return copy(project);
  }

  function list(sources: readonly ProjectImportSource[] = []): ProjectRecord[] {
    const records = load();
    const known = new Set(
      records.map(project => folderKey(project.root)).filter(Boolean),
    );
    const added: ProjectRecord[] = [];
    for (const source of sources) {
      const root = source.workspaceRoot?.trim();
      if (
        !root ||
        source.projectId !== undefined ||
        known.has(folderKey(root)) ||
        isManagedWorktree(root)
      ) {
        continue;
      }
      added.push({
        id: randomUUID(),
        root,
        name: path.basename(path.normalize(root)) || root,
        addedAt: source.createdAt,
        lastOpenedAt: source.updatedAt,
      });
      known.add(folderKey(root));
    }
    const next = [...records, ...added];
    if (added.length) {
      persist(next);
    }
    return next
      .filter(project => !project.root || !isManagedWorktree(project.root))
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
      .map(copy);
  }

  function update(
    key: string,
    patch: ProjectDetailsPatch,
  ): ProjectMutationResult {
    const previous = find(key);
    if (!previous) {
      return {ok: false, error: 'Project not found.'};
    }
    if (patch.name !== undefined && !patch.name.trim()) {
      return {ok: false, error: 'Enter a project name.'};
    }
    const next = {...previous, updatedAt: now()};
    for (const field of ['name', 'description', 'instructions'] as const) {
      if (patch[field] !== undefined) {
        next[field] = patch[field].trim();
      }
    }
    if (patch.sharedFiles !== undefined) {
      next.sharedFiles = [
        ...new Set(patch.sharedFiles.map(file => path.resolve(file))),
      ];
    }
    if (patch.starred !== undefined) {
      next.starred = patch.starred;
    }
    if (patch.archived !== undefined) {
      next.archived = patch.archived;
    }
    try {
      persist(load().map(project => (project.id === next.id ? next : project)));
      return {ok: true, project: copy(next)};
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : 'Could not save project.',
      };
    }
  }

  return {create, get, list, register, update};
}
