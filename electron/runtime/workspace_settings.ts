import {isDeepStrictEqual} from 'node:util';
import {normalizeAdditionalFolders} from '../workspace_folders';
import type {AgentMessage} from './agent';
import type {EventSession} from './session';

export interface WorkspaceSettings {
  root: string;
  additionalFolders: string[];
}

export function savedWorkspaceSettings(
  session: EventSession,
): WorkspaceSettings | undefined {
  return [...session.events]
    .reverse()
    .find(event => event.type === 'workspace/settings')?.data.workspace as
    WorkspaceSettings | undefined;
}

export async function synchronizeWorkspaceSettings(
  session: EventSession,
  root: string | undefined,
  additionalFolders: readonly string[] | undefined,
): Promise<WorkspaceSettings | undefined> {
  const saved = savedWorkspaceSettings(session);
  if (root === undefined && additionalFolders === undefined) {
    return saved;
  }
  const workspace = root ?? saved?.root ?? '';
  const snapshot: WorkspaceSettings = {
    root: workspace,
    additionalFolders: workspace
      ? normalizeAdditionalFolders(
          workspace,
          additionalFolders ?? saved?.additionalFolders,
        )
      : [],
  };
  if (!isDeepStrictEqual(saved, snapshot)) {
    await session.append('workspace/settings', {workspace: snapshot});
  }
  return snapshot;
}

export function withWorkspaceSettings(
  messages: AgentMessage[],
  settings: WorkspaceSettings | undefined,
): AgentMessage[] {
  if (!settings) {
    return messages;
  }
  const content = [
    '[Workspace folders]',
    'Current session folders replace earlier folder settings. Relative file paths and the default command directory use the working folder. Use absolute paths for additional folders. Each folder keeps its own ignore rules. Tool permissions still apply.',
    JSON.stringify(settings),
    '[/Workspace folders]',
  ].join('\n');
  let index = messages.length;
  for (let position = messages.length - 1; position >= 0; position--) {
    const item = messages[position];
    if (item.role === 'user' && !item.injected && item.origin !== 'data') {
      index = position;
      break;
    }
  }
  return [
    ...messages.slice(0, index),
    {role: 'user', origin: 'instruction', injected: true, content},
    ...messages.slice(index),
  ];
}
