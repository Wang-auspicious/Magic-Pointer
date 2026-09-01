(() => {
type SurfaceRole = 'composer' | 'work-panel';
type SurfaceSize = Readonly<{ width: number; height: number }>;
type UnknownRecord = Record<string, unknown>;

interface StableSurfaceInput {
  previous?: unknown;
  sessionToken?: unknown;
  role: SurfaceRole;
  viewport?: unknown;
  place: (size: SurfaceSize) => UnknownRecord;
}

const COMPOSER_SIZE = Object.freeze({ width: 480, height: 132 });
// The work surface is a compact activity card, not a second application
// window. 440×300 keeps a full answer readable while removing the large blank
// canvas that made one-step tasks feel stalled and visually heavy.
const WORK_PANEL_SIZE = Object.freeze({ width: 440, height: 300 });

function recordOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? value as UnknownRecord : null;
}

function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function surfaceSize(role: SurfaceRole, viewport: unknown): SurfaceSize {
  const desired = role === 'composer' ? COMPOSER_SIZE : WORK_PANEL_SIZE;
  const view = recordOf(viewport);
  const availableWidth = Math.max(0, finite(view?.width) - 16);
  const availableHeight = Math.max(0, finite(view?.height) - 16);
  return Object.freeze({
    width: Math.min(desired.width, availableWidth),
    height: Math.min(desired.height, availableHeight),
  });
}

function stableSurfacePlacement({
  previous = null,
  sessionToken = null,
  role,
  viewport = null,
  place,
}: StableSurfaceInput) {
  const token = sessionToken == null ? null : String(sessionToken);
  const view = recordOf(viewport);
  const viewportWidth = finite(view?.width);
  const viewportHeight = finite(view?.height);
  const prior = recordOf(previous);
  if (
    prior
    && prior.sessionToken === token
    && prior.role === role
    && prior.viewportWidth === viewportWidth
    && prior.viewportHeight === viewportHeight
  ) return previous;

  const size = surfaceSize(role, viewport);
  return Object.freeze({
    ...place(size),
    ...size,
    role,
    sessionToken: token,
    viewportWidth,
    viewportHeight,
  });
}

const StageSurfacePolicy = {
  COMPOSER_SIZE,
  WORK_PANEL_SIZE,
  surfaceSize,
  stableSurfacePlacement,
};
if (typeof module !== 'undefined' && module.exports) module.exports = StageSurfacePolicy;
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { StageSurfacePolicy?: typeof StageSurfacePolicy }).StageSurfacePolicy = StageSurfacePolicy;
}
})();
