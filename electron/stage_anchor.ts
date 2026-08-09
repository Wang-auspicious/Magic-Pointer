(() => {
type AnchorSide = 'left' | 'right';
type UnknownRecord = Record<string, unknown>;

interface AnchorOptions {
  edge?: number;
  gap?: number;
  offset?: number;
}

interface AnchorCandidate {
  quadrant: string;
  x: number;
  y: number;
}

interface AdaptiveAnchorInput {
  edge?: number;
  focus?: unknown;
  gap?: number;
  preferredSide?: unknown;
  source?: unknown;
  surface?: unknown;
  viewport?: unknown;
}

interface StableAnchorInput {
  mode?: unknown;
  options?: AnchorOptions;
  pointer?: unknown;
  previous?: unknown;
  sessionToken?: unknown;
  surface?: unknown;
  target?: unknown;
  viewport?: unknown;
}

function recordOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? (value as UnknownRecord) : null;
}

function finite(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function chooseAdaptivePanelAnchor({
  source = null,
  focus = null,
  surface = null,
  viewport = null,
  preferredSide = null,
  edge = 8,
  gap = 8,
}: AdaptiveAnchorInput = {}) {
  const viewportRect = recordOf(viewport);
  const surfaceRect = recordOf(surface);
  const sourceValue = recordOf(source);
  const focusValue = recordOf(focus);
  const viewWidth = Math.max(0, finite(viewportRect?.width));
  const viewHeight = Math.max(0, finite(viewportRect?.height));
  const width = Math.max(0, finite(surfaceRect?.width));
  const height = Math.max(0, finite(surfaceRect?.height));
  const sourceRect = {
    x: finite(sourceValue?.x),
    y: finite(sourceValue?.y),
    width: Math.max(0, finite(sourceValue?.width)),
    height: Math.max(0, finite(sourceValue?.height)),
  };
  const focusRect = {
    x: finite(focusValue?.x, viewWidth / 2),
    y: finite(focusValue?.y, viewHeight / 2),
    width: Math.max(0, finite(focusValue?.width)),
    height: Math.max(0, finite(focusValue?.height)),
  };
  const leftGutter = sourceRect.x - edge;
  const rightGutter = viewWidth - edge - (sourceRect.x + sourceRect.width);
  const required = width + gap;
  const fits = {
    left: sourceRect.width > 0 && leftGutter >= required,
    right: sourceRect.width > 0 && rightGutter >= required,
  };
  let side: AnchorSide | null = null;
  if ((preferredSide === 'left' || preferredSide === 'right') && fits[preferredSide]) {
    side = preferredSide;
  } else if (fits.left && fits.right) {
    side = rightGutter >= leftGutter ? 'right' : 'left';
  } else if (fits.right) {
    side = 'right';
  } else if (fits.left) {
    side = 'left';
  }
  const maxY = Math.max(edge, viewHeight - edge - height);
  if (side) {
    const desiredY = sourceRect.y + gap;
    return {
      x: Math.round(side === 'right'
        ? sourceRect.x + sourceRect.width + gap
        : sourceRect.x - gap - width),
      y: Math.round(Math.min(maxY, Math.max(edge, desiredY))),
      side,
      mode: 'outside',
    };
  }
  const leftClear = focusRect.x - edge;
  const rightClear = viewWidth - edge - (focusRect.x + focusRect.width);
  side = preferredSide === 'left' || preferredSide === 'right'
    ? preferredSide
    : (rightClear >= leftClear ? 'right' : 'left');
  const desiredY = focusRect.y + ((focusRect.height - height) / 2);
  return {
    x: Math.round(side === 'right' ? Math.max(edge, viewWidth - edge - width) : edge),
    y: Math.round(Math.min(maxY, Math.max(edge, desiredY))),
    side,
    mode: 'screen-edge',
  };
}

function choosePointerAnchor(
  pointer: unknown,
  surface: unknown,
  viewport: unknown,
  { edge = 12, offset = 18 }: AnchorOptions = {},
): AnchorCandidate {
  const pointerRect = recordOf(pointer);
  const surfaceRect = recordOf(surface);
  const viewportRect = recordOf(viewport);
  const x = finite(pointerRect?.x);
  const y = finite(pointerRect?.y);
  const width = Math.max(0, finite(surfaceRect?.width));
  const height = Math.max(0, finite(surfaceRect?.height));
  const viewWidth = Math.max(0, finite(viewportRect?.width));
  const viewHeight = Math.max(0, finite(viewportRect?.height));
  const candidates = [
    { x: x + offset, y: y - offset - height, quadrant: 'top-right' },
    { x: x + offset, y: y + offset, quadrant: 'bottom-right' },
    { x: x - offset - width, y: y - offset - height, quadrant: 'top-left' },
    { x: x - offset - width, y: y + offset, quadrant: 'bottom-left' },
  ];
  const overflow = (candidate: AnchorCandidate): number => (
    Math.max(0, edge - candidate.x)
    + Math.max(0, candidate.x + width - (viewWidth - edge))
    + Math.max(0, edge - candidate.y)
    + Math.max(0, candidate.y + height - (viewHeight - edge))
  );
  const selected = candidates.reduce((best, candidate) => (
    overflow(candidate) < overflow(best) ? candidate : best
  ));
  const maxX = Math.max(edge, viewWidth - edge - width);
  const maxY = Math.max(edge, viewHeight - edge - height);
  return {
    x: Math.round(Math.min(maxX, Math.max(edge, selected.x))),
    y: Math.round(Math.min(maxY, Math.max(edge, selected.y))),
    quadrant: selected.quadrant,
  };
}

function chooseTargetInlineAnchor(
  target: unknown,
  surface: unknown,
  viewport: unknown,
  { edge = 12, gap = 18 }: AnchorOptions = {},
): AnchorCandidate {
  const targetRect = recordOf(target);
  const surfaceRect = recordOf(surface);
  const viewportRect = recordOf(viewport);
  const targetX = finite(targetRect?.x);
  const targetY = finite(targetRect?.y);
  const targetWidth = Math.max(0, finite(targetRect?.width));
  const targetHeight = Math.max(0, finite(targetRect?.height));
  const width = Math.max(0, finite(surfaceRect?.width));
  const height = Math.max(0, finite(surfaceRect?.height));
  const viewWidth = Math.max(0, finite(viewportRect?.width));
  const viewHeight = Math.max(0, finite(viewportRect?.height));
  const centeredY = targetY + ((targetHeight - height) / 2);
  const candidates = [
    {
      x: targetX + targetWidth + gap,
      y: centeredY,
      quadrant: 'inline-right',
    },
    {
      x: targetX - gap - width,
      y: centeredY,
      quadrant: 'inline-left',
    },
    {
      x: targetX + targetWidth - width,
      y: targetY + targetHeight + gap,
      quadrant: 'bottom-right',
    },
    {
      x: targetX + targetWidth - width,
      y: targetY - gap - height,
      quadrant: 'top-right',
    },
  ];
  const overflow = (candidate: AnchorCandidate): number => (
    Math.max(0, edge - candidate.x)
    + Math.max(0, candidate.x + width - (viewWidth - edge))
    + Math.max(0, edge - candidate.y)
    + Math.max(0, candidate.y + height - (viewHeight - edge))
  );
  const selected = candidates.reduce((best, candidate) => (
    overflow(candidate) < overflow(best) ? candidate : best
  ));
  const maxX = Math.max(edge, viewWidth - edge - width);
  const maxY = Math.max(edge, viewHeight - edge - height);
  return {
    x: Math.round(Math.min(maxX, Math.max(edge, selected.x))),
    y: Math.round(Math.min(maxY, Math.max(edge, selected.y))),
    quadrant: selected.quadrant,
  };
}

function chooseStableCapsuleAnchor({
  previous = null,
  sessionToken = null,
  mode = 'target',
  pointer = null,
  target = null,
  surface = null,
  viewport = null,
  options = {},
}: StableAnchorInput = {}): UnknownRecord {
  const token = sessionToken == null ? null : String(sessionToken);
  const previousAnchor = recordOf(previous);
  if (
    mode === 'pointer'
    && previousAnchor
    && previousAnchor.mode === 'pointer'
    && previousAnchor.sessionToken === token
  ) {
    return previousAnchor;
  }
  const placement = mode === 'target' && target
    ? chooseTargetInlineAnchor(target, surface, viewport, options)
    : choosePointerAnchor(pointer, surface, viewport, options);
  return Object.freeze({
    ...placement,
    mode: mode === 'pointer' ? 'pointer' : 'target',
    sessionToken: token,
  });
}

const StageAnchor = {
  chooseAdaptivePanelAnchor,
  choosePointerAnchor,
  chooseTargetInlineAnchor,
  chooseStableCapsuleAnchor,
};
if (typeof module !== 'undefined' && module.exports) module.exports = StageAnchor;
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { StageAnchor?: typeof StageAnchor }).StageAnchor = StageAnchor;
}
})();
