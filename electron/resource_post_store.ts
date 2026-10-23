import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {join, relative, resolve, sep} from 'node:path';
import {Readable, Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {projectPath} from './project_inspector';
import type {PostMedia, ResourcePost} from './resource_post';

export function removeResourcePost(folder: string, resourceId: string): void {
  const root = resolve(folder, 'posts');
  const directory = resolve(root, resourceId);
  if (!directory.startsWith(root + sep)) {
    throw new Error('Invalid post directory.');
  }
  rmSync(directory, {recursive: true, force: true});
}

export class ResourcePostStore {
  constructor(
    private readonly folder: string,
    private readonly fetchAsset: (
      url: string,
      init?: RequestInit,
    ) => Promise<Response>,
  ) {}

  read(path: string): ResourcePost {
    return JSON.parse(
      readFileSync(projectPath(this.folder, path), 'utf8'),
    ) as ResourcePost;
  }

  async save(
    resourceId: string,
    post: ResourcePost,
    onRetained?: (saved: {path: string; textPath: string}) => void,
  ): Promise<{path: string; textPath: string; post: ResourcePost}> {
    const directory = projectPath(this.folder, join('posts', resourceId));
    mkdirSync(directory, {recursive: true});
    const file = join(directory, 'post.json');
    const textFile = join(directory, 'original.txt');
    const persist = () => {
      writeFileSync(file + '.tmp', JSON.stringify(post), 'utf8');
      renameSync(file + '.tmp', file);
    };
    persist();
    writeFileSync(
      textFile,
      [
        post.title,
        post.author.name,
        post.url,
        post.text,
        ...post.links,
        `Capture coverage: ${post.coverage}`,
      ].join('\n\n'),
      'utf8',
    );
    onRetained?.({
      path: relative(this.folder, file),
      textPath: relative(this.folder, textFile),
    });
    for (const [index, media] of post.media.entries()) {
      if (
        media.localPath &&
        existsSync(projectPath(this.folder, media.localPath))
      ) {
        continue;
      }
      try {
        await this.download(media, directory, index);
        delete media.error;
      } catch (error) {
        media.error = error instanceof Error ? error.message : String(error);
        delete media.localPath;
      }
      persist();
    }
    return {
      path: relative(this.folder, file),
      textPath: relative(this.folder, textFile),
      post,
    };
  }

  private async download(
    media: PostMedia,
    directory: string,
    index: number,
  ): Promise<void> {
    const response = await this.fetchAsset(media.url, {
      signal: AbortSignal.timeout(media.kind === 'video' ? 180000 : 30000),
    });
    if (!response.ok) {
      throw new Error(`Media download HTTP ${response.status}.`);
    }
    const mime = (response.headers.get('content-type') || '')
      .split(';')[0]
      .toLowerCase();
    if (
      !response.body ||
      !(
        mime.startsWith(media.kind + '/') || mime === 'application/octet-stream'
      )
    ) {
      throw new Error(`Unexpected media content type: ${mime || 'missing'}.`);
    }
    const extensions: Record<string, string> = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'image/avif': '.avif',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'audio/mpeg': '.mp3',
    };
    const extension =
      extensions[mime] ||
      (media.kind === 'video'
        ? '.mp4'
        : media.kind === 'audio'
          ? '.mp3'
          : '.jpg');
    const file = join(directory, `${index + 1}${extension}`);
    let bytes = 0;
    const limit = (media.kind === 'video' ? 512 : 64) * 1024 * 1024;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(
          bytes > limit
            ? new Error(
                `Media exceeds the ${limit / 1024 / 1024} MiB local download limit.`,
              )
            : null,
          chunk,
        );
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(
          response.body as import('node:stream/web').ReadableStream,
        ),
        meter,
        createWriteStream(file + '.part'),
      );
      renameSync(file + '.part', file);
    } catch (error) {
      rmSync(file + '.part', {force: true});
      throw error;
    }
    media.localPath = relative(this.folder, file);
    media.bytes = bytes;
  }
}
