function physicalScreenPoint(screenApi, dipPoint) {
  if (!screenApi || typeof screenApi.dipToScreenPoint !== 'function') return null;
  const x = Number(dipPoint?.x);
  const y = Number(dipPoint?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  try {
    const point = screenApi.dipToScreenPoint({ x, y });
    const px = Number(point?.x);
    const py = Number(point?.y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
    return { x: Math.round(px), y: Math.round(py) };
  } catch (_) {
    return null;
  }
}

module.exports = { physicalScreenPoint };
