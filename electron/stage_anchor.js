function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function choosePointerAnchor(pointer, surface, viewport, { edge = 12, offset = 18 } = {}) {
  const x = finite(pointer?.x);
  const y = finite(pointer?.y);
  const width = Math.max(0, finite(surface?.width));
  const height = Math.max(0, finite(surface?.height));
  const viewWidth = Math.max(0, finite(viewport?.width));
  const viewHeight = Math.max(0, finite(viewport?.height));
  const candidates = [
    { x: x + offset, y: y - offset - height, quadrant: 'top-right' },
    { x: x + offset, y: y + offset, quadrant: 'bottom-right' },
    { x: x - offset - width, y: y - offset - height, quadrant: 'top-left' },
    { x: x - offset - width, y: y + offset, quadrant: 'bottom-left' },
  ];
  const overflow = (candidate) => (
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

function chooseTargetInlineAnchor(target, surface, viewport, { edge = 12, gap = 18 } = {}) {
  const targetX = finite(target?.x);
  const targetY = finite(target?.y);
  const targetWidth = Math.max(0, finite(target?.width));
  const targetHeight = Math.max(0, finite(target?.height));
  const width = Math.max(0, finite(surface?.width));
  const height = Math.max(0, finite(surface?.height));
  const viewWidth = Math.max(0, finite(viewport?.width));
  const viewHeight = Math.max(0, finite(viewport?.height));
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
  const overflow = (candidate) => (
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
} = {}) {
  const token = sessionToken == null ? null : String(sessionToken);
  if (
    mode === 'pointer'
    && previous
    && previous.mode === 'pointer'
    && previous.sessionToken === token
  ) {
    return previous;
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
  choosePointerAnchor,
  chooseTargetInlineAnchor,
  chooseStableCapsuleAnchor,
};
if (typeof module !== 'undefined' && module.exports) module.exports = StageAnchor;
if (typeof globalThis !== 'undefined') globalThis.StageAnchor = StageAnchor;
