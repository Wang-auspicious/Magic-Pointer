import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import {join} from 'node:path';

export interface XSourceState {
  enabled: boolean;
  likes: boolean;
  bookmarks: boolean;
  accountId: string;
  username: string;
  status:
    | 'disconnected'
    | 'ready'
    | 'syncing'
    | 'partial'
    | 'auth_required'
    | 'rate_limited'
    | 'error';
  lastAttempt: number;
  lastSuccess: number;
  nextRunAt: number;
  lastCount: number;
  error: string;
  organize: boolean;
  rules: string;
  recentIds: string[];
}

interface XSourceOptions {
  folder: string;
  credentials: {
    get(key: string): string | null;
    set(key: string, value: string): unknown;
  };
  fetch(url: string, init: RequestInit): Promise<Response>;
  add(input: {url: string; text: string; title: string}): Promise<unknown>;
  delay?: () => Promise<void>;
}

export class XResourceSource {
  private state: XSourceState = {
    enabled: false,
    likes: false,
    bookmarks: true,
    accountId: '',
    username: '',
    status: 'disconnected',
    lastAttempt: 0,
    lastSuccess: 0,
    nextRunAt: 0,
    lastCount: 0,
    error: '',
    organize: false,
    rules: '',
    recentIds: [],
  };
  private busy = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly file: string;
  constructor(private readonly options: XSourceOptions) {
    this.file = join(options.folder, 'resource-x.json');
    if (existsSync(this.file)) {
      this.state = {
        ...this.state,
        ...JSON.parse(readFileSync(this.file, 'utf8')),
      };
      if (this.state.status === 'syncing') {
        this.state.status = 'partial';
        this.state.error =
          'Sync was interrupted. Saved resources are retained.';
      }
    }
  }
  snapshot(): XSourceState {
    return {...this.state, recentIds: [...this.state.recentIds]};
  }
  private save(): void {
    mkdirSync(this.options.folder, {recursive: true});
    writeFileSync(this.file + '.tmp', JSON.stringify(this.state), 'utf8');
    renameSync(this.file + '.tmp', this.file);
  }
  private async request(
    path: string,
    token: string,
  ): Promise<Record<string, any>> {
    const response = await this.options.fetch('https://api.x.com/2/' + path, {
      method: 'GET',
      headers: {Authorization: `Bearer ${token}`},
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      throw new Error(
        response.status === 429
          ? 'rate_limited'
          : [401, 403].includes(response.status)
            ? 'auth_required'
            : `X API returned HTTP ${response.status}.`,
      );
    }
    const result = (await response.json()) as Record<string, any>;
    if (result.errors?.length) {
      throw new Error(
        'X API returned a partial error. Check the app permissions and access tier.',
      );
    }
    return result;
  }
  async connect(token: string): Promise<XSourceState> {
    if (this.busy) {
      throw new Error('Wait for the current sync to finish.');
    }
    const result = await this.request('users/me', token.trim());
    if (!/^\d+$/.test(String(result.data?.id || ''))) {
      throw new Error('A user-authorized X OAuth access token is required.');
    }
    this.options.credentials.set(
      `resources.x.oauth:${result.data.id}`,
      token.trim(),
    );
    this.state = {
      ...this.state,
      recentIds:
        this.state.accountId === result.data.id ? this.state.recentIds : [],
      accountId: result.data.id,
      username: String(result.data.username || ''),
      status: 'ready',
      error: '',
      enabled: false,
      lastCount: 0,
      nextRunAt: 0,
    };
    this.save();
    return this.snapshot();
  }
  configure(
    patch: Partial<
      Pick<
        XSourceState,
        'enabled' | 'likes' | 'bookmarks' | 'organize' | 'rules'
      >
    >,
  ): XSourceState {
    if (patch.enabled && !this.state.accountId) {
      throw new Error(
        'Connect an official X API account first. Browser login is separate.',
      );
    }
    for (const key of ['enabled', 'likes', 'bookmarks', 'organize'] as const) {
      if (typeof patch[key] === 'boolean') {
        this.state[key] = patch[key]!;
      }
    }
    if (typeof patch.rules === 'string') {
      this.state.rules = patch.rules.slice(0, 12000);
    }
    this.save();
    return this.snapshot();
  }
  async sync(manual = false): Promise<XSourceState> {
    if (
      this.busy ||
      (!manual && (!this.state.enabled || Date.now() < this.state.nextRunAt))
    ) {
      return this.snapshot();
    }
    if (
      Date.now() < this.state.nextRunAt &&
      this.state.status === 'rate_limited'
    ) {
      return this.snapshot();
    }
    if (!this.state.accountId) {
      throw new Error('Connect an official X API account first.');
    }
    this.busy = true;
    this.state = {
      ...this.state,
      status: 'syncing',
      lastAttempt: Date.now(),
      lastCount: 0,
      error: '',
    };
    this.save();
    let partial = false;
    try {
      const token = this.options.credentials.get(
        `resources.x.oauth:${this.state.accountId}`,
      );
      if (!token) {
        throw new Error('auth_required');
      }
      const kinds = [
        this.state.bookmarks ? 'bookmarks' : '',
        this.state.likes ? 'liked_tweets' : '',
      ].filter(Boolean);
      for (const kind of kinds) {
        let cursor = '';
        for (let page = 0; page < 5; page += 1) {
          if (!manual && !this.state.enabled) {
            partial = true;
            break;
          }
          const query = new URLSearchParams({
            max_results: '100',
            'tweet.fields': 'created_at,entities',
          });
          if (cursor) {
            query.set('pagination_token', cursor);
          }
          const result = await this.request(
            `users/${this.state.accountId}/${kind}?${query}`,
            token,
          );
          let newItems = 0;
          for (const post of result.data || []) {
            if (
              !/^\d+$/.test(String(post.id)) ||
              typeof post.text !== 'string'
            ) {
              throw new Error('Unexpected X post data. Sync stopped.');
            }
            const identity = `${kind}:${post.id}`;
            if (this.state.recentIds.includes(identity)) {
              continue;
            }
            const links = (post.entities?.urls || [])
              .map((url: {expanded_url?: string}) => url.expanded_url)
              .filter(Boolean);
            await this.options.add({
              url: `https://x.com/i/status/${post.id}`,
              text: `${post.text}\n\n${links.join('\n')}`,
              title: post.text.slice(0, 100),
            });
            this.state.recentIds = [...this.state.recentIds, identity].slice(
              -2000,
            );
            this.state.lastCount += 1;
            newItems += 1;
          }
          this.save();
          cursor = String(result.meta?.next_token || '');
          if (!cursor || (newItems === 0 && (result.data || []).length > 0)) {
            break;
          }
          if (page === 4) {
            partial = true;
          } else {
            await (this.options.delay?.() ||
              new Promise(resolve => setTimeout(resolve, 1000)));
          }
        }
      }
      this.state.status = partial ? 'partial' : 'ready';
      this.state.lastSuccess = Date.now();
      this.state.error = partial
        ? 'Only the recent window was checked (up to 500 per list). Older history may be missing.'
        : '';
      this.state.nextRunAt = Date.now() + 30 * 60000;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.status =
        message === 'rate_limited'
          ? 'rate_limited'
          : message === 'auth_required'
            ? 'auth_required'
            : 'error';
      this.state.error = message;
      this.state.nextRunAt = Date.now() + 60 * 60000;
      if (this.state.status === 'auth_required') {
        this.state.enabled = false;
      }
    } finally {
      this.busy = false;
      this.save();
    }
    return this.snapshot();
  }
  start(): void {
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.sync().catch(() => {});
      }, 60000);
      this.timer.unref();
    }
  }
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
