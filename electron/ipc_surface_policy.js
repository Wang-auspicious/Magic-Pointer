function isSurfaceSender(event, surface, resolveWindow) {
  if (!event || typeof resolveWindow !== 'function') return false;
  const win = resolveWindow(surface);
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
  return Boolean(win.webContents && event.sender === win.webContents);
}

module.exports = { isSurfaceSender };
