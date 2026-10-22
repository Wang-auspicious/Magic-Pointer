import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {normalizeModelSelection} from './conversation_model';
import {normalizePermissionPreset} from './permission_mode';
import type {
  ProjectContext,
  ProjectDetailsPatch,
  ProjectDocument,
  ProjectTextInput,
} from './project_context';

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
  return {
    ...project,
    ...(project.environments
      ? {environments: structuredClone(project.environments)}
      : {}),
    sharedFiles: [...(project.sharedFiles || [])],
    documents: (project.documents || []).map(document => ({...document})),
  };
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
      if (patch.environments !== undefined) {
        const environments = structuredClone(patch.environments);
        const ids = new Set<string>();
        for (const environment of environments) {
          if (!environment.id || ids.has(environment.id)) {
            throw new Error('Environment IDs must be unique.');
          }
          ids.add(environment.id);
          if (!environment.name.trim()) {
            throw new Error('Enter an environment name.');
          }
          environment.name = environment.name.trim();
          if (environment.branch !== undefined) {
            environment.branch = environment.branch.trim();
          }
          if (environment.modelSelection !== undefined) {
            environment.modelSelection = normalizeModelSelection(
              environment.modelSelection,
            );
          }
          if (environment.permissionPreset !== undefined) {
            environment.permissionPreset = normalizePermissionPreset(
              environment.permissionPreset,
            );
          }
          if (
            environment.effort !== undefined &&
            !['low', 'medium', 'high', 'xhigh', 'max'].includes(environment.effort)
          ) {
            throw new Error('Unknown reasoning effort.');
          }
        }
        next.environments = environments;
      }
      if (patch.defaultEnvironmentId !== undefined) {
        next.defaultEnvironmentId = patch.defaultEnvironmentId;
      }
      if (
        next.defaultEnvironmentId &&
        !next.environments?.some(item => item.id === next.defaultEnvironmentId)
      ) {
        throw new Error('Choose a saved default environment.');
      }
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

  async function addDocuments(
    key: string,
    sourcePaths: readonly string[],
  ): Promise<ProjectMutationResult> {
    const project = find(key);
    if (!project) {
      return {ok: false, error: 'Project not found.'};
    }
    const documents: ProjectDocument[] = [];
    try {
      for (const sourcePath of new Set(sourcePaths)) {
        const source = path.resolve(sourcePath);
        const info = await fs.promises.stat(source);
        if (!info.isFile()) {
          throw new Error(`Choose a file: ${sourcePath}`);
        }
        const id = randomUUID();
        const name = path.basename(source);
        const destination = path.join(
          baseDir,
          'project-documents',
          project.id,
          id,
          name,
        );
        await fs.promises.mkdir(path.dirname(destination), {recursive: true});
        await fs.promises.copyFile(source, destination);
        const saved = await fs.promises.stat(destination);
        documents.push({
          id,
          name,
          path: path.resolve(destination),
          size: saved.size,
          addedAt: now(),
        });
      }
      const current = find(project.id)!;
      const next = {
        ...current,
        documents: [...(current.documents || []), ...documents],
        updatedAt: now(),
      };
      persist(load().map(row => (row.id === next.id ? next : row)));
      return {ok: true, project: copy(next)};
    } catch (error) {
      await Promise.allSettled(
        documents.map(document => fs.promises.unlink(document.path)),
      );
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'Could not add project files.',
      };
    }
  }

  function removeDocument(
    key: string,
    documentId: string,
  ): ProjectMutationResult {
    const project = find(key);
    if (
      !project ||
      !project.documents?.some(document => document.id === documentId)
    ) {
      return {ok: false, error: 'Project file not found.'};
    }
    const next = {
      ...project,
      documents: project.documents.filter(
        document => document.id !== documentId,
      ),
      updatedAt: now(),
    };
    try {
      // Conversations retain source evidence after its project membership ends.
      persist(load().map(row => (row.id === next.id ? next : row)));
      return {ok: true, project: copy(next)};
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : 'Could not remove project file.',
      };
    }
  }

  async function addTextDocument(
    key: string,
    input: ProjectTextInput,
  ): Promise<ProjectMutationResult> {
    const project = find(key);
    if (!project) {
      return {ok: false, error: 'Project not found.'};
    }
    if (!input.title.trim() || !input.content.trim()) {
      return {ok: false, error: 'Enter a title and content.'};
    }
    const id = randomUUID();
    const destination = path.resolve(
      baseDir,
      'project-documents',
      project.id,
      id,
      'content.txt',
    );
    try {
      await fs.promises.mkdir(path.dirname(destination), {recursive: true});
      await fs.promises.writeFile(destination, input.content, 'utf8');
      const document: ProjectDocument = {
        id,
        name: input.title,
        path: destination,
        size: Buffer.byteLength(input.content, 'utf8'),
        addedAt: now(),
      };
      const current = find(project.id)!;
      const next = {
        ...current,
        documents: [...(current.documents || []), document],
        updatedAt: now(),
      };
      persist(load().map(row => (row.id === next.id ? next : row)));
      return {ok: true, project: copy(next)};
    } catch (error) {
      await fs.promises.unlink(destination).catch(() => {});
      return {
        ok: false,
        error:
          error instanceof Error ? error.message : 'Error saving text content.',
      };
    }
  }

  return {
    create,
    get,
    list,
    register,
    update,
    addDocuments,
    removeDocument,
    addTextDocument,
  };
}
