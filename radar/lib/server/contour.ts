/**
 * Marching squares — turns a grid of numbers into isolines.
 *
 * This is the one algorithm that makes pressure charts possible, and because
 * it works on any grid it also gives contours of temperature, humidity or
 * anything else in FIELD_PARAMS for free.
 *
 * HOW IT WORKS, BRIEFLY
 *
 * For a given level (say 1012 hPa), look at each square of four neighbouring
 * grid points and ask which corners are above that level. There are sixteen
 * possible answers, and each one tells you which edges of the square the
 * contour crosses. Interpolate along those edges to find exactly where, join
 * the segments up, and you have the line.
 *
 * A NOTE ON THE SADDLE CASE
 *
 * Two of the sixteen cases are ambiguous: diagonally opposite corners above
 * the level, the other two below. The contour could join up two different
 * ways and both are geometrically valid. This resolves it by comparing the
 * average of the four corners against the level — the standard approach, and
 * the one that keeps a closed low or high looking like a closed system
 * rather than pinching into an hourglass.
 */

export interface ContourSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ContourLine {
  /** The value this line traces. */
  level: number;
  /** Joined-up points in grid coordinates. */
  points: { x: number; y: number }[];
}

/** Where along an edge the contour crosses, between two corner values. */
function lerp(level: number, a: number, b: number): number {
  if (a === b) return 0.5;
  return (level - a) / (b - a);
}

/**
 * Extracts contour segments at one level.
 * Grid coordinates: x runs 0..cols-1, y runs 0..rows-1.
 */
export function marchingSquares(
  values: (number | null)[],
  cols: number,
  rows: number,
  level: number
): ContourSegment[] {
  const segments: ContourSegment[] = [];

  for (let y = 0; y < rows - 1; y++) {
    for (let x = 0; x < cols - 1; x++) {
      // Corners: top-left, top-right, bottom-right, bottom-left.
      const tl = values[y * cols + x];
      const tr = values[y * cols + x + 1];
      const br = values[(y + 1) * cols + x + 1];
      const bl = values[(y + 1) * cols + x];
      // A square touching missing data is skipped entirely rather than
      // contoured against a guessed corner.
      if (tl == null || tr == null || br == null || bl == null) continue;

      let code = 0;
      if (tl >= level) code |= 8;
      if (tr >= level) code |= 4;
      if (br >= level) code |= 2;
      if (bl >= level) code |= 1;
      if (code === 0 || code === 15) continue; // wholly above or below

      // Crossing points on each edge, in grid coordinates.
      const top = { x: x + lerp(level, tl, tr), y };
      const right = { x: x + 1, y: y + lerp(level, tr, br) };
      const bottom = { x: x + lerp(level, bl, br), y: y + 1 };
      const left = { x, y: y + lerp(level, tl, bl) };

      const push = (a: { x: number; y: number }, b: { x: number; y: number }) =>
        segments.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });

      switch (code) {
        case 1: push(left, bottom); break;
        case 2: push(bottom, right); break;
        case 3: push(left, right); break;
        case 4: push(top, right); break;
        case 6: push(top, bottom); break;
        case 7: push(left, top); break;
        case 8: push(top, left); break;
        case 9: push(top, bottom); break;
        case 11: push(top, right); break;
        case 12: push(left, right); break;
        case 13: push(bottom, right); break;
        case 14: push(left, bottom); break;
        // Ambiguous saddles — resolved by the centre value.
        case 5: {
          const centre = (tl + tr + br + bl) / 4;
          if (centre >= level) {
            push(top, right);
            push(left, bottom);
          } else {
            push(top, left);
            push(bottom, right);
          }
          break;
        }
        case 10: {
          const centre = (tl + tr + br + bl) / 4;
          if (centre >= level) {
            push(top, left);
            push(bottom, right);
          } else {
            push(top, right);
            push(left, bottom);
          }
          break;
        }
      }
    }
  }
  return segments;
}

/**
 * Joins loose segments into continuous polylines.
 *
 * Marching squares emits each segment independently, so drawing them raw
 * gives a dotted-looking line and makes it impossible to place a label along
 * a contour. Chaining them end-to-end produces real lines that can be
 * stroked and labelled.
 */
export function chainSegments(segments: ContourSegment[], tolerance = 1e-6): { x: number; y: number }[][] {
  const key = (x: number, y: number) => `${Math.round(x / tolerance)}:${Math.round(y / tolerance)}`;
  const remaining = new Map<string, ContourSegment[]>();
  for (const s of segments) {
    for (const k of [key(s.x1, s.y1), key(s.x2, s.y2)]) {
      const list = remaining.get(k) ?? [];
      list.push(s);
      remaining.set(k, list);
    }
  }

  const used = new Set<ContourSegment>();
  const lines: { x: number; y: number }[][] = [];

  for (const seed of segments) {
    if (used.has(seed)) continue;
    used.add(seed);
    const points = [
      { x: seed.x1, y: seed.y1 },
      { x: seed.x2, y: seed.y2 },
    ];

    // Extend from both ends until nothing else connects.
    for (const forward of [true, false]) {
      for (;;) {
        const end = forward ? points[points.length - 1] : points[0];
        const candidates = remaining.get(key(end.x, end.y)) ?? [];
        const next = candidates.find((s) => !used.has(s));
        if (!next) break;
        used.add(next);
        const startsHere = Math.abs(next.x1 - end.x) < tolerance && Math.abs(next.y1 - end.y) < tolerance;
        const far = startsHere ? { x: next.x2, y: next.y2 } : { x: next.x1, y: next.y1 };
        if (forward) points.push(far);
        else points.unshift(far);
      }
    }
    lines.push(points);
  }
  return lines;
}

/**
 * All contour lines for a grid, at a given interval.
 *
 * Levels are snapped to multiples of `step` so isobars land on 1008, 1012,
 * 1016 rather than wherever the data happens to start — the values a
 * forecaster expects to read off a chart.
 */
export function contourGrid(
  values: (number | null)[],
  cols: number,
  rows: number,
  min: number,
  max: number,
  step: number,
  maxLevels = 40
): ContourLine[] {
  const out: ContourLine[] = [];
  const first = Math.ceil(min / step) * step;
  let count = 0;
  for (let level = first; level <= max; level += step) {
    if (++count > maxLevels) break;
    const chains = chainSegments(marchingSquares(values, cols, rows, level));
    for (const points of chains) {
      if (points.length < 2) continue;
      out.push({ level, points });
    }
  }
  return out;
}
