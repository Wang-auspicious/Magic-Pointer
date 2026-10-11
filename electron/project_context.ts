import path from 'node:path';

export interface ProjectContext {
  id?: string;
  root: string;
  name: string;
  description?: string;
  instructions?: string;
  sharedFiles?: string[];
}

export interface ProjectDetailsPatch {
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
