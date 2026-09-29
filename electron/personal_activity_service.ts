import {mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {
  PersonalActivityStore,
  localActivityDate,
  type PersonalActivityReport,
  type PersonalActivitySettings,
} from './personal_activity';
import {
  PersonalActivityNative,
  type PersonalActivityBatch as NativeBatch,
  type PersonalActivityNativeStatus,
} from './personal_activity_native';
import {PersonalScreenCapture} from './personal_screen_capture';

interface NativePort {
  start(): Promise<void>;
  stop(): Promise<void>;
  flush(): Promise<void>;
}
interface NativeCallbacks {
  onBatch(batch: NativeBatch): void;
  onStatus(status: PersonalActivityNativeStatus): void;
  onError(error: Error): void;
}
interface Options {
  now?: () => number;
  defaultRoots?: string[];
  createNative?: (callbacks: NativeCallbacks) => NativePort;
  onReport?: (report: PersonalActivityReport) => void;
  onError?: (error: unknown) => void;
}
interface ReportMark {
  generatedAt: string;
  final: boolean;
}

export class PersonalActivityService {
  readonly store: PersonalActivityStore;
  private native?: NativePort;
  private screen?: PersonalScreenCapture;
  private timer?: NodeJS.Timeout;
  private reportMarks: Record<string, ReportMark> = {};
  private ticking?: Promise<void>;
  private now: () => number;
  private prunedDate = '';
  private pending = Promise.resolve();
  nativeStatus: unknown = {state: 'stopped'};
  nativeError: string | null = null;
  screenError: string | null = null;

  constructor(
    readonly directory: string,
    readonly options: Options = {},
  ) {
    this.now = options.now ?? Date.now;
    this.store = new PersonalActivityStore(directory, {now: this.now});
  }

  async start(): Promise<void> {
    const firstStart = !existsSync(join(this.directory, 'state.json'));
    await this.store.open();
    try {
      this.reportMarks = JSON.parse(
        await readFile(join(this.directory, 'reports.json'), 'utf8'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (firstStart && this.options.defaultRoots?.length) {
      await this.store.updateSettings({roots: this.options.defaultRoots});
    }
    await this.synchronizeCollectors();
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch(error => this.options.onError?.(error));
    }, 60000);
    this.timer.unref();
  }

  async configure(patch: Partial<PersonalActivitySettings>): Promise<void> {
    // Flush the active interval before a pause can reject late collector batches.
    if (patch.paused === true || patch.enabled === false) {
      await this.stopCollectors();
    }
    await this.store.updateSettings(patch);
    await this.synchronizeCollectors();
  }

  private async synchronizeCollectors(): Promise<void> {
    const settings = await this.store.getStatus();
    if (!settings.enabled || settings.paused) {
      await this.stopCollectors();
      await this.store.stopFileWatching();
      return;
    }
    if (settings.screenEnabled && !this.screen) {
      this.screen = new PersonalScreenCapture(join(this.directory, 'screens'), {
        save: sample =>
          this.store.recordScreen({
            ...sample,
            at: new Date(sample.at).toISOString(),
          }),
      });
    } else if (!settings.screenEnabled && this.screen) {
      await this.screen.stop();
      this.screen = undefined;
    }
    if (this.native) {
      return;
    }
    const callbacks: NativeCallbacks = {
      onBatch: batch => {
        this.pending = this.pending
          .then(async () => {
            await this.store.recordBatch(batch);
            if (this.screen && batch.foreground) {
              const foreground = batch.foreground;
              if (/(^|[\\/])magic pointer(?:\.exe)?$/i.test(foreground.appId)) {
                return;
              }
              void this.screen
                .observe({
                  at: this.now(),
                  foreground,
                  idle: batch.state !== 'active',
                  locked: batch.state === 'locked',
                })
                .catch(error => {
                  this.screenError = String(error);
                  this.options.onError?.(error);
                });
            }
          })
          .catch(error => this.options.onError?.(error));
      },
      onStatus: status => {
        this.nativeStatus = status;
        if (status === 'running') {
          void this.store
            .setCollectorAvailable(true)
            .catch(error => this.options.onError?.(error));
        }
      },
      onError: error => {
        this.nativeError = error.message;
        void this.store
          .setCollectorAvailable(false)
          .catch(failure => this.options.onError?.(failure));
        this.options.onError?.(error);
      },
    };
    this.native =
      this.options.createNative?.(callbacks) ??
      new PersonalActivityNative(callbacks);
    try {
      await this.native.start();
      this.nativeError = null;
    } catch (error) {
      this.nativeError = error instanceof Error ? error.message : String(error);
      await this.native.stop();
      this.native = undefined;
      this.options.onError?.(error);
    }
  }

  private async stopCollectors(): Promise<void> {
    const native = this.native;
    this.native = undefined;
    if (native) {
      await native.stop();
    }
    await this.pending;
    if (this.screen) {
      await this.screen.stop();
    }
    this.screen = undefined;
  }

  tick(): Promise<void> {
    return (this.ticking ??= this.generateDueReports().finally(() => {
      this.ticking = undefined;
    }));
  }

  private async generateDueReports(): Promise<void> {
    const settings = await this.store.getStatus();
    if (!settings.enabled) {
      return;
    }
    if (!settings.paused && this.nativeStatus === 'error') {
      await this.stopCollectors();
      await this.synchronizeCollectors();
    }
    const now = new Date(this.now());
    const today = localActivityDate(now);
    if (this.prunedDate !== today) {
      await this.store.pruneDetails();
      this.prunedDate = today;
    }
    const [hour, minute] = settings.reportTime.split(':').map(Number);
    const dueToday =
      now.getHours() * 60 + now.getMinutes() >= hour * 60 + minute;
    for (const date of await this.store.listDays()) {
      const previous = this.reportMarks[date];
      const final = date < today;
      if (
        date > today ||
        (!final && !dueToday) ||
        previous?.final ||
        (previous && !final)
      ) {
        continue;
      }
      const report = await this.generateReport(date);
      this.reportMarks[date] = {generatedAt: report.generatedAt, final};
      await writeFile(
        join(this.directory, 'reports.json'),
        JSON.stringify(this.reportMarks),
      );
      if (!previous) {
        this.options.onReport?.(report);
      }
    }
  }

  async generateReport(
    date = localActivityDate(this.now()),
  ): Promise<PersonalActivityReport> {
    await this.pending;
    const report = await this.store.getReport(date);
    await mkdir(join(this.directory, 'reports'), {recursive: true});
    await writeFile(
      join(this.directory, 'reports', `${report.date}.md`),
      report.markdown,
      'utf8',
    );
    return report;
  }

  async snapshot(date = localActivityDate(this.now())) {
    await this.pending;
    const [status, day, facts, days, report] = await Promise.all([
      this.store.getStatus(),
      this.store.getDay(date),
      this.store.getFacts(),
      this.store.listDays(),
      this.store.getReport(date),
    ]);
    return {
      status,
      day,
      facts,
      days,
      report,
      nativeStatus: this.nativeStatus,
      nativeError: this.nativeError,
      screenError: this.screenError,
    };
  }

  async clearHistory(): Promise<void> {
    await this.stopCollectors();
    await this.store.clearHistory();
    await rm(join(this.directory, 'reports'), {recursive: true, force: true});
    this.reportMarks = {};
    await writeFile(join(this.directory, 'reports.json'), '{}');
    await this.synchronizeCollectors();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = undefined;
    await this.stopCollectors();
    await this.ticking;
    await this.store.close();
  }
}
