import path from 'node:path';
import {stat} from 'node:fs/promises';

export function normalizeAdditionalFolders(
  workspace: string,
  value: unknown,
): string[] {
  const key = (folder: string) =>
    process.platform === 'win32' ? folder.toLowerCase() : folder;
  const seen = new Set(workspace ? [key(path.resolve(workspace))] : []);
  const folders: string[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== 'string' || !item.trim()) {
      continue;
    }
    const folder = path.resolve(workspace, item.trim());
    if (!seen.has(key(folder))) {
      seen.add(key(folder));
      folders.push(folder);
    }
  }
  return folders;
}

export async function validateAdditionalFolders(
  workspace: string,
  value: unknown,
): Promise<string[]> {
  const folders = normalizeAdditionalFolders(workspace, value);
  if (folders.length && !workspace) {
    throw new Error('Select a working folder before adding other folders.');
  }
  for (const folder of folders) {
    const directory = await stat(folder).then(
      info => info.isDirectory(),
      () => false,
    );
    if (!directory) {
      throw new Error(`Additional folder is unavailable: ${folder}`);
    }
  }
  return folders;
}
