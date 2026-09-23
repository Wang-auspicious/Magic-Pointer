import path from 'node:path';

export interface WorkspaceCapabilityState {
  bound: boolean;
  codingTools: boolean;
  label: string;
}

export interface AttachmentDialogOptions {
  title: string;
  defaultPath?: string;
  properties: Array<'openFile' | 'openDirectory' | 'multiSelections'>;
}

export function resolveConversationWorkspace(
  explicitRoot: unknown,
  threadRoot: unknown,
): string | null {
  const explicit = String(explicitRoot ?? '').trim();
  if (explicit) return explicit;
  const existing = String(threadRoot ?? '').trim();
  return existing || null;
}

export function workspaceCapabilityState(root: unknown): WorkspaceCapabilityState {
  const value = String(root ?? '').trim();
  if (!value) {
    return {
      bound: false,
      codingTools: false,
      label: 'Select folder…',
    };
  }
  return {
    bound: true,
    codingTools: true,
    label: path.basename(path.normalize(value)) || value,
  };
}

export function attachmentDialogOptions(projectRoot: unknown, kind: 'files' | 'folder' = 'files'): AttachmentDialogOptions {
  const root = String(projectRoot ?? '').trim();
  return {
    title: kind === 'folder' ? '添加材料文件夹' : '添加任务材料',
    ...(root ? { defaultPath: root } : {}),
    properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'],
  };
}
