import {createInterface} from 'node:readline';
import {writeFile, mkdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {
  captureSurface,
  closeDesktop,
  configureDesktop,
  desktopDataRoot,
  nativeRequest,
  type DesktopRecord,
  type DesktopWindow,
  type Rect,
} from './desktop';
import {WgcCaptureSession, type NativeCaptureSession} from './wgc_capture';

export interface BufferedCapture {
  bytes: Buffer;
  width: number;
  height: number;
  source: string;
  capturedAtUtc: string;
  capturedAtMonotonicMs: number;
}
export class FrameCaptureService {
  private epoch?: DesktopRecord;
  private frames: BufferedCapture[] = [];
  private timer?: NodeJS.Timeout;
  private generation = 0;
  private windowAtArm?: Promise<DesktopWindow | null>;
  private nativeActive = false;
  private captureFallbackReason?: string;
  constructor(
    readonly outputRoot: string,
    readonly intervalMs = 33,
    readonly capture = captureSurface,
    readonly resolveWindow = (hwnd: number) =>
      nativeRequest<DesktopWindow>('window', {hwnd}, undefined, 1000),
    readonly native: NativeCaptureSession | undefined = process.platform ===
      'win32' && capture === captureSurface
      ? new WgcCaptureSession()
      : undefined,
  ) {}
  async arm(params: DesktopRecord): Promise<void> {
    const bounds = params.surfaceBoundsPx;
    if (
      !params.epochId ||
      !params.displayId ||
      !Array.isArray(bounds) ||
      bounds.length !== 4 ||
      !bounds.every(Number.isFinite) ||
      bounds[2] <= bounds[0] ||
      bounds[3] <= bounds[1]
    ) {
      throw new Error('invalid_arm');
    }
    this.cancel();
    this.epoch = structuredClone(params);
    this.captureFallbackReason = undefined;
    const generation = this.generation;
    if (this.native) {
      try {
        await this.native.arm({
          epochId: params.epochId,
          surfaceBoundsPx: bounds,
        });
        if (generation !== this.generation) {
          await this.native.cancel(String(params.epochId));
          return;
        }
        this.nativeActive = true;
        if (Number(params.targetWindow?.hwnd) > 0) {
          this.windowAtArm = this.resolveWindow(
            Number(params.targetWindow.hwnd),
          ).catch(() => null);
        }
        return;
      } catch (error) {
        if (generation !== this.generation) {
          return;
        }
        this.captureFallbackReason =
          error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `capture: WGC unavailable, using gdi-fallback: ${this.captureFallbackReason}\n`,
        );
      }
    }
    const next = async () => {
      try {
        const frame = await this.capture(bounds as Rect);
        if (generation !== this.generation || !this.epoch) {
          return;
        }
        this.frames.push({...frame, capturedAtMonotonicMs: performance.now()});
        if (this.frames.length > 8) {
          this.frames.shift();
        }
        if (!this.windowAtArm && Number(this.epoch.targetWindow?.hwnd) > 0) {
          this.windowAtArm = this.resolveWindow(
            Number(this.epoch.targetWindow.hwnd),
          ).catch(() => null);
        }
      } catch (error) {
        process.stderr.write(
          `capture: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      if (generation === this.generation && this.epoch) {
        this.timer = setTimeout(() => {
          void next();
        }, this.intervalMs);
      }
    };
    await next();
    if (generation === this.generation && !this.frames.length) {
      this.cancel(String(params.epochId));
      throw new Error('capture_first_frame_unavailable');
    }
  }
  cancel(epochId?: string): void {
    if (epochId && this.epoch?.epochId !== epochId) {
      return;
    }
    const cancelledEpoch = this.epoch?.epochId;
    this.generation++;
    this.nativeActive = false;
    if (cancelledEpoch && this.native) {
      void this.native.cancel(String(cancelledEpoch)).catch(error => {
        process.stderr.write(`capture: WGC cancel failed: ${String(error)}\n`);
      });
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = undefined;
    this.frames = [];
    this.epoch = undefined;
    this.windowAtArm = undefined;
  }
  async commit(params: DesktopRecord): Promise<DesktopRecord> {
    const committedAt = performance.now();
    const epoch = this.epoch;
    if (!epoch) {
      throw new Error('epoch_not_armed');
    }
    if (params.epochId !== epoch.epochId) {
      throw new Error('epoch_mismatch');
    }
    let frame = this.frames
      .filter(value => value.capturedAtMonotonicMs <= committedAt)
      .at(-1);
    const windowAtArm = this.windowAtArm;
    const fallbackReason = this.captureFallbackReason;
    let captureLatencyMs: number | undefined;
    if (this.nativeActive && this.native) {
      this.nativeActive = false;
      try {
        const result = await this.native.commit(String(epoch.epochId));
        if (
          result.width !==
            epoch.surfaceBoundsPx[2] - epoch.surfaceBoundsPx[0] ||
          result.height !== epoch.surfaceBoundsPx[3] - epoch.surfaceBoundsPx[1]
        ) {
          throw new Error('capture_display_resized');
        }
        captureLatencyMs = Number(result.captureLatencyMs);
        frame = {
          bytes: Buffer.from(result.png, 'base64'),
          width: result.width,
          height: result.height,
          source: result.source,
          capturedAtUtc: result.capturedAtUtc,
          capturedAtMonotonicMs: Math.max(0, committedAt - captureLatencyMs),
        };
      } finally {
        this.cancel(String(epoch.epochId));
      }
    }
    this.cancel(String(epoch.epochId));
    if (!frame) {
      throw new Error('no_frame_buffered');
    }
    const resolved = await windowAtArm;
    const targetWindow = epoch.targetWindow;
    const sameTarget =
      resolved &&
      Number(resolved.hwnd) === Number(targetWindow?.hwnd) &&
      Number(resolved.pid) === Number(targetWindow?.processId);
    const window =
      sameTarget &&
      Array.isArray(resolved.bbox) &&
      resolved.bbox.length === 4 &&
      resolved.bbox.every(Number.isFinite)
        ? {
            ...targetWindow,
            bbox: resolved.bbox,
            processStartTime: resolved.processStartTime,
            title: resolved.title || targetWindow.title,
          }
        : targetWindow;
    const directory = join(this.outputRoot, 'frame-leases');
    await mkdir(directory, {recursive: true});
    const id = `frame-${randomUUID()}`;
    const path = join(directory, `${id}.png`);
    await writeFile(path, frame.bytes, {flag: 'wx'});
    return {
      schemaVersion: 1,
      frameLeaseId: id,
      epochId: epoch.epochId,
      capturedAtMonotonicMs: frame.capturedAtMonotonicMs,
      capturedAtUtc: frame.capturedAtUtc,
      source: frame.source,
      targetWindow: window,
      surfaceBoundsPx: epoch.surfaceBoundsPx,
      displayId: epoch.displayId,
      scaleFactor: epoch.scaleFactor || 1,
      gesture: params.gesture || {},
      localArtifact: {
        path,
        mimeType: 'image/png',
        width: frame.width,
        height: frame.height,
      },
      contentHash: `sha256:${createHash('sha256').update(frame.bytes).digest('hex')}`,
      overlayExcluded:
        epoch.overlayExcluded === true && process.platform === 'win32',
      captureLatencyMs:
        captureLatencyMs ??
        Math.max(0, committedAt - frame.capturedAtMonotonicMs),
      ...(fallbackReason ? {captureFallbackReason: fallbackReason} : {}),
    };
  }
  async handle(request: DesktopRecord): Promise<DesktopRecord> {
    const params = request.params || {};
    try {
      let result: DesktopRecord;
      switch (request.method) {
        case 'ping':
          result = {
            pong: true,
            backend: this.native ? 'wgc-display-preferred' : 'gdi-fallback',
            pid: process.pid,
          };
          break;
        case 'arm':
          await this.arm(params);
          result = {
            epochId: params.epochId,
            usedBackend: this.nativeActive ? 'wgc-display' : 'gdi-fallback',
            captureFallbackReason: this.captureFallbackReason,
          };
          break;
        case 'commit':
          result = await this.commit(params);
          break;
        case 'cancel':
          this.cancel(params.epochId);
          result = {cancelled: true};
          break;
        case 'shutdown':
          this.cancel();
          this.native?.close();
          closeDesktop();
          result = {shutdown: true};
          break;
        default:
          throw new Error('unknown_method');
      }
      return {id: request.id, result};
    } catch (error) {
      return {
        id: request.id,
        error: {code: error instanceof Error ? error.message : String(error)},
      };
    }
  }
}

if (require.main === module) {
  const root = resolve(process.argv[2] || process.cwd());
  configureDesktop(root);
  const service = new FrameCaptureService(desktopDataRoot());
  const input = createInterface({input: process.stdin});
  input.on('line', line => {
    let request: DesktopRecord;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(
        `${JSON.stringify({error: {code: 'invalid_json'}})}\n`,
      );
      return;
    }
    void service.handle(request).then(response => {
      process.stdout.write(`${JSON.stringify(response)}\n`);
      if (request.method === 'shutdown') {
        input.close();
      }
    });
  });
  input.on('close', () => {
    service.cancel();
    service.native?.close();
    closeDesktop();
  });
}
