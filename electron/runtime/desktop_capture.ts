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
    if (this.epoch) {
      this.cancel();
    } else {
      this.clearEpoch();
    }
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
    if (this.native) {
      void this.native.cancel(String(cancelledEpoch || '')).catch(error => {
        process.stderr.write(`capture: WGC cancel failed: ${String(error)}\n`);
      });
    }
    this.clearEpoch();
  }
  private clearEpoch(): void {
    this.generation++;
    this.nativeActive = false;
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
      let committed = false;
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
        committed = true;
      } finally {
        if (committed && this.epoch === epoch) {
          this.clearEpoch();
        } else {
          this.cancel(String(epoch.epochId));
        }
      }
    }
    this.cancel(String(epoch.epochId));
    if (!frame) {
      throw new Error('no_frame_buffered');
    }
    const resolved = await windowAtArm;
    const window = resolveCommitTargetWindow(
      epoch.targetWindow ?? null,
      resolved ?? null,
      extractEpochDisplayBounds(
        epoch as unknown as Record<string, unknown>,
        frame,
      ),
    );
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

export interface CommitTargetWindowInput {
  hwnd: number;
  processId: number;
  processName: string;
  title: string;
  bbox?: [number, number, number, number];
  processStartTime?: string;
}

export interface ResolvedArmWindowInput {
  hwnd?: number;
  pid?: number;
  processId?: number;
  processName?: string;
  processStartTime?: string;
  title?: string;
  bbox?: [number, number, number, number];
}

function hasPositiveAreaBbox(
  bbox: unknown,
): bbox is [number, number, number, number] {
  return (
    Array.isArray(bbox) &&
    bbox.length === 4 &&
    bbox.every(value => typeof value === 'number' && Number.isFinite(value)) &&
    bbox[2] > bbox[0] &&
    bbox[3] > bbox[1]
  );
}

function extractEpochDisplayBounds(
  epoch: Record<string, unknown>,
  frame?: {width?: number; height?: number},
): [number, number, number, number] {
  if (hasPositiveAreaBbox(epoch.surfaceBoundsPx)) {
    return epoch.surfaceBoundsPx;
  }
  const frameW = Number(frame?.width ?? 0);
  const frameH = Number(frame?.height ?? 0);
  if (Number.isFinite(frameW) && Number.isFinite(frameH) && frameW > 0 && frameH > 0) {
    return [0, 0, frameW, frameH];
  }
  return [0, 0, 1920, 1080];
}

export function resolveCommitTargetWindow(
  targetWindow: CommitTargetWindowInput | null | undefined,
  resolved: ResolvedArmWindowInput | null | undefined,
  fallbackBounds: [number, number, number, number] = [0, 0, 1920, 1080],
  excludedPid?: number,
): CommitTargetWindowInput & {bbox: [number, number, number, number]} {
  const targetHwnd = Number(targetWindow?.hwnd ?? 0);
  const targetPid = Number(targetWindow?.processId ?? 0);
  const resolvedPid = Number(resolved?.pid ?? resolved?.processId ?? 0);
  const resolvedHwnd = Number(resolved?.hwnd ?? 0);
  const resolvedIsExcluded =
    (excludedPid && resolvedPid === excludedPid) ||
    /magic ?pointer/i.test(String(resolved?.processName || resolved?.title || ''));
  const targetIsExcluded =
    (excludedPid && targetPid === excludedPid) ||
    /magic ?pointer/i.test(String(targetWindow?.processName || targetWindow?.title || ''));
  if (resolvedIsExcluded || targetIsExcluded) {
    const cleanBounds = hasPositiveAreaBbox(fallbackBounds)
      ? fallbackBounds
      : [0, 0, 1920, 1080];
    return {
      hwnd: 0,
      processId: 0,
      processName: 'desktop',
      title: 'Screen',
      bbox: cleanBounds as [number, number, number, number],
    };
  }
  const sameTarget = Boolean(
    resolved &&
      ((targetHwnd === 0 && targetPid === 0) ||
        (resolvedHwnd === targetHwnd && resolvedPid === targetPid)),
  );
  const bbox: [number, number, number, number] =
    sameTarget && hasPositiveAreaBbox(resolved?.bbox)
      ? resolved.bbox
      : hasPositiveAreaBbox(targetWindow?.bbox)
        ? targetWindow.bbox
        : hasPositiveAreaBbox(fallbackBounds)
          ? fallbackBounds
          : [0, 0, 1920, 1080];
  const processName =
    (sameTarget ? String(resolved?.processName || '').trim() : '') ||
    String(targetWindow?.processName || '').trim() ||
    (sameTarget ? String(resolved?.title || '').trim() : '') ||
    String(targetWindow?.title || '').trim() ||
    'desktop';
  const title =
    (sameTarget ? String(resolved?.title || '').trim() : '') ||
    String(targetWindow?.title || '').trim();
  const processStartTime =
    (sameTarget ? resolved?.processStartTime : undefined) ??
    targetWindow?.processStartTime;
  return {
    hwnd: sameTarget && resolvedHwnd > 0 ? resolvedHwnd : targetHwnd,
    processId: sameTarget && resolvedPid > 0 ? resolvedPid : targetPid,
    processName,
    title,
    bbox,
    ...(processStartTime ? {processStartTime} : {}),
  };
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
