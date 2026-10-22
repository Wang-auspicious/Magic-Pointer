import path from 'node:path';
import type {ConversationModelSelection} from './conversation_model';
import type {PermissionPreset} from './permission_mode';

export interface ProjectRunEnvironment {
  id: string;
  name: string;
  modelSelection?: ConversationModelSelection;
  permissionPreset?: PermissionPreset;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  additionalFolders?: string[];
}

export interface ProjectDocument {
  id: string;
  name: string;
  path: string;
  size: number;
  addedAt: number;
}

export interface ProjectTextInput {
  title: string;
  content: string;
}

export type ProjectMaterialRef =
  {kind: 'document'; documentId: string} | {kind: 'linked'; path: string};

export function resolveProjectMaterial(
  project: ProjectContext | undefined,
  reference: ProjectMaterialRef,
): {name: string; path: string} {
  if (reference.kind === 'document') {
    const document = project?.documents?.find(
      item => item.id === reference.documentId,
    );
    if (document) {
      return {name: document.name, path: document.path};
    }
  } else if (reference.kind === 'linked') {
    const file = project?.sharedFiles?.find(
      item =>
        path.relative(path.resolve(item), path.resolve(reference.path)) === '',
    );
    if (file) {
      return {name: path.basename(file), path: file};
    }
  }
  throw new Error('This file is no longer part of the project.');
}

export interface ProjectContext {
  environments?: ProjectRunEnvironment[];
  defaultEnvironmentId?: string;
  resourceInbox?: Array<{id: string; title: string; summary: string; path: string}>;
  id?: string;
  root: string;
  name: string;
  description?: string;
  instructions?: string;
  sharedFiles?: string[];
  documents?: ProjectDocument[];
}

export interface ProjectDetailsPatch {
  environments?: ProjectRunEnvironment[];
  defaultEnvironmentId?: string;
  name?: string;
  description?: string;
  instructions?: string;
  sharedFiles?: string[];
  starred?: boolean;
  archived?: boolean;
}

export function projectAttachments(
  attachments: readonly string[],
  project?: ProjectContext | null,
): string[] {
  const files = new Map<string, string>();
  for (const file of [...attachments, ...(project?.sharedFiles || [])]) {
    const absolute = path.resolve(file);
    const key =
      process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (!files.has(key)) {
      files.set(key, absolute);
    }
  }
  return [...files.values()];
}
