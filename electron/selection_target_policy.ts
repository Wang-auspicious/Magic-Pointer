'use strict';

export interface SelectionTargetSource {
  foregroundApp: string;
  foregroundHwnd: number;
  foregroundProcessId: number;
}

export function resolveSelectionTargetSource(input: {
  live?: {
    foregroundApp?: unknown;
    foregroundHwnd?: unknown;
    foregroundProcessId?: unknown;
  } | null;
  lastStable?: {
    app?: unknown;
    hwnd?: unknown;
    process_id?: unknown;
    pid?: unknown;
  } | null;
  selfPid: number;
  isTransient?: (processName: string) => boolean;
}): SelectionTargetSource {
  const liveApp = String(input.live?.foregroundApp || '').trim();
  const liveHwnd = Number(input.live?.foregroundHwnd || 0);
  const livePid = Number(input.live?.foregroundProcessId || 0);
  const isSelfOrTransient = (app: string, pid: number) =>
    (pid > 0 && pid === input.selfPid) ||
    !app ||
    Boolean(input.isTransient?.(app));

  if (liveHwnd > 0 && livePid > 0 && !isSelfOrTransient(liveApp, livePid)) {
    return {
      foregroundApp: liveApp,
      foregroundHwnd: liveHwnd,
      foregroundProcessId: livePid,
    };
  }

  const stableApp = String(input.lastStable?.app || '').trim();
  const stableHwnd = Number(input.lastStable?.hwnd || 0);
  const stablePid = Number(
    input.lastStable?.process_id ?? input.lastStable?.pid ?? 0,
  );
  if (
    stableHwnd > 0 &&
    stablePid > 0 &&
    !isSelfOrTransient(stableApp, stablePid)
  ) {
    return {
      foregroundApp: stableApp,
      foregroundHwnd: stableHwnd,
      foregroundProcessId: stablePid,
    };
  }

  return {
    foregroundApp: 'desktop',
    foregroundHwnd: 0,
    foregroundProcessId: 0,
  };
}

export function extractSnapshotImagePath(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== 'object') {
    return '';
  }
  const snap = snapshot as Record<string, unknown>;
  const leaseA = snap.frame_lease as Record<string, unknown> | undefined;
  const leaseB = snap.frameLease as Record<string, unknown> | undefined;
  const artifactA = leaseA?.localArtifact as Record<string, unknown> | undefined;
  const artifactB = leaseB?.localArtifact as Record<string, unknown> | undefined;
  const candidates = [
    snap.selection_crop_path,
    snap.capture_path,
    snap.screenshot_path,
    artifactA?.path,
    artifactB?.path,
    leaseA?.framePath,
    leaseB?.framePath,
  ];
  for (const item of candidates) {
    if (typeof item === 'string' && item.trim()) {
      return item.trim();
    }
  }
  return '';
}

export function shouldQueueEarlyGesture(
  captureReady: boolean,
  payload?: {points?: unknown[]; strokes?: unknown[]; captureState?: unknown} | null,
): boolean {
  if (captureReady && payload?.captureState !== 'preparing') {
    return false;
  }
  const hasPoints =
    Array.isArray(payload?.points) && payload!.points.length > 0;
  const hasStrokes =
    Array.isArray(payload?.strokes) && payload!.strokes.length > 0;
  return hasPoints || hasStrokes;
}

module.exports = {
  extractSnapshotImagePath,
  resolveSelectionTargetSource,
  shouldQueueEarlyGesture,
};
