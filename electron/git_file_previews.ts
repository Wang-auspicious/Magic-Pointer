import {execFile} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {promisify} from 'node:util';
import {projectPath} from './project_inspector';

const executeFile = promisify(execFile);
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;

export class GitFilePreviews {
  private directory: string | null = null;
  private readonly parent: string;
  private readonly pending = new Map<string, Promise<void>>();

  constructor(parent: string) {
    this.parent = path.resolve(parent);
  }

  async prepare(
    root: string,
    relativePath: string,
    base: 'head' | 'index',
  ): Promise<string> {
    const file = projectPath(root, relativePath);
    const relative = path.relative(root, file).replaceAll('\\', '/');
    const revision = `${base === 'head' ? 'HEAD' : ''}:./${relative}`;
    const resolved = await executeFile(
      'git',
      ['rev-parse', '--verify', revision],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      },
    );
    // Git's existing blob identity lets repeat clicks skip reading/writing its bytes.
    const objectId = resolved.stdout.trim();
    if (!this.directory) {
      fs.mkdirSync(this.parent, {recursive: true});
      this.directory = fs.mkdtempSync(path.join(this.parent, 'git-files-'));
    }
    const snapshot = path.join(this.directory, objectId + path.extname(file));
    let ready = this.pending.get(snapshot);
    if (!ready) {
      ready = (async () => {
        if (fs.existsSync(snapshot)) {
          return;
        }
        const {stdout} = await executeFile(
          'git',
          ['cat-file', 'blob', objectId],
          {
            cwd: root,
            encoding: 'buffer',
            windowsHide: true,
            timeout: 10000,
            maxBuffer: MAX_PREVIEW_BYTES,
          },
        );
        try {
          await fs.promises.writeFile(snapshot, stdout);
        } catch (error) {
          await fs.promises.rm(snapshot, {force: true});
          throw error;
        }
      })();
      this.pending.set(snapshot, ready);
    }
    try {
      await ready;
    } finally {
      this.pending.delete(snapshot);
    }
    return snapshot;
  }

  dispose(): void {
    const directory = this.directory;
    if (!directory) {
      return;
    }
    if (path.dirname(path.resolve(directory)) !== this.parent) {
      throw new Error(
        'Git preview directory is outside its owned cache folder',
      );
    }
    fs.rmSync(directory, {recursive: true, force: true});
    this.directory = null;
  }
}
