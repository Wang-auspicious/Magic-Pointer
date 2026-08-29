'use strict';

/* Hermes「drive 回放」的屏幕策略：结构化元素句柄 → 屏幕上的框+标签。
 *
 * 输入是快照桥 artifacts.element_handles（物理屏幕像素 xywh）；输出是
 * 某一块显示器本地的 DIP 矩形 + 错峰延迟。太小/出屏的框直接丢——
 * 自绘应用没有句柄时返回空数组，不造假框。
 */

export interface GhostRect { x: number; y: number; width: number; height: number }
export interface ElementGhost { ref: string; label: string; role: string; rect: GhostRect; delayMs: number }
export interface GhostReplay {
  ghosts: ElementGhost[];
  holdMs: number;
  fadeMs: number;
  staggerMs: number;
}

const MAX_GHOSTS = 18;
const HOLD_MS = 1000;
const FADE_MS = 600;
const STAGGER_MS = 45;
const MIN_SIZE = 6;

function usableRect(rect: unknown, displayBounds: { x: number; y: number; width: number; height: number }, scale: number): GhostRect | null {
  if (!Array.isArray(rect) || rect.length !== 4) return null;
  const [px, py, pw, ph] = rect.map((value) => Number(value));
  if (![px, py, pw, ph].every((value) => Number.isFinite(value))) return null;
  if (pw < MIN_SIZE || ph < MIN_SIZE) return null;
  const localX = (px - displayBounds.x) / scale;
  const localY = (py - displayBounds.y) / scale;
  const width = pw / scale;
  const height = ph / scale;
  if (localX + width <= 0 || localY + height <= 0) return null;
  if (localX >= displayBounds.width || localY >= displayBounds.height) return null;
  // 盖住大半块屏幕的框（如 Chromium 的 RootWebArea 容器）不是可指认的
  // 元素，画出来只是一张全屏罩子——丢弃。
  const displayArea = displayBounds.width * displayBounds.height;
  if (width * height > displayArea * 0.7) return null;
  return {
    x: Math.round(localX),
    y: Math.round(localY),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function buildElementGhosts({
  handles,
  displayBounds,
  scaleFactor,
}: {
  handles: Array<Record<string, unknown>>;
  displayBounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}): GhostReplay {
  const scale = scaleFactor > 0 ? scaleFactor : 1;
  const ghosts: ElementGhost[] = [];
  for (const handle of Array.isArray(handles) ? handles : []) {
    if (ghosts.length >= MAX_GHOSTS) break;
    if (!handle || typeof handle !== 'object') continue;
    const rect = usableRect((handle as { rect?: unknown }).rect, displayBounds, scale);
    if (!rect) continue;
    const ref = String((handle as { ref?: unknown }).ref || '');
    if (!ref) continue;
    ghosts.push({
      ref,
      label: String((handle as { name?: unknown }).name || '').trim() || ref,
      role: String((handle as { role?: unknown }).role || ''),
      rect,
      delayMs: ghosts.length * STAGGER_MS,
    });
  }
  return { ghosts, holdMs: HOLD_MS, fadeMs: FADE_MS, staggerMs: STAGGER_MS };
}

module.exports = { buildElementGhosts };
