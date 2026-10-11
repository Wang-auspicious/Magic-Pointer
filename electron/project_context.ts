import path from 'node:path';

export interface ProjectContext {
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

export function projectTurnInstruction(
  instruction: string,
  project?: ProjectContext | null,
): string {
  if (!instruction || !project?.instructions?.trim()) {
    return instruction;
  }
  return [
    `User-saved project instructions for this turn (${project.name}):`,
    project.instructions.trim(),
    '',
    'These are the current project instructions, superseding earlier project settings. The current request takes precedence. Tool permissions and source access are unchanged.',
    '',
    'Current request:',
    instruction,
  ].join('\n');
}
