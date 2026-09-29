import type {FSWatcher} from 'node:fs';
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';

export interface ActivityCoverage {
  activeMs: number;
  idleMs: number;
  lockedMs: number;
  unavailableMs: number;
}
export interface ApplicationActivity {
  appId: string;
  label: string;
  activeMs: number;
  activations: number;
}
export interface PersonalActivityBatch {
  type?: 'batch';
  at: string;
  from: string;
  to: string;
  keyboard: Record<string, number>;
  applications: ApplicationActivity[];
  coverage: ActivityCoverage;
  usedBackend: string;
}
export interface ActivityGap {
  from: string;
  to: string | null;
  reason: 'paused' | 'disabled' | 'not_running' | 'collector_unavailable';
}
export interface PersonalActivitySettings {
  enabled: boolean;
  paused: boolean;
  screenEnabled: boolean;
  reportTime: string;
  retentionDays: number;
  roots: string[];
}
export interface FileActivityChange {
  at: string;
  kind: 'created' | 'modified' | 'deleted' | 'renamed';
  path: string;
  previousPath?: string;
  size?: number;
}
export interface ScreenActivitySample {
  at: string;
  appId: string;
  title: string;
  path: string;
  text: string;
  usedBackend: string;
  error?: string;
  width?: number;
  height?: number;
}
export interface PersonalActivityDay {
  version: 1;
  date: string;
  firstObservedAt: string;
  lastObservedAt: string;
  keyboard: Record<string, number>;
  applications: ApplicationActivity[];
  coverage: ActivityCoverage;
  files: FileActivityChange[];
  screens: ScreenActivitySample[];
  screenCount: number;
  fileCounts: Record<FileActivityChange['kind'], number>;
  detailsCleared?: boolean;
  roots: string[];
  usedBackends: string[];
}
export interface PersonalActivityStatus extends PersonalActivitySettings {
  startedAt: string | null;
  lastObservedAt: string | null;
  stoppedAt: string | null;
  recording: boolean;
  gaps: ActivityGap[];
  watchedRoots: string[];
  errors: Array<{path: string; message: string}>;
  excludedDirectoryNames: string[];
  fileScopes: ActivityFileScope[];
}
export interface ActivityFileScope {
  root: string;
  from: string;
  to: string | null;
  error?: string;
}
export interface PersonalActivityFacts {
  startedAt: string | null;
  through: string | null;
  observedDays: number;
  keyboard: Record<string, number>;
  applications: ApplicationActivity[];
  coverage: ActivityCoverage;
  fileCounts: Record<FileActivityChange['kind'], number>;
  gaps: ActivityGap[];
}
export type PersonalActivityDaySummary = Omit<
  PersonalActivityDay,
  'files' | 'screens'
>;
type ActivityTotals = Pick<
  PersonalActivityFacts,
  'observedDays' | 'keyboard' | 'applications' | 'coverage' | 'fileCounts'
>;
interface FileStamp {
  size: number;
  mtimeMs: number;
  ino: number;
  dev: number;
}
interface FileScan {
  files: Map<string, FileStamp>;
  directories: Set<string>;
  gaps: Set<string>;
}
export interface PersonalActivityReport {
  date: string;
  generatedAt: string;
  markdown: string;
  day: PersonalActivityDay | null;
  gaps: ActivityGap[];
}
interface ActivityState extends PersonalActivitySettings {
  version: 1;
  startedAt: string | null;
  lastObservedAt: string | null;
  stoppedAt: string | null;
  gaps: ActivityGap[];
  watchedRoots: string[];
  errors: Array<{path: string; message: string}>;
  fileScopes: ActivityFileScope[];
  totals: ActivityTotals;
}

const emptyCoverage = (): ActivityCoverage => ({
  activeMs: 0,
  idleMs: 0,
  lockedMs: 0,
  unavailableMs: 0,
});
const emptyFileCounts = (): Record<FileActivityChange['kind'], number> => ({
  created: 0,
  modified: 0,
  deleted: 0,
  renamed: 0,
});
const emptyTotals = (): ActivityTotals => ({
  observedDays: 0,
  keyboard: {},
  applications: [],
  coverage: emptyCoverage(),
  fileCounts: emptyFileCounts(),
});
const observedFilesystem: typeof import('node:fs') = process.versions.electron
  ? require('original-fs')
  : require('node:fs');
export const ACTIVITY_EXCLUDED_DIRECTORIES = [
  'node_modules',
  '.git',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.cache',
  '.next',
  'AppData',
  '$Recycle.Bin',
  'System Volume Information',
  'build',
  'dist',
  'release',
];
const excludedDirectoryNames = new Set(
  ACTIVITY_EXCLUDED_DIRECTORIES.map(name => name.toLowerCase()),
);
const pathKey = (path: string) =>
  process.platform === 'win32' ? path.toLowerCase() : path;
const withinPath = (parent: string, path: string) =>
  parent === path ||
  path.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
const clone = <T>(value: T): T => structuredClone(value);
export function localActivityDate(
  value: number | string | Date = Date.now(),
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('Invalid activity timestamp');
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function timestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('Invalid activity timestamp');
  }
  return date.toISOString();
}
function displayMoment(value: string): string {
  const date = new Date(value);
  return `${localActivityDate(date)} ${[date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':')}`;
}
function displayDuration(milliseconds: number): string {
  const seconds = Math.round(milliseconds / 1000);
  return seconds < 60
    ? `${seconds} 秒`
    : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function validDate(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    localActivityDate(`${value}T12:00:00`) !== value
  ) {
    throw new Error('Invalid activity date');
  }
  return value;
}
function count(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('Activity counts must be nonnegative');
  }
  return value;
}
function addApplications(
  target: ApplicationActivity[],
  incoming: ApplicationActivity[],
): void {
  for (const item of incoming) {
    if (!item.appId) {
      continue;
    }
    let existing = target.find(entry => entry.appId === item.appId);
    if (!existing) {
      existing = {
        appId: item.appId,
        label: item.label,
        activeMs: 0,
        activations: 0,
      };
      target.push(existing);
    }
    existing.label = item.label;
    existing.activeMs += count(item.activeMs);
    existing.activations += count(item.activations);
  }
  target.sort(
    (a, b) => b.activeMs - a.activeMs || a.appId.localeCompare(b.appId),
  );
}
function addKeyboard(
  target: Record<string, number>,
  counts: Record<string, number>,
): Record<string, number> {
  for (const [key, value] of Object.entries(counts)) {
    if (!/^[A-Za-z0-9_]{1,48}$/.test(key) || !Number.isInteger(value)) {
      throw new Error('Expected named key counts, not typed text');
    }
    target[key] = (target[key] ?? 0) + count(value);
  }
  return Object.fromEntries(
    Object.entries(target).sort(([a], [b]) => a.localeCompare(b)),
  );
}
async function load<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
async function save(path: string, data: unknown): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(data), 'utf8');
  await rename(`${path}.tmp`, path);
}

export class PersonalActivityStore {
  readonly directory: string;
  private state!: ActivityState;
  private opened?: Promise<void>;
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;
  private now: () => number;
  private watchers = new Map<string, FSWatcher>();
  private knownFiles = new Map<string, FileStamp>();
  private knownChildren = new Map<string, Set<string>>();
  private rootKeys: Array<{root: string; key: string}> = [];
  private changedPaths = new Set<string>();
  private fileTimer?: ReturnType<typeof setTimeout>;
  private fileFlushPending = false;
  private closing = false;
  constructor(
    directory: string,
    private options: {
      now?: () => number;
      enabled?: boolean;
      readonly?: boolean;
    } = {},
  ) {
    this.directory = resolve(directory);
    this.now = options.now ?? Date.now;
  }
  open(): Promise<void> {
    return (this.opened ??= this.initialize());
  }
  private async initialize(): Promise<void> {
    if (!this.options.readonly) {
      await mkdir(join(this.directory, 'days'), {recursive: true});
    }
    const prior = await load<ActivityState>(join(this.directory, 'state.json'));
    const at = new Date(this.now()).toISOString();
    this.state = prior ?? {
      version: 1,
      enabled: this.options.enabled ?? false,
      paused: false,
      screenEnabled: false,
      reportTime: '21:00',
      retentionDays: 30,
      roots: [],
      startedAt: null,
      lastObservedAt: null,
      stoppedAt: null,
      gaps: [],
      watchedRoots: [],
      errors: [],
      fileScopes: [],
      totals: emptyTotals(),
    };
    this.refreshRootKeys();
    if (this.options.readonly) {
      return;
    }
    if (prior?.enabled && !prior.paused) {
      const from = prior.stoppedAt ?? prior.lastObservedAt ?? prior.startedAt;
      if (from && from < at) {
        this.state.gaps.push({from, to: at, reason: 'not_running'});
      }
      for (const scope of this.state.fileScopes) {
        if (!scope.to) {
          scope.to = from ?? scope.from;
        }
      }
    }
    if (this.state.enabled && !this.state.startedAt) {
      this.state.startedAt = at;
    }
    this.state.stoppedAt = null;
    await this.resetFileWatchers();
    await this.saveState();
  }
  private saveState(): Promise<void> {
    return save(join(this.directory, 'state.json'), this.state);
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(async () => {
      await this.open();
      if (this.closed || this.options.readonly) {
        throw new Error('Activity store is not writable');
      }
      return action();
    });
    this.pending = result.catch(() => {});
    return result;
  }
  private async settled(): Promise<void> {
    await this.open();
    await this.pending;
    if (this.options.readonly) {
      this.state =
        (await load<ActivityState>(join(this.directory, 'state.json'))) ??
        this.state;
    }
  }
  private async readDay(date: string): Promise<PersonalActivityDay | null> {
    return load(join(this.directory, 'days', `${validDate(date)}.json`));
  }
  private async detailRows<T>(
    date: string,
    kind: 'screens' | 'files',
  ): Promise<T[]> {
    try {
      const contents = await readFile(
        join(this.directory, 'days', `${validDate(date)}.${kind}.jsonl`),
        'utf8',
      );
      return contents
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as T);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
  private async changeDay(
    at: string,
    change: (day: PersonalActivityDay) => void,
  ): Promise<boolean> {
    if (!this.state.enabled || this.state.paused) {
      return false;
    }
    const date = localActivityDate(at);
    const stored = await this.readDay(date);
    const day = stored ?? {
      version: 1,
      date,
      firstObservedAt: at,
      lastObservedAt: at,
      keyboard: {},
      applications: [],
      coverage: emptyCoverage(),
      files: [],
      fileCounts: emptyFileCounts(),
      screens: [],
      screenCount: 0,
      roots: [],
      usedBackends: [],
    };
    const before = clone(day);
    change(day);
    day.firstObservedAt = day.firstObservedAt < at ? day.firstObservedAt : at;
    day.lastObservedAt = day.lastObservedAt > at ? day.lastObservedAt : at;
    day.roots = [...new Set([...day.roots, ...this.state.watchedRoots])];
    for (const kind of ['files', 'screens'] as const) {
      if (day[kind].length) {
        await appendFile(
          join(this.directory, 'days', `${date}.${kind}.jsonl`),
          day[kind].map(row => `${JSON.stringify(row)}\n`).join(''),
          'utf8',
        );
      }
      day[kind] = [];
    }
    await save(join(this.directory, 'days', `${date}.json`), day);
    const totals = this.state.totals;
    if (!stored) {
      totals.observedDays++;
    }
    totals.keyboard = addKeyboard(
      totals.keyboard,
      Object.fromEntries(
        Object.entries(day.keyboard).map(([key, value]) => [
          key,
          value - (before.keyboard[key] ?? 0),
        ]),
      ),
    );
    addApplications(
      totals.applications,
      day.applications.map(app => {
        const prior = before.applications.find(old => old.appId === app.appId);
        return {
          ...app,
          activeMs: app.activeMs - (prior?.activeMs ?? 0),
          activations: app.activations - (prior?.activations ?? 0),
        };
      }),
    );
    for (const field of Object.keys(totals.coverage) as Array<
      keyof ActivityCoverage
    >) {
      totals.coverage[field] += day.coverage[field] - before.coverage[field];
    }
    for (const kind of Object.keys(totals.fileCounts) as Array<
      FileActivityChange['kind']
    >) {
      totals.fileCounts[kind] += day.fileCounts[kind] - before.fileCounts[kind];
    }
    this.state.lastObservedAt =
      !this.state.lastObservedAt ||
      day.lastObservedAt > this.state.lastObservedAt
        ? day.lastObservedAt
        : this.state.lastObservedAt;
    await this.saveState();
    return true;
  }
  recordBatch(batch: PersonalActivityBatch): Promise<boolean> {
    return this.enqueue(async () => {
      const at = timestamp(batch.at);
      const from = timestamp(batch.from);
      const to = timestamp(batch.to);
      if (
        from > to ||
        localActivityDate(from) !==
          localActivityDate(Math.max(Date.parse(from), Date.parse(to) - 1))
      ) {
        throw new Error('Activity batch must belong to one local date');
      }
      return this.changeDay(at, day => {
        day.keyboard = addKeyboard(day.keyboard, batch.keyboard);
        addApplications(day.applications, batch.applications);
        for (const field of Object.keys(day.coverage) as Array<
          keyof ActivityCoverage
        >) {
          day.coverage[field] += count(batch.coverage[field]);
        }
        day.lastObservedAt = day.lastObservedAt > to ? day.lastObservedAt : to;
        if (!day.usedBackends.includes(batch.usedBackend)) {
          day.usedBackends.push(batch.usedBackend);
        }
      });
    });
  }
  recordKeyboardBatch(batch: {
    at: string;
    counts: Record<string, number>;
  }): Promise<boolean> {
    return this.enqueue(() =>
      this.changeDay(timestamp(batch.at), day => {
        day.keyboard = addKeyboard(day.keyboard, batch.counts);
      }),
    );
  }
  recordApplication(
    value: ApplicationActivity & {at: string},
  ): Promise<boolean> {
    return this.enqueue(() =>
      this.changeDay(timestamp(value.at), day =>
        addApplications(day.applications, [value]),
      ),
    );
  }
  updateSettings(
    patch: Partial<PersonalActivitySettings>,
  ): Promise<PersonalActivityStatus> {
    return this.enqueue(async () => {
      if (
        patch.reportTime !== undefined &&
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.reportTime)
      ) {
        throw new Error('Daily report time must be HH:mm');
      }
      if (
        patch.retentionDays !== undefined &&
        (!Number.isInteger(patch.retentionDays) || patch.retentionDays < 1)
      ) {
        throw new Error('Retention must be a positive number of days');
      }
      const wasRecording = this.state.enabled && !this.state.paused;
      const previousRoots = this.state.roots;
      const at = new Date(this.now()).toISOString();
      for (const key of [
        'enabled',
        'paused',
        'screenEnabled',
        'reportTime',
        'retentionDays',
      ] as const) {
        if (patch[key] !== undefined) {
          Object.assign(this.state, {[key]: patch[key]});
        }
      }
      if (patch.roots) {
        this.state.roots = [
          ...new Map(
            patch.roots.filter(Boolean).map(root => {
              const path = resolve(root);
              return [pathKey(path), path];
            }),
          ).values(),
        ];
      }
      const rootsChanged =
        previousRoots.length !== this.state.roots.length ||
        previousRoots.some(
          (root, index) => pathKey(root) !== pathKey(this.state.roots[index]),
        );
      this.refreshRootKeys();
      const recording = this.state.enabled && !this.state.paused;
      if (wasRecording && !recording) {
        this.state.gaps.push({
          from: at,
          to: null,
          reason: this.state.paused ? 'paused' : 'disabled',
        });
      }
      if (!wasRecording && recording) {
        const gap = this.state.gaps.at(-1);
        if (gap?.to === null) {
          gap.to = at;
        }
        this.state.startedAt ??= at;
      }
      if (
        rootsChanged ||
        wasRecording !== recording ||
        (recording && this.state.roots.length && !this.watchers.size)
      ) {
        await this.resetFileWatchers();
      }
      await this.saveState();
      return this.status();
    });
  }
  setPaused(paused: boolean): Promise<PersonalActivityStatus> {
    return this.updateSettings({paused});
  }
  setCollectorAvailable(available: boolean): Promise<void> {
    return this.enqueue(async () => {
      const openGap = this.state.gaps
        .slice()
        .reverse()
        .find(gap => gap.reason === 'collector_unavailable' && gap.to === null);
      const at = new Date(this.now()).toISOString();
      if (available && openGap) {
        openGap.to = at;
      } else if (
        !available &&
        !openGap &&
        this.state.enabled &&
        !this.state.paused
      ) {
        this.state.gaps.push({
          from: at,
          to: null,
          reason: 'collector_unavailable',
        });
      } else {
        return;
      }
      await this.saveState();
    });
  }
  startFileWatching(roots: string[]): Promise<PersonalActivityStatus> {
    return this.updateSettings({roots});
  }
  stopFileWatching(): Promise<void> {
    return this.enqueue(async () => {
      this.closeFileWatchers();
      await this.saveState();
    });
  }
  private closeFileWatchers(): void {
    if (this.fileTimer) {
      clearTimeout(this.fileTimer);
    }
    this.fileTimer = undefined;
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    this.knownFiles.clear();
    this.knownChildren.clear();
    this.changedPaths.clear();
    const at = new Date(this.now()).toISOString();
    for (const scope of this.state.fileScopes) {
      if (!scope.to) {
        scope.to = at;
      }
    }
    this.state.watchedRoots = [];
  }
  private excluded(path: string): boolean {
    const key = pathKey(path);
    if (withinPath(pathKey(this.directory), key)) {
      return true;
    }
    const root = this.rootKeys.find(entry => withinPath(entry.key, key));
    return (root ? key.slice(root.key.length) : '')
      .split(sep)
      .some(part => excludedDirectoryNames.has(part.toLowerCase()));
  }
  private refreshRootKeys(): void {
    this.rootKeys = this.state.roots
      .map(root => ({root, key: pathKey(root)}))
      .sort((a, b) => b.key.length - a.key.length);
  }
  private fileReadGap(path: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !this.state.errors.some(
        entry => entry.path === path && entry.message === message,
      )
    ) {
      this.state.errors.push({path, message});
    }
  }
  private async scanFiles(path: string, root = path): Promise<FileScan> {
    const result: FileScan = {
      files: new Map(),
      directories: new Set(),
      gaps: new Set(),
    };
    const pending: Array<{path: string; directory?: boolean}> = [{path}];
    let cursor = 0;
    while (cursor < pending.length && !this.closing) {
      const batch = pending.slice(cursor, cursor + 16);
      cursor += batch.length;
      await Promise.all(
        batch.map(async item => {
          if (this.excluded(item.path)) {
            return;
          }
          try {
            if (!item.directory) {
              const info = await observedFilesystem.promises.lstat(item.path);
              if (info.isFile()) {
                result.files.set(item.path, {
                  size: info.size,
                  mtimeMs: info.mtimeMs,
                  ino: info.ino,
                  dev: info.dev,
                });
                return;
              }
              if (!info.isDirectory()) {
                return;
              }
            }
            const entries = await observedFilesystem.promises.readdir(
              item.path,
              {withFileTypes: true},
            );
            result.directories.add(item.path);
            for (const entry of entries) {
              if (entry.isFile() || entry.isDirectory()) {
                pending.push({
                  path: join(item.path, entry.name),
                  directory: entry.isDirectory(),
                });
              }
            }
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? '';
            if (['ENOENT', 'ENOTDIR'].includes(code)) {
              return;
            }
            if (item.path !== root && ['EACCES', 'EPERM'].includes(code)) {
              this.fileReadGap(item.path, error);
              result.gaps.add(item.path);
              return;
            }
            throw error;
          }
        }),
      );
    }
    return result;
  }
  private installFiles(scan: FileScan): void {
    for (const directory of scan.directories) {
      if (!this.knownChildren.has(directory)) {
        this.knownChildren.set(directory, new Set());
      }
    }
    for (const directory of scan.directories) {
      this.knownChildren.get(dirname(directory))?.add(directory);
    }
    for (const [path, info] of scan.files) {
      this.knownFiles.set(path, info);
      let child = path;
      let parent = dirname(path);
      while (!this.knownChildren.has(parent) && parent !== child) {
        this.knownChildren.set(parent, new Set([child]));
        child = parent;
        parent = dirname(parent);
      }
      this.knownChildren.get(parent)?.add(child);
    }
  }
  private knownSubtree(
    path: string,
    files: Map<string, FileStamp>,
    directories?: Set<string>,
  ): void {
    const pending = [path];
    while (pending.length) {
      const current = pending.pop()!;
      const file = this.knownFiles.get(current);
      if (file) {
        files.set(current, file);
      }
      const children = this.knownChildren.get(current);
      if (children) {
        directories?.add(current);
        pending.push(...children);
      }
    }
  }
  private removeKnownSubtree(path: string): void {
    const pending = [path];
    while (pending.length) {
      const current = pending.pop()!;
      const children = this.knownChildren.get(current);
      if (children) {
        pending.push(...children);
      }
      this.knownFiles.delete(current);
      this.knownChildren.delete(current);
    }
    this.knownChildren.get(dirname(path))?.delete(path);
  }
  private scheduleFileFlush(): void {
    if (
      this.fileTimer ||
      this.fileFlushPending ||
      this.closing ||
      !this.watchers.size
    ) {
      return;
    }
    this.fileTimer = setTimeout(() => {
      this.fileTimer = undefined;
      this.fileFlushPending = true;
      void this.enqueue(() => this.flushFileChanges())
        .catch(error => {
          this.fileReadGap(this.state.roots.join('; '), error);
        })
        .finally(() => {
          this.fileFlushPending = false;
          if (this.changedPaths.size) {
            this.scheduleFileFlush();
          }
        });
    }, 180);
    this.fileTimer.unref();
  }
  private async resetFileWatchers(): Promise<void> {
    this.closeFileWatchers();
    this.state.errors = [];
    if (!this.state.enabled || this.state.paused || this.closing) {
      return;
    }
    for (const root of this.state.roots) {
      const scope: ActivityFileScope = {
        root,
        from: new Date(this.now()).toISOString(),
        to: null,
      };
      this.state.fileScopes.push(scope);
      try {
        if (!(await observedFilesystem.promises.lstat(root)).isDirectory()) {
          throw new Error('Watch root must be a directory');
        }
        const baseline = await this.scanFiles(root);
        if (this.closing) {
          break;
        }
        this.installFiles(baseline);
        const watcher = observedFilesystem.watch(
          root,
          {recursive: true, persistent: false},
          (_event, filename) => {
            const path = filename ? resolve(root, String(filename)) : root;
            if (this.excluded(path)) {
              return;
            }
            this.changedPaths.add(path);
            this.scheduleFileFlush();
          },
        );
        watcher.on('error', error => {
          watcher.close();
          this.watchers.delete(root);
          scope.to = new Date(this.now()).toISOString();
          scope.error = error.message;
          this.state.watchedRoots = [...this.watchers.keys()];
          this.state.errors.push({path: root, message: error.message});
          void this.enqueue(() => this.saveState()).catch(() => {});
        });
        this.watchers.set(root, watcher);
        scope.from = new Date(this.now()).toISOString();
        this.state.watchedRoots.push(root);
      } catch (error) {
        this.watchers.get(root)?.close();
        this.watchers.delete(root);
        scope.to = new Date(this.now()).toISOString();
        scope.error = error instanceof Error ? error.message : String(error);
        this.state.errors.push({path: root, message: scope.error});
      }
    }
  }
  private async flushFileChanges(): Promise<void> {
    if (
      !this.state.enabled ||
      this.state.paused ||
      !this.watchers.size ||
      this.closing
    ) {
      return;
    }
    const changed = new Set(this.changedPaths);
    this.changedPaths.clear();
    const paths = [...changed].filter(path => {
      for (let parent = dirname(path); ;) {
        if (changed.has(parent)) {
          return false;
        }
        const next = dirname(parent);
        if (parent === next) {
          break;
        }
        parent = next;
      }
      return true;
    });
    const before = new Map<string, FileStamp>();
    const after = new Map<string, FileStamp>();
    const directories = new Set<string>();
    for (const path of paths) {
      this.knownSubtree(path, before);
      const root =
        this.rootKeys.find(entry => withinPath(entry.key, pathKey(path)))
          ?.root ?? path;
      const scanned = await this.scanFiles(path, root);
      for (const gap of scanned.gaps) {
        this.knownSubtree(gap, scanned.files, scanned.directories);
      }
      for (const [file, info] of scanned.files) {
        after.set(file, info);
      }
      for (const directory of scanned.directories) {
        directories.add(directory);
      }
    }
    if (this.closing) {
      return;
    }
    const deleted = [...before].filter(([path]) => !after.has(path));
    const added = [...after].filter(([path]) => !before.has(path));
    const at = new Date(this.now()).toISOString();
    const changes: FileActivityChange[] = [];
    const paired = new Set<string>();
    const deletedByIdentity = new Map<string, string[]>();
    for (const [path, info] of deleted) {
      const identity = `${info.dev}:${info.ino}`;
      const candidates = deletedByIdentity.get(identity) ?? [];
      candidates.push(path);
      deletedByIdentity.set(identity, candidates);
    }
    for (const [path, info] of added) {
      const old = info.ino
        ? (deletedByIdentity.get(`${info.dev}:${info.ino}`) ?? [])
        : [];
      if (old.length === 1) {
        paired.add(old[0]);
        deletedByIdentity.delete(`${info.dev}:${info.ino}`);
        changes.push({
          at,
          kind: 'renamed',
          path,
          previousPath: old[0],
          size: info.size,
        });
      } else {
        changes.push({at, kind: 'created', path, size: info.size});
      }
    }
    for (const [path] of deleted) {
      if (!paired.has(path)) {
        changes.push({at, kind: 'deleted', path});
      }
    }
    for (const [path, info] of after) {
      const old = before.get(path);
      if (old && (old.mtimeMs !== info.mtimeMs || old.size !== info.size)) {
        changes.push({at, kind: 'modified', path, size: info.size});
      }
    }
    for (const path of paths) {
      this.removeKnownSubtree(path);
    }
    this.installFiles({files: after, directories, gaps: new Set()});
    if (changes.length) {
      await this.changeDay(at, day => {
        day.files.push(...changes);
        for (const change of changes) {
          day.fileCounts[change.kind]++;
        }
        if (!day.usedBackends.includes('node.fs.watch')) {
          day.usedBackends.push('node.fs.watch');
        }
      });
    }
  }
  recordScreen(sample: ScreenActivitySample): Promise<boolean> {
    return this.enqueue(async () => {
      if (!this.state.screenEnabled) {
        return false;
      }
      const path = resolve(sample.path);
      const location = relative(join(this.directory, 'screens'), path);
      if (location.startsWith('..') || isAbsolute(location)) {
        throw new Error(
          'Screen evidence must be stored in the activity screens directory',
        );
      }
      return this.changeDay(timestamp(sample.at), day => {
        day.screens.push({
          at: timestamp(sample.at),
          appId: sample.appId,
          title: sample.title,
          path,
          text: sample.text,
          usedBackend: sample.usedBackend,
          ...(sample.error ? {error: sample.error} : {}),
          ...(sample.width ? {width: sample.width} : {}),
          ...(sample.height ? {height: sample.height} : {}),
        });
        day.screenCount++;
        if (!day.usedBackends.includes(sample.usedBackend)) {
          day.usedBackends.push(sample.usedBackend);
        }
      });
    });
  }
  async searchScreens(
    query: string,
    options: {from?: string; to?: string; limit?: number} = {},
  ): Promise<ScreenActivitySample[]> {
    const dates = await this.listDays();
    const result: ScreenActivitySample[] = [];
    const needle = query.toLocaleLowerCase();
    for (const date of dates) {
      if (
        (options.from && date < options.from) ||
        (options.to && date > options.to)
      ) {
        continue;
      }
      const rows = await this.detailRows<ScreenActivitySample>(date, 'screens');
      result.push(
        ...rows.filter(sample =>
          `${sample.title}\n${sample.text}`
            .toLocaleLowerCase()
            .includes(needle),
        ),
      );
    }
    return result
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, options.limit ?? 50);
  }
  private status(): PersonalActivityStatus {
    const {totals: _totals, ...state} = this.state;
    return {
      ...clone(state),
      recording:
        this.state.enabled &&
        !this.state.paused &&
        !this.closed &&
        !this.state.stoppedAt,
      excludedDirectoryNames: [...ACTIVITY_EXCLUDED_DIRECTORIES],
    };
  }
  async getStatus(): Promise<PersonalActivityStatus> {
    await this.settled();
    return this.status();
  }
  async listDays(): Promise<string[]> {
    await this.settled();
    return this.dates();
  }
  private async dates(): Promise<string[]> {
    try {
      return (await readdir(join(this.directory, 'days')))
        .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
        .map(name => name.slice(0, -5))
        .sort()
        .reverse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
  async getDay(
    date = localActivityDate(this.now()),
  ): Promise<PersonalActivityDay | null> {
    await this.settled();
    const day = await this.readDay(date);
    if (day) {
      [day.files, day.screens] = await Promise.all([
        this.detailRows<FileActivityChange>(date, 'files'),
        this.detailRows<ScreenActivitySample>(date, 'screens'),
      ]);
    }
    return day;
  }
  async getDaySummary(
    date = localActivityDate(this.now()),
  ): Promise<PersonalActivityDaySummary | null> {
    await this.settled();
    const day = await this.readDay(date);
    if (!day) {
      return null;
    }
    const {files: _files, screens: _screens, ...summary} = day;
    return summary;
  }
  async getFacts(): Promise<PersonalActivityFacts> {
    await this.settled();
    return {
      ...clone(this.state.totals),
      startedAt: this.state.startedAt,
      through: this.state.lastObservedAt,
      gaps: clone(this.state.gaps),
    };
  }
  async getReport(
    date = localActivityDate(this.now()),
  ): Promise<PersonalActivityReport> {
    const day = await this.getDay(date);
    const gaps = this.state.gaps.filter(
      gap =>
        localActivityDate(gap.from) <= date &&
        (!gap.to || localActivityDate(gap.to) >= date),
    );
    const lines = [
      `# ${date} 日报`,
      '',
      day
        ? `记录范围：${displayMoment(day.firstObservedAt)} 至 ${displayMoment(day.lastObservedAt)}（本地时间）。仅包含 Magic Pointer 实际运行并记录的时段。`
        : '这一天没有已记录的活动，不能补造此前记录。',
    ];
    if (day) {
      lines.push(
        '',
        `键盘：共 ${Object.values(day.keyboard).reduce((sum, value) => sum + value, 0)} 次按下。`,
      );
      const keys = Object.entries(day.keyboard)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6);
      if (
        day.keyboard.Enter !== undefined &&
        !keys.some(([key]) => key === 'Enter')
      ) {
        keys.push(['Enter', day.keyboard.Enter]);
      }
      if (keys.length) {
        lines.push(
          keys.map(([key, value]) => `${key}：${value} 次`).join('；') + '。',
        );
      }
      lines.push(
        '',
        `活跃 ${displayDuration(day.coverage.activeMs)}；空闲 ${displayDuration(day.coverage.idleMs)}；锁定 ${displayDuration(day.coverage.lockedMs)}；采集不可用 ${displayDuration(day.coverage.unavailableMs)}。`,
      );
      for (const app of day.applications.slice(0, 5)) {
        lines.push(
          `- ${app.label}：活跃 ${displayDuration(app.activeMs)}，切入 ${app.activations} 次`,
        );
      }
      lines.push(
        '',
        `文件变化事件：新增 ${day.fileCounts.created} 次，修改 ${day.fileCounts.modified} 次，删除 ${day.fileCounts.deleted} 次，重命名 ${day.fileCounts.renamed} 次。`,
        `文件范围：${day.roots.join('；') || '尚未开始目录观察'}。只记录路径和变化，不读取文件正文。`,
      );
      const labels = {
        created: '新增',
        modified: '修改',
        deleted: '删除',
        renamed: '重命名',
      };
      for (const file of day.files.slice(-10)) {
        lines.push(
          `- ${labels[file.kind]}：${file.previousPath ? `${file.previousPath} → ` : ''}${file.path}`,
        );
      }
      if (day.files.length > 10) {
        lines.push(
          `以上为最近 10 条；其余 ${day.files.length - 10} 条可在「文件足迹」中搜索。`,
        );
      }
      lines.push(
        '',
        `屏幕记录：${day.screenCount} 个样本。${day.detailsCleared ? '原图与详细事件已按保留期限清理，日汇总保留。' : '只代表采样时刻，不能据此填满全天时间线。'}`,
      );
      const contexts = new Set<string>();
      for (const sample of day.screens.slice().reverse()) {
        const context = `${sample.title || sample.appId}：${sample.text.replace(/\s+/g, ' ').slice(0, 140)}`;
        if (!sample.text.trim() || contexts.has(context)) {
          continue;
        }
        contexts.add(context);
        lines.push(`- ${context}`);
        if (contexts.size >= 3) {
          break;
        }
      }
    }
    const gapLabels: Record<ActivityGap['reason'], string> = {
      paused: '已暂停记录',
      disabled: '已关闭记录',
      not_running: '应用未运行',
      collector_unavailable: '采集暂不可用',
    };
    if (gaps.length) {
      lines.push('', `记录间断 ${gaps.length} 次：`);
      for (const gap of gaps.slice(-3)) {
        lines.push(
          `- ${displayMoment(gap.from)} 至 ${gap.to ? displayMoment(gap.to) : '现在'}：${gapLabels[gap.reason]}`,
        );
      }
    }
    const scopes = this.state.fileScopes.filter(
      scope =>
        localActivityDate(scope.from) <= date &&
        (!scope.to || localActivityDate(scope.to) >= date),
    );
    if (scopes.length) {
      lines.push(
        '',
        `实际观察了 ${new Set(scopes.map(scope => scope.root)).size} 个目录；范围、暂停区间和过滤规则见「记录设置与覆盖范围」。`,
      );
      for (const scope of scopes.filter(item => item.error).slice(-3)) {
        lines.push(`- ${scope.root}：${scope.error}`);
      }
    }
    return {
      date,
      generatedAt: new Date(this.now()).toISOString(),
      markdown: lines.join('\n'),
      day,
      gaps: clone(gaps),
    };
  }
  pruneDetails(): Promise<void> {
    return this.enqueue(async () => {
      const cutoff = new Date(this.now());
      cutoff.setDate(cutoff.getDate() - this.state.retentionDays);
      for (const date of await this.dates()) {
        if (date >= localActivityDate(cutoff)) {
          continue;
        }
        const day = await this.readDay(date);
        if (!day || day.detailsCleared) {
          continue;
        }
        for (const sample of await this.detailRows<ScreenActivitySample>(
          date,
          'screens',
        )) {
          const location = relative(
            join(this.directory, 'screens'),
            resolve(sample.path),
          );
          if (!location.startsWith('..') && !isAbsolute(location)) {
            await rm(sample.path, {force: true});
          }
        }
        await rm(join(this.directory, 'days', `${date}.files.jsonl`), {
          force: true,
        });
        await rm(join(this.directory, 'days', `${date}.screens.jsonl`), {
          force: true,
        });
        day.screens = [];
        day.files = [];
        day.detailsCleared = true;
        await save(join(this.directory, 'days', `${date}.json`), day);
      }
    });
  }
  clearHistory(): Promise<void> {
    return this.enqueue(async () => {
      await rm(join(this.directory, 'days'), {recursive: true, force: true});
      await rm(join(this.directory, 'screens'), {recursive: true, force: true});
      await mkdir(join(this.directory, 'days'), {recursive: true});
      this.state.startedAt =
        this.state.enabled && !this.state.paused
          ? new Date(this.now()).toISOString()
          : null;
      this.state.lastObservedAt = null;
      this.state.gaps = [];
      this.state.fileScopes = [];
      this.state.totals = emptyTotals();
      await this.resetFileWatchers();
      await this.saveState();
    });
  }
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.options.readonly) {
      this.closed = true;
      return;
    }
    this.closing = true;
    if (this.fileTimer) {
      clearTimeout(this.fileTimer);
      this.fileTimer = undefined;
    }
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    await this.enqueue(async () => {
      this.closeFileWatchers();
      this.state.stoppedAt = new Date(this.now()).toISOString();
      await this.saveState();
      this.closed = true;
    });
  }
}
