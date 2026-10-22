import {readFile} from 'node:fs/promises';

export async function readFileDiffPresentation(reference: {
  beforePath: string | null;
  afterPath: string;
}) {
  try {
    const beforeText = reference.beforePath
      ? await readFile(reference.beforePath, 'utf8')
      : '';
    const afterText = await readFile(reference.afterPath, 'utf8');
    return {
      ok: true as const,
      presentation: {kind: 'file_diff' as const, beforeText, afterText},
    };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
