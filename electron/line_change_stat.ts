export interface LineChangeStat {
  added: number;
  removed: number;
}

function lines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

/** Counts a shortest line edit; null means that the display budget was reached. */
export function lineChangeStat(
  before: string,
  after: string,
): LineChangeStat | null {
  if (before === after) {
    return {added: 0, removed: 0};
  }
  const oldLines = lines(before);
  const newLines = lines(after);
  let start = 0;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (
    start < oldEnd &&
    start < newEnd &&
    oldLines[start] === newLines[start]
  ) {
    start++;
  }
  while (
    oldEnd > start &&
    newEnd > start &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  const oldCount = oldEnd - start;
  const newCount = newEnd - start;
  const oldSet = new Set(oldLines.slice(start, oldEnd));
  if (!newLines.slice(start, newEnd).some(line => oldSet.has(line))) {
    return {added: newCount, removed: oldCount};
  }
  const frontier = new Map<number, number>([[1, 0]]);
  let work = 0;
  // Text writes can be large. Optional UI statistics must not stall the agent.
  const maxWork = 200_000;
  for (let distance = 0; distance <= oldCount + newCount; distance++) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      if (++work > maxWork) {
        return null;
      }
      const right = frontier.get(diagonal - 1) || 0;
      const down = frontier.get(diagonal + 1) || 0;
      let x =
        diagonal === -distance || (diagonal !== distance && right < down)
          ? down
          : right + 1;
      let y = x - diagonal;
      while (
        x < oldCount &&
        y < newCount &&
        oldLines[start + x] === newLines[start + y]
      ) {
        if (++work > maxWork) {
          return null;
        }
        x++;
        y++;
      }
      if (x >= oldCount && y >= newCount) {
        return {
          added: (distance + newCount - oldCount) / 2,
          removed: (distance + oldCount - newCount) / 2,
        };
      }
      frontier.set(diagonal, x);
    }
  }
  return null;
}
