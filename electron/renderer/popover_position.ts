'use strict';

interface PopoverRectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface PopoverSizeLike {
  width: number;
  height: number;
}

interface PopoverViewportLike {
  width: number;
  height: number;
}

function clampPopoverCoordinate(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function placePopover(
  trigger: PopoverRectLike,
  popup: PopoverSizeLike,
  viewport: PopoverViewportLike,
): { left: number; top: number } {
  const margin = 12;
  const gap = 4;
  const width = Math.max(1, Number(popup.width) || 1);
  const height = Math.max(1, Number(popup.height) || 1);
  const maxLeft = Math.max(margin, Number(viewport.width) - margin - width);
  const maxTop = Math.max(margin, Number(viewport.height) - margin - height);
  const left = clampPopoverCoordinate(Number(trigger.right) - width, margin, maxLeft);
  const above = Number(trigger.top) - gap - height;
  const preferredTop = above >= margin ? above : Number(trigger.bottom) + gap;
  const top = clampPopoverCoordinate(preferredTop, margin, maxTop);
  return { left: Math.round(left), top: Math.round(top) };
}

const PopoverPosition = { placePopover };
if (typeof module !== 'undefined' && module.exports) module.exports = PopoverPosition;
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { PopoverPosition?: typeof PopoverPosition }).PopoverPosition = PopoverPosition;
}
