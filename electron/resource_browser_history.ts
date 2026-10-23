import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

export type HistoryList = 'saved' | 'liked';
export interface HistoryLink {
  id: string;
  url: string;
  title: string;
}
export interface HistoryPage {
  links: HistoryLink[];
  url: string;
  atEnd: boolean;
  error: string;
  coverage: string;
  position: number;
}
export interface HistoryJob {
  url?: string;
  account: string;
  list: HistoryList;
  status:
    | 'running'
    | 'paused'
    | 'complete'
    | 'auth_required'
    | 'verification_required'
    | 'error';
  retained: number;
  seen: Record<string, string>;
  pages: number;
  position: number;
  updatedAt: number;
  coverage: string;
  error: string;
}
interface HistoryOptions {
  folder: string;
  readPage(
    account: string,
    list: HistoryList,
    reset: boolean,
  ): Promise<HistoryPage>;
  importLink(account: string, link: HistoryLink): Promise<string>;
}

export class ResourceBrowserHistory {
  private readonly file: string;
  private readonly jobs: HistoryJob[];
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly options: HistoryOptions) {
    this.file = join(options.folder, 'resource-browser-history.json');
    this.jobs = existsSync(this.file)
      ? (JSON.parse(readFileSync(this.file, 'utf8')) as HistoryJob[])
      : [];
    for (const job of this.jobs) {
      if (job.status === 'running') {
        job.status = 'paused';
        job.coverage =
          'Interrupted; retained links are saved. Resume re-reads the list and skips already retained notes.';
      }
    }
  }

  snapshot(): Array<Omit<HistoryJob, 'seen'>> {
    return this.jobs.map(({seen: _seen, ...job}) => ({...job}));
  }

  pause(account: string, list: HistoryList): void {
    const job = this.jobs.find(
      item => item.account === account && item.list === list,
    );
    if (job?.status === 'running') {
      job.status = 'paused';
      job.coverage =
        'Paused by user. Retained links and their capture queue are saved.';
      this.persist(job);
    }
  }

  run(account: string, list: HistoryList): Promise<void> {
    if (
      !/^xiaohongshu-[12]$/.test(account) ||
      !['saved', 'liked'].includes(list)
    ) {
      return Promise.reject(
        new Error('A supported Xiaohongshu account and list are required.'),
      );
    }
    // Both lists use the same native scanner for this account.
    const active = this.running.get(account);
    if (active) {
      return this.jobs.some(
        job => job.account === account && job.status === 'running',
      )
        ? active
        : active.then(() => this.run(account, list));
    }
    let job = this.jobs.find(
      item => item.account === account && item.list === list,
    );
    if (!job) {
      job = {
        account,
        list,
        status: 'paused',
        seen: {},
        retained: 0,
        pages: 0,
        position: 0,
        updatedAt: 0,
        coverage: '',
        error: '',
      };
      this.jobs.push(job);
    }
    job.status = 'running';
    job.error = '';
    job.pages = 0;
    this.persist(job);
    const operation = this.scan(job).finally(() =>
      this.running.delete(account),
    );
    this.running.set(account, operation);
    return operation;
  }

  private async scan(job: HistoryJob): Promise<void> {
    let stale = 0;
    let previousPosition = -1;
    try {
      while (job.status === 'running') {
        const page = await this.options.readPage(
          job.account,
          job.list,
          job.pages === 0,
        );
        if (job.status !== 'running') {
          return;
        }
        job.url = page.url;
        if (page.error) {
          job.status = page.error.includes('verification_required')
            ? 'verification_required'
            : page.error.includes('auth_required')
              ? 'auth_required'
              : 'error';
          job.error = page.error;
          job.coverage = page.coverage;
          this.persist(job);
          return;
        }
        let added = 0;
        for (const link of page.links) {
          if (job.status !== 'running') {
            return;
          }
          if (job.seen[link.id]) {
            continue;
          }
          const resourceId = await this.options.importLink(job.account, link);
          job.seen[link.id] = resourceId;
          job.retained = Object.keys(job.seen).length;
          added++;
          this.persist(job);
        }
        job.pages++;
        job.position = page.position;
        job.coverage = page.coverage;
        stale = added || page.position !== previousPosition ? 0 : stale + 1;
        previousPosition = page.position;
        if (page.atEnd) {
          job.status = 'complete';
          job.coverage +=
            ' The page explicitly displayed the end of this account list. Retained links may still be downloading; unavailable or hidden posts are not proved complete.';
        } else if (stale >= 3) {
          job.status = 'paused';
          job.coverage +=
            ' The visible list stopped changing; this does not prove the end of history. Resume after checking the account page.';
        }
        this.persist(job);
      }
    } catch (error) {
      if (job.status === 'running') {
        job.status = 'error';
        job.error = error instanceof Error ? error.message : String(error);
        this.persist(job);
      }
    }
  }

  stop(): void {
    for (const job of this.jobs) {
      if (job.status === 'running') {
        job.status = 'paused';
        job.coverage =
          'App stopped; retained links and checkpoints can be resumed.';
        this.persist(job);
      }
    }
  }

  private persist(job: HistoryJob): void {
    mkdirSync(this.options.folder, {recursive: true});
    job.updatedAt = Date.now();
    writeFileSync(this.file + '.tmp', JSON.stringify(this.jobs), 'utf8');
    renameSync(this.file + '.tmp', this.file);
  }
}
