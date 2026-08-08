type SenderEvent = { sender?: unknown } | null | undefined;
type SurfaceWindow =
  | {
      isDestroyed?: () => boolean;
      webContents?: unknown;
    }
  | null
  | undefined;

function isSurfaceSender(
  event: SenderEvent,
  surface: string,
  resolveWindow: (surface: string) => SurfaceWindow,
): boolean {
  if (!event || typeof resolveWindow !== 'function') return false;
  const win = resolveWindow(surface);
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
  return Boolean(win.webContents && event.sender === win.webContents);
}

module.exports = { isSurfaceSender };
