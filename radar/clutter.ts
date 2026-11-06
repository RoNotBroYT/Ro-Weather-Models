/**
 * Builds the radar clutter list (see withClutterRemoved in lib/server/radar24.ts):
 * the OPERA cells that showed an echo in at least 60% of the past day's frames
 * while the ring around them (3–6 cells out) was mostly dry. Real rain moves and
 * comes with rain around it; the speckle on and near a radar (buildings, hills,
 * wind turbines, sea waves) sits still on its own. Saved to R2 as clutter.bin:
 * the cell numbers (row × cols + col), sorted, as 32-bit integers.
 */
import { operaRaw } from "./lib/server/radar24";

export async function buildClutter(times: number[]): Promise<Uint32Array | null> {
  let count: Uint16Array | null = null;
  let cols = 0, rows = 0, n = 0;
  for (const t of times) {
    const o = await operaRaw(t);
    if (!o) continue;
    cols = o.grid.cols; rows = o.grid.rows;
    count ??= new Uint16Array(cols * rows);
    const v = o.read(0, rows, 0, cols);
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      if (x !== o.nodata && x !== o.undetect && Number.isFinite(x) && x * o.gain + o.offset >= 10) count[i]++;
    }
    o.close?.();
    n++;
  }
  if (!count || n < 12) return null; // too little history to judge
  // Candidates first, so a large patch of clutter doesn't count as "rain around" itself.
  const cand = new Set<number>();
  for (let i = 0; i < count.length; i++) if (count[i] >= 0.6 * n) cand.add(i);
  const out: number[] = [];
  for (const i of cand) {
    const r = Math.floor(i / cols), c = i - r * cols;
    let ring = 0, seen = 0;
    for (let dr = -6; dr <= 6; dr++)
      for (let dc = -6; dc <= 6; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) < 3) continue;
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols || cand.has(rr * cols + cc)) continue;
        seen++;
        ring += count[rr * cols + cc] / n;
      }
    if (seen && ring / seen < 0.2) out.push(i);
  }
  console.log(`clutter: ${out.length} cells from ${n} frames`);
  return Uint32Array.from(out.sort((a, b) => a - b));
}
