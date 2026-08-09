function finite(value, fallback = 0) {
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
} = {}) {
  const viewWidth = Math.max(0, finite(viewport?.width));
  const viewHeight = Math.max(0, finite(viewport?.height));
  const width = Math.max(0, finite(surface?.width));
  const height = Math.max(0, finite(surface?.height));
  const sourceRect = {
    x: finite(source?.x),
    y: finite(source?.y),
    width: Math.max(0, finite(source?.width)),
    height: Math.max(0, finite(source?.height)),
  };
  const focusRect = {
    x: finite(focus?.x, viewWidth / 2),
    y: finite(focus?.y, viewHeight / 2),
    width: Math.max(0, finite(focus?.width)),
    height: Math.max(0, finite(focus?.height)),
  };
  const leftGutter = sourceRect.x - edge;
  const rightGutter = viewWidth - edge - (sourceRect.x + sourceRect.width);
  const required = width + gap;
  const fits = {
    left: sourceRect.width > 0 && leftGutter >= required,
    right: sourceRect.width > 0 && rightGutter >= required,
  };
  let side = null;
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
  chooseAdaptivePanelAnchor,
  choosePointerAnchor,
  chooseTargetInlineAnchor,
  chooseStableCapsuleAnchor,
};
if (typeof module !== 'undefined' && module.exports) module.exports = StageAnchor;
if (typeof globalThis !== 'undefined') globalThis.StageAnchor = StageAnchor;
