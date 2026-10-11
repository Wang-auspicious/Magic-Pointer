import {isDeepStrictEqual} from 'node:util';
import {extname} from 'node:path';
import {stat} from 'node:fs/promises';
import type {ProjectContext} from '../project_context';
import {
  fileSource,
  registerSource,
  scopeFromEvents,
  taskSources,
  updateContext,
  SourceReaderRegistry,
  registerContextTools,
  type ContextSessionLike,
  type ScopeGrant,
} from './context';
import {DocumentReader} from './context_documents';
import type {ToolRegistry} from './tools';

export function savedProjectContext(
  session: ContextSessionLike,
): ProjectContext | null | undefined {
  const knowledge = [...session.events]
    .reverse()
    .find(event => event.type === 'project/knowledge')?.data.project as
    ProjectContext | null | undefined;
  const settings = [...session.events]
    .reverse()
    .find(event => event.type === 'project/settings')?.data.project as
    ProjectContext | null | undefined;
  if (knowledge === null || settings === null) {
    return null;
  }
  return knowledge
    ? {...knowledge, instructions: settings?.instructions}
    : settings;
}

export async function registerProjectKnowledgeTools(
  registry: ToolRegistry,
  session: ContextSessionLike,
  project: ProjectContext | null | undefined,
): Promise<void> {
  await synchronizeProjectKnowledge(session, project);
  const readers = new SourceReaderRegistry();
  readers.register(
    source => ['file', 'document'].includes(source.kind),
    new DocumentReader(),
  );
  registerContextTools(registry, session, readers);
}

export async function synchronizeProjectKnowledge(
  session: ContextSessionLike,
  project: ProjectContext | null | undefined,
): Promise<void> {
  const previous = [...session.events]
    .reverse()
    .find(event => event.type === 'project/knowledge');
  const saved = previous?.data.project as ProjectContext | null | undefined;
  const snapshot =
    project === undefined
      ? saved
      : project && {
          id: project.id,
          root: project.root,
          name: project.name,
          documents: project.documents || [],
        };
  if (snapshot === undefined) {
    return;
  }
  const sourceIds: string[] = [];
  const known = new Map(
    taskSources(session.events).map(source => [source.sourceId, source]),
  );
  for (const document of snapshot?.documents || []) {
    const info = await stat(document.path);
    const source = fileSource(session.id, document.path);
    source.sourceId = `source:project:${snapshot!.id}:${document.id}`;
    source.title = document.name;
    source.kind = ['.pdf', '.docx', '.pptx', '.xlsx'].includes(
      extname(document.name).toLowerCase(),
    )
      ? 'document'
      : 'file';
    source.origin = 'project';
    source.capabilities = ['read', 'search'];
    source.identity = {
      ...source.identity,
      projectId: snapshot!.id,
      projectDocumentId: document.id,
      projectUri: `project://${document.id}`,
      projectFileName: document.name,
    };
    source.revision = {
      mtimeMs: info.mtimeMs,
      size: info.size,
      authority: 'disk',
    };
    if (!isDeepStrictEqual(known.get(source.sourceId), source)) {
      await registerSource(session, source);
    }
    sourceIds.push(source.sourceId);
  }
  const grant: ScopeGrant = {
    grantId: 'project-knowledge',
    taskId: session.id,
    sourceIds,
    actions: ['read'],
    folderRoots: [],
    windowIds: [],
    recipients: [],
    expiresAtMs: null,
  };
  const current = scopeFromEvents(session.events, session.id).grants.find(
    item => item.grantId === grant.grantId,
  );
  if ((current || sourceIds.length) && !isDeepStrictEqual(current, grant)) {
    await updateContext(session, {scopeGrants: [grant]});
  }
  if (!isDeepStrictEqual(saved, snapshot)) {
    await session.append('project/knowledge', {project: snapshot});
  }
}
