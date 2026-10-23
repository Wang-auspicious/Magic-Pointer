import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

export interface BookmarkAccount {
  account: string;
  userId: string;
  name: string;
  enabled: boolean;
  lastCheckedAt: number;
  nextCheckAt: number;
  error: string;
}
interface BookmarkSyncOptions {
  folder: string;
  readAccount(account: string): Promise<{id: string; name: string} | null>;
  sync(account: string): Promise<void>;
  now?(): number;
  needsInitialization?(account: string): boolean;
}

/** Account sign-in starts history import; the next check is durable across restarts. */
export class ResourceBookmarkSync {
  private readonly file: string;
  private readonly accounts: BookmarkAccount[];
  private readonly running = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly options: BookmarkSyncOptions) {
    this.file = join(options.folder, 'resource-bookmark-sync.json');
    this.accounts = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, 'utf8'))
      : [];
  }

  snapshot(): BookmarkAccount[] {
    return this.accounts.map(account => ({...account}));
  }

  configure(account: string, enabled: boolean): void {
    const saved = this.accounts.find(item => item.account === account);
    if (saved) {
      saved.enabled = enabled;
      if (enabled) {
        saved.nextCheckAt = 0;
      }
      this.persist();
      this.schedule();
    }
  }

  async observe(
    account: string,
    identity: {id: string; name: string},
  ): Promise<void> {
    let saved = this.accounts.find(item => item.account === account);
    if (!saved) {
      saved = {
        account,
        userId: identity.id,
        name: identity.name,
        enabled: true,
        lastCheckedAt: 0,
        nextCheckAt: 0,
        error: '',
      };
      this.accounts.push(saved);
    } else {
      if (saved.error === 'auth_required') {
        saved.nextCheckAt = 0;
      }
      if (saved.userId !== identity.id) {
        saved.nextCheckAt = 0;
        saved.lastCheckedAt = 0;
      }
      saved.userId = identity.id;
      saved.name = identity.name;
    }
    this.persist();
    if (
      saved.enabled &&
      (saved.nextCheckAt <= this.now() ||
        this.options.needsInitialization?.(account))
    ) {
      await this.run(saved);
    }
    this.schedule();
  }

  async check(): Promise<void> {
    for (const account of ['xiaohongshu-1', 'xiaohongshu-2']) {
      if (this.stopped) {
        break;
      }
      const saved = this.accounts.find(item => item.account === account);
      if (
        saved &&
        (!saved.enabled ||
          (saved.nextCheckAt > this.now() &&
            !this.options.needsInitialization?.(account)))
      ) {
        continue;
      }
      try {
        const identity = await this.options.readAccount(account);
        if (identity) {
          await this.observe(account, identity);
        } else if (saved) {
          saved.error = 'auth_required';
          saved.nextCheckAt = this.now() + 3600000;
          this.persist();
        }
      } catch (error) {
        if (saved) {
          saved.error = error instanceof Error ? error.message : String(error);
          saved.nextCheckAt = this.now() + 3600000;
          this.persist();
        }
      }
    }
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.check();
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private run(account: BookmarkAccount): Promise<void> {
    const active = this.running.get(account.account);
    if (active) {
      return active;
    }
    account.nextCheckAt = this.now() + 3600000;
    account.error = '';
    this.persist();
    const operation = this.options
      .sync(account.account)
      .then(() => {
        account.lastCheckedAt = this.now();
      })
      .catch(error => {
        account.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.running.delete(account.account);
        account.nextCheckAt = this.now() + 3600000;
        this.persist();
      });
    this.running.set(account.account, operation);
    return operation;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.stopped) {
      return;
    }
    const due = this.accounts.filter(
      account => account.enabled && !this.running.has(account.account),
    );
    if (!due.length) {
      return;
    }
    this.timer = setTimeout(
      () => {
        void this.check().finally(() => this.schedule());
      },
      Math.max(
        1000,
        Math.min(...due.map(account => account.nextCheckAt - this.now())),
      ),
    );
    this.timer.unref?.();
  }

  private persist(): void {
    mkdirSync(this.options.folder, {recursive: true});
    writeFileSync(this.file + '.tmp', JSON.stringify(this.accounts), 'utf8');
    renameSync(this.file + '.tmp', this.file);
  }
}
