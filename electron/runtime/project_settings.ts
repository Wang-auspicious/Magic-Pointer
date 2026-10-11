import {isDeepStrictEqual} from 'node:util';
import type {ProjectContext} from '../project_context';
import type {AgentMessage} from './agent';
import type {EventSession} from './session';

export interface ProjectSettings {
  id?: string;
  root: string;
  name: string;
  instructions: string;
}

export type ActiveProjectSettings = ProjectSettings | null | undefined;

export async function synchronizeProjectSettings(
  session: EventSession,
  project: ProjectContext | null | undefined,
): Promise<ActiveProjectSettings> {
  const previous = [...session.events]
    .reverse()
    .find(event => event.type === 'project/settings');
  const saved = previous?.data.project as ProjectSettings | null | undefined;
  if (project === undefined) {
    return saved;
  }
  const snapshot: ProjectSettings | null =
    project === null
      ? null
      : {
          ...(project.id ? {id: project.id} : {}),
          root: project.root,
          name: project.name,
          instructions: project.instructions?.trim() || '',
        };
  if (!previous || !isDeepStrictEqual(saved, snapshot)) {
    await session.append('project/settings', {project: snapshot});
  }
  return snapshot;
}

export function withProjectSettings(
  messages: AgentMessage[],
  settings: ActiveProjectSettings,
): AgentMessage[] {
  if (settings === undefined) {
    return messages;
  }
  const content = [
    '[Project settings]',
    'These are the current user-saved project settings, replacing earlier project settings. The current request takes precedence. Tool permissions and source access are unchanged.',
    settings
      ? `Project: ${JSON.stringify({id: settings.id, name: settings.name})}`
      : 'No project is selected.',
    settings?.instructions ||
      'No project instructions are set. Earlier project instructions no longer apply.',
    '[/Project settings]',
  ].join('\n');
  const message: AgentMessage = {
    role: 'user',
    origin: 'instruction',
    injected: true,
    content,
  };
  let index = messages.length;
  for (let position = messages.length - 1; position >= 0; position--) {
    const item = messages[position];
    if (item.role === 'user' && !item.injected && item.origin !== 'data') {
      index = position;
      break;
    }
  }
  return [...messages.slice(0, index), message, ...messages.slice(index)];
}
