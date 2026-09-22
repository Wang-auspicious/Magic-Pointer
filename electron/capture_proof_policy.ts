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


const MAX_PROOF_RECTS = 12;

const MIN_PROOF_EDGE_PX = 6;

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

function inReadingOrder(left: ProofBand, right: ProofBand): number {
  const sameRow = Math.abs(left.rect.y - right.rect.y) < Math.max(left.rect.height, right.rect.height) * 0.6;
  if (sameRow) return left.rect.x - right.rect.x;
  return left.rect.y - right.rect.y;
}

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

function proofSummary(bands: unknown): string {
  if (!Array.isArray(bands) || bands.length === 0) return '';
  const exact = bands.filter((value: unknown) => recordOf(value)?.source !== 'pixel').length;
  const seen = bands.length - exact;
  if (exact && seen) return `读到 ${exact} 处，另有 ${seen} 处是从画面上认出来的`;
  if (exact) return exact === 1 ? '读到 1 处' : `读到 ${exact} 处`;
  return seen === 1 ? '从画面上认出 1 处' : `从画面上认出 ${seen} 处`;
}

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
