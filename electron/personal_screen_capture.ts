import {mkdir, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';
import {
  captureSurface,
  nativeRequest,
  closeDesktop,
  type DesktopWindow,
  type Rect,
} from './runtime/desktop';
import {recognizeText, closeOcr} from './runtime/desktop_perception';

export interface PersonalForeground {
  hwnd: number;
  pid: number;
  appId: string;
  label: string;
  title: string;
  bounds: Rect;
}
export interface PersonalScreenSample {
  at: number;
  appId: string;
  title: string;
  path: string;
  text: string;
  usedBackend: string;
  width: number;
  height: number;
  error?: string;
}
interface Dependencies {
  save(sample: PersonalScreenSample): Promise<unknown>;
  capture?(
    foreground: PersonalForeground,
    signal: AbortSignal,
  ): Promise<{bytes: Buffer; source: string; capturedAtUtc: string}>;
  recognize?(
    path: string,
    signal: AbortSignal,
  ): Promise<{text: string; usedBackend: string}>;
  foreground?(): Promise<number>;
  minimumIntervalMs?: number;
}

export class PersonalScreenCapture {
  private lastAt = -Infinity;
  private previous?: {window: string; pixels: Buffer};
  private inFlight?: Promise<void>;
  private controller = new AbortController();
  private count = 0;
  constructor(
    readonly directory: string,
    readonly dependencies: Dependencies,
  ) {}

  observe(input: {
    at: number;
    foreground?: PersonalForeground;
    idle: boolean;
    locked: boolean;
  }): Promise<void> {
    if (
      this.controller.signal.aborted ||
      input.idle ||
      input.locked ||
      !input.foreground?.hwnd ||
      this.inFlight ||
      input.at - this.lastAt < (this.dependencies.minimumIntervalMs ?? 30000)
    ) {
      return Promise.resolve();
    }
    this.lastAt = input.at;
    this.inFlight = this.capture(input.foreground, input.at).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async capture(
    foreground: PersonalForeground,
    at: number,
  ): Promise<void> {
    const signal = this.controller.signal;
    const currentForeground =
      this.dependencies.foreground ??
      (async () =>
        Number(
          (
            await nativeRequest<{foreground: number}>(
              'cursor',
              {},
              signal,
              2000,
            )
          ).foreground,
        ));
    if ((await currentForeground()) !== foreground.hwnd) {
      return;
    }
    const capture =
      this.dependencies.capture ??
      (async (target: PersonalForeground, abort: AbortSignal) => {
        const live = await nativeRequest<DesktopWindow>(
          'window',
          {hwnd: target.hwnd},
          abort,
          2000,
        );
        if (live.pid !== target.pid || live.hwnd !== target.hwnd) {
          throw new Error('screen_target_changed');
        }
        return captureSurface(live.bbox, abort, live.hwnd);
      });
    const frame = await capture(foreground, signal);
    signal.throwIfAborted();
    if ((await currentForeground()) !== foreground.hwnd) {
      return;
    }
    const pixels = await sharp(frame.bytes)
      .resize(160, 100, {fit: 'fill'})
      .removeAlpha()
      .raw()
      .toBuffer();
    const window = `${foreground.hwnd}:${foreground.pid}:${foreground.title}`;
    if (
      this.previous?.window === window &&
      this.previous.pixels.equals(pixels)
    ) {
      return;
    }
    await mkdir(this.directory, {recursive: true});
    const path = join(this.directory, `${at}-${++this.count}.jpg`);
    const metadata = await sharp(frame.bytes).jpeg({quality: 82}).toFile(path);
    let saved = false;
    try {
      let text = '';
      let usedBackend = frame.source;
      let error: string | undefined;
      try {
        const result = this.dependencies.recognize
          ? await this.dependencies.recognize(path, signal)
          : await recognizeText(path, {signal});
        text = result.text;
        usedBackend += `+${result.usedBackend}`;
      } catch (failure) {
        signal.throwIfAborted();
        error = failure instanceof Error ? failure.message : String(failure);
      }
      signal.throwIfAborted();
      const accepted = await this.dependencies.save({
        at: Date.parse(frame.capturedAtUtc) || at,
        appId: foreground.appId,
        title: foreground.title,
        path,
        text,
        usedBackend,
        width: metadata.width,
        height: metadata.height,
        ...(error ? {error} : {}),
      });
      saved = accepted !== false;
      if (!saved) {
        return;
      }
      this.previous = {window, pixels};
    } finally {
      if (!saved) {
        await unlink(path).catch(() => {});
      }
    }
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await this.inFlight?.catch(() => {});
    if (!this.dependencies.recognize) {
      closeOcr();
    }
    if (!this.dependencies.capture) {
      closeDesktop();
    }
  }
}
