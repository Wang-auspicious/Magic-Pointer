'use strict';

// FrameLease v1: the immutable "what the user saw at pointerup" contract.
// Shared verbatim with scripts/frame_lease.py — the two validators must agree
// on every field, accepted source and geometry requirement. A lease created
// here can never be re-pointed at a later image.

type CaptureSource = 'wgc-window' | 'wgc-display' | 'dxgi-display' | 'gdi-fallback' | 'test';

interface WindowIdentity {
  hwnd: number;
  processId: number;
  processName: string;
  title: string;
}

interface FrameArtifactRef {
  path: string;
  mimeType: string;
  width: number;
  height: number;
}

interface GestureGeometry {
  coordinateSpace?: string;
  strokes?: unknown[];
  [key: string]: unknown;
}

interface FrameLease {
  schemaVersion: 1;
  frameLeaseId: string;
  epochId: string;
  capturedAtMonotonicMs: number;
  capturedAtUtc: string;
  source: CaptureSource;
  targetWindow: WindowIdentity;
  surfaceBoundsPx: [number, number, number, number];
  displayId: string;
  scaleFactor: number;
  gesture: GestureGeometry;
  localArtifact: FrameArtifactRef;
  contentHash: string;
  overlayExcluded: boolean;
  captureLatencyMs: number;
}

type UnknownRecord = Record<string, unknown>;

const ALLOWED_SOURCES: ReadonlySet<string> = new Set([
  'wgc-window',
  'wgc-display',
  'dxgi-display',
  'gdi-fallback',
  'test',
]);

const REQUIRED_FIELDS = [
  'frameLeaseId',
  'epochId',
  'capturedAtMonotonicMs',
  'capturedAtUtc',
  'source',
  'targetWindow',
  'surfaceBoundsPx',
  'displayId',
  'scaleFactor',
  'gesture',
  'localArtifact',
  'contentHash',
  'overlayExcluded',
  'captureLatencyMs',
] as const;

function recordOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function fail(message: string): never {
  throw new TypeError(message);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string`);
  return value;
}

function requireFiniteNonNegative(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) fail(`${field} must be a finite non-negative number`);
  return number;
}

function blankField(entry: unknown): boolean {
  if (entry === undefined || entry === null) return true;
  if (typeof entry === 'string') return entry.trim() === '';
  if (typeof entry === 'number') return !Number.isFinite(entry);
  if (typeof entry === 'boolean') return false;
  if (Array.isArray(entry)) return entry.length === 0;
  if (typeof entry === 'object') return false;
  return true;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as UnknownRecord)) deepFreeze(child);
  return Object.freeze(value);
}

function validateWindowIdentity(value: unknown): WindowIdentity {
  const record = recordOf(value);
  if (record === null) fail('targetWindow must be an object');
  const hwnd = requireFiniteNonNegative(record.hwnd, 'targetWindow.hwnd');
  const processId = requireFiniteNonNegative(record.processId, 'targetWindow.processId');
  const processName = requireNonEmptyString(record.processName, 'targetWindow.processName');
  const title = typeof record.title === 'string' ? record.title : '';
  return { hwnd, processId, processName, title };
}

function validateSurfaceBounds(value: unknown): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) {
    fail('surfaceBoundsPx must be [left, top, right, bottom]');
  }
  const numbers = value.map((entry) => Number(entry));
  if (!numbers.every(Number.isFinite)) fail('surfaceBoundsPx must contain finite numbers');
  const [left, top, right, bottom] = numbers as [number, number, number, number];
  if (right - left <= 0 || bottom - top <= 0) fail('surfaceBoundsPx must have positive area');
  return [left, top, right, bottom];
}

function validateArtifact(value: unknown): FrameArtifactRef {
  const record = recordOf(value);
  if (record === null) fail('localArtifact must be an object');
  const path = requireNonEmptyString(record.path, 'localArtifact.path');
  const mimeType = requireNonEmptyString(record.mimeType, 'localArtifact.mimeType');
  const width = requireFiniteNonNegative(record.width, 'localArtifact.width');
  const height = requireFiniteNonNegative(record.height, 'localArtifact.height');
  if (width <= 0 || height <= 0) fail('localArtifact.width/height must be positive');
  return { path, mimeType, width, height };
}

function validateGesture(value: unknown): GestureGeometry {
  const record = recordOf(value);
  if (record === null) fail('gesture must be an object');
  return { ...record };
}

function validateFrameLease(value: unknown): FrameLease {
  const candidate = recordOf(value);
  if (candidate === null) fail('frameLease must be an object');
  if (Number(candidate.schemaVersion) !== 1) fail('schemaVersion must be 1');
  const missing = REQUIRED_FIELDS.filter((field) => blankField(candidate[field]));
  if (missing.length) fail(`missing frame lease field(s): ${missing.join(', ')}`);
  const source = requireNonEmptyString(candidate.source, 'source');
  if (!ALLOWED_SOURCES.has(source)) fail(`source must be one of ${[...ALLOWED_SOURCES].join('|')}`);
  const scaleFactor = requireFiniteNonNegative(candidate.scaleFactor, 'scaleFactor');
  if (scaleFactor <= 0) fail('scaleFactor must be positive');
  return deepFreeze({
    schemaVersion: 1,
    frameLeaseId: requireNonEmptyString(candidate.frameLeaseId, 'frameLeaseId'),
    epochId: requireNonEmptyString(candidate.epochId, 'epochId'),
    capturedAtMonotonicMs: requireFiniteNonNegative(
      candidate.capturedAtMonotonicMs,
      'capturedAtMonotonicMs',
    ),
    capturedAtUtc: requireNonEmptyString(candidate.capturedAtUtc, 'capturedAtUtc'),
    source: source as CaptureSource,
    targetWindow: validateWindowIdentity(candidate.targetWindow),
    surfaceBoundsPx: validateSurfaceBounds(candidate.surfaceBoundsPx),
    displayId: requireNonEmptyString(candidate.displayId, 'displayId'),
    scaleFactor,
    gesture: validateGesture(candidate.gesture),
    localArtifact: validateArtifact(candidate.localArtifact),
    contentHash: requireNonEmptyString(candidate.contentHash, 'contentHash'),
    overlayExcluded: candidate.overlayExcluded === true,
    captureLatencyMs: requireFiniteNonNegative(candidate.captureLatencyMs, 'captureLatencyMs'),
  });
}

function cloneFrameLease(value: FrameLease): FrameLease {
  return validateFrameLease(JSON.parse(JSON.stringify(value)));
}

module.exports = { validateFrameLease, cloneFrameLease };
