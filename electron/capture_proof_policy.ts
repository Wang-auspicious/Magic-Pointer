'use strict';

(() => {
type ProofSource = 'pixel' | 'structured' | 'text_range';
type UnknownRecord = Record<string, unknown>;

interface Point {
  x: number;
  y: number;
}

interface ProofRect extends Point {
  height: number;
  width: number;
}

interface ProofBand {
  rect: ProofRect;
  source: ProofSource;
}

interface StageMappingOptions {
  origin?: Point;
  scaleFactor?: number;
}

// Prove what was picked up, by drawing a band around it.
//
// The user's words on 2026-08-05: "UIA一定是能读到的直接在他外部搞个那种跑一圈的
// 亮色带，证明拿到了。" They are right that a claim is worth much less than a
// band drawn around the actual words — and right that this doubles as the best
// debugging surface we have. When the wrong thing lights up, you can see it.
//
// The rectangles come from three different places and they do not mean the same
// thing:
//
//   structured   a UI Automation element. We know the text exactly, character
//                for character, because the app told us.
//   text_range   a TextPattern line range. Also exact, but resolved by position
//                inside one big text surface (a terminal buffer).
//   pixel        an OCR block. We recognised it from a picture. It can be wrong,
//                and on a bad font or a moving window it will be.
//
// Painting all three identically would make "I know" and "I think I can read
// that" look the same, which is the specific dishonesty this whole feature
// exists to avoid. Each source gets its own band treatment; the renderer keys
// off `source`.
//
// Pure: rectangles in, rectangles out. No DOM, no IPC — so the rules are
// arguable in a test rather than on a live desktop.

// More bands than this stops reading as "these are the words" and starts reading
// as noise. An underline crossing a dozen OCR blocks is already unusual.
const MAX_PROOF_RECTS = 12;

// Below this a band is a rendering artefact rather than a target. OCR happily
// emits 3px slivers for punctuation.
const MIN_PROOF_EDGE_PX = 6;

// Two rectangles within this many pixels on every edge are the same thing seen
// twice — the structured layer and OCR both reporting one line, typically.
const DEDUPE_TOLERANCE_PX = 4;

const SOURCE_RANK: Readonly<Record<ProofSource, number>> = {
  structured: 0,
  text_range: 1,
  pixel: 2,
};

function recordOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' ? (value as UnknownRecord) : null;
}

function toRect(value: unknown): ProofRect | null {
  if (Array.isArray(value) && value.length === 4) {
    const [x, y, width, height] = value.map(Number);
    return { x, y, width, height };
  }
  const candidate = recordOf(value);
  if (candidate !== null) {
    return {
      x: Number(candidate.x),
      y: Number(candidate.y),
      width: Number(candidate.width),
      height: Number(candidate.height),
    };
  }
  return null;
}

function isUsable(rect: ProofRect | null): rect is ProofRect {
  return rect !== null
    && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width >= MIN_PROOF_EDGE_PX
    && rect.height >= MIN_PROOF_EDGE_PX;
}

function isSameRect(a: ProofRect, b: ProofRect): boolean {
  return Math.abs(a.x - b.x) <= DEDUPE_TOLERANCE_PX
    && Math.abs(a.y - b.y) <= DEDUPE_TOLERANCE_PX
    && Math.abs(a.width - b.width) <= DEDUPE_TOLERANCE_PX
    && Math.abs(a.height - b.height) <= DEDUPE_TOLERANCE_PX;
}

// Reading order, so the bands animate the way eyes move: down the page, then
// across. Rows are banded by vertical overlap rather than exact y, because OCR
// baselines on one line differ by a pixel or two.
function inReadingOrder(left: ProofBand, right: ProofBand): number {
  const sameRow = Math.abs(left.rect.y - right.rect.y) < Math.max(left.rect.height, right.rect.height) * 0.6;
  if (sameRow) return left.rect.x - right.rect.x;
  return left.rect.y - right.rect.y;
}

// Build the bands to draw from whatever the perception layers reported.
//
// `input.structured` / `input.textRange` / `input.pixel` are arrays of rects in
// physical screen pixels. A rectangle reported by more than one layer is kept
// once, at its most trustworthy source: being able to read something exactly
// does not become less true because OCR also saw it.
function captureProof(input: unknown): ProofBand[] {
  const candidate = recordOf(input);
  const groups: Array<readonly [ProofSource, unknown[]]> = [
    ['structured', Array.isArray(candidate?.structured) ? candidate.structured : []],
    ['text_range', Array.isArray(candidate?.textRange) ? candidate.textRange : []],
    ['pixel', Array.isArray(candidate?.pixel) ? candidate.pixel : []],
  ];
  const kept: ProofBand[] = [];
  for (const [source, values] of groups) {
    for (const value of values) {
      const rect = toRect(value);
      if (!isUsable(rect)) continue;
      const duplicate = kept.find((item) => isSameRect(item.rect, rect));
      if (duplicate) {
        if (SOURCE_RANK[source] < SOURCE_RANK[duplicate.source]) duplicate.source = source;
        continue;
      }
      kept.push({ rect, source });
      if (kept.length >= MAX_PROOF_RECTS) break;
    }
    if (kept.length >= MAX_PROOF_RECTS) break;
  }
  kept.sort(inReadingOrder);
  return kept;
}

// One line for the bubble, in the user's terms. Not "uia:region-elements".
function proofSummary(bands: unknown): string {
  if (!Array.isArray(bands) || bands.length === 0) return '';
  const exact = bands.filter((value: unknown) => recordOf(value)?.source !== 'pixel').length;
  const seen = bands.length - exact;
  if (exact && seen) return `读到 ${exact} 处，另有 ${seen} 处是从画面上认出来的`;
  if (exact) return exact === 1 ? '读到 1 处' : `读到 ${exact} 处`;
  return seen === 1 ? '从画面上认出 1 处' : `从画面上认出 ${seen} 处`;
}

// Screen pixels to the stage window's own DIP coordinates. The bands are drawn
// by a renderer that knows nothing about monitors or scale factors.
function toStageRects(
  bands: readonly ProofBand[],
  { origin = { x: 0, y: 0 }, scaleFactor = 1 }: StageMappingOptions = {},
): ProofBand[] {
  const scale = Number(scaleFactor) > 0 ? Number(scaleFactor) : 1;
  return bands.map((band) => ({
    source: band.source,
    rect: {
      x: Math.round((band.rect.x - origin.x) / scale),
      y: Math.round((band.rect.y - origin.y) / scale),
      width: Math.max(1, Math.round(band.rect.width / scale)),
      height: Math.max(1, Math.round(band.rect.height / scale)),
    },
  }));
}

const CaptureProofPolicy = {
  DEDUPE_TOLERANCE_PX,
  MAX_PROOF_RECTS,
  MIN_PROOF_EDGE_PX,
  captureProof,
  proofSummary,
  toStageRects,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CaptureProofPolicy;
}
if (typeof globalThis !== 'undefined') {
  (globalThis as typeof globalThis & { CaptureProofPolicy?: typeof CaptureProofPolicy })
    .CaptureProofPolicy = CaptureProofPolicy;
}
})();
