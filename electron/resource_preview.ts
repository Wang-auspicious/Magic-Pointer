import {stat} from 'node:fs/promises';
import {basename, dirname, extname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readProjectPreview, type ProjectFilePreview} from './project_inspector';
import type {CollectedResource} from './resource_collection_contract';

export type ResourcePreview =
  | ProjectFilePreview
  | {
      kind: 'video';
      url: string;
      name: string;
      truncated: false;
    }
  | {
      kind: 'audio';
      url: string;
      name: string;
      truncated: false;
    };

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.avif',
  '.ico',
  '.svg',
]);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);
const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.aac',
  '.flac',
  '.opus',
]);

export function resourceThumbnailUrl(
  baseDir: string,
  item: CollectedResource,
): string | undefined {
  return IMAGE_EXTENSIONS.has(extname(item.relPath).toLowerCase())
    ? pathToFileURL(resolve(baseDir, item.relPath)).href
    : undefined;
}

export async function readResourcePreview(
  filePath: string,
): Promise<ResourcePreview> {
  const extension = extname(filePath).toLowerCase();
  if (VIDEO_EXTENSIONS.has(extension) || AUDIO_EXTENSIONS.has(extension)) {
    if (!(await stat(filePath)).isFile()) {
      throw new Error('Choose a file to preview.');
    }
    return {
      kind: VIDEO_EXTENSIONS.has(extension) ? 'video' : 'audio',
      url: pathToFileURL(filePath).href,
      name: basename(filePath),
      truncated: false,
    };
  }
  return readProjectPreview(dirname(filePath), basename(filePath));
}
