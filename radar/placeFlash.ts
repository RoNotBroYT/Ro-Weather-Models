/**
 * Places satellite lightning where the storm's physics says it most likely was (17 Nov).
 *
 * The satellites see the light of a whole flash from space: MTG LI's pixels are ~4.5 km over
 * the UK, GLM's ~8–10 km, and the position given is the middle of the lit patch. Lightning
 * doesn't come from a storm's heaviest echo: charge builds where hail, graupel and ice collide
 * in the updraft (−10 to −20 °C), on the edge of the core, mostly on the side the storm is
 * moving towards (new cells grow there); flashes then run out sideways into the anvil and the
 * trailing light rain, where the strong, long-reaching ones (often positive ground strikes) land.
 *
 * So for each flash over the European radar (OPERA, ~2 km), within its satellite footprint:
 *   - the radar's echo, and how the storm moved in the last 10 minutes (two frames compared);
 *   - a likelihood for every radar pixel: high on the edge of a core (strong echo gradient,
 *     30–50 dBZ), higher on the leading side, lower in the very centre of a core, very low
 *     where there's no echo; strong flashes are also allowed out in the light rain (anvil,
 *     trailing stratiform); weighted by distance from where the satellite put it;
 *   - shallow (winter) storms, with no core over ~40 dBZ, keep their flashes tighter.
 * Works the same for single cells, multicell clusters, lines, big complexes and storms buried in
 * frontal rain, because it reads the storm's real shape and motion rather than assuming one.
 * No echo near the flash (an anvil with nothing falling): it stays where the satellite put it.
 */
import { opera } from "./lib/server/radar24";
import { lonLatToGrid } from "./lib/server/operaRadar";

type F = { t: number; lon: number; lat: number; e: number };
const STEP = 300_000;

async function frame(t: number) {
  // The newest radar picture at or before the flash (they come out a few minutes late).
  for (let k = 0; k < 5; k++) {
    const rt = Math.floor(t / STEP) * STEP - k * STEP;
    const o = await opera(rt).catch(() => null);
    if (o) return { rt, o };
  }
  return null;
}

function dbzWindow(o: NonNullable<Awaited<ReturnType<typeof opera>>>, r0: number, r1: number, c0: number, c1: number): Float32Array {
  const raw = o.read(r0, r1, c0, c1), out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    out[i] = v === o.nodata || v === o.undetect || !Number.isFinite(v) ? 0 : v * o.gain + o.offset;
  }
  return out;
}

export async function placeFlashes(flashes: F[]): Promise<F[]> {
  const frames = new Map<number, Promise<Awaited<ReturnType<typeof frame>>>>();
  const get = (t: number) => { const k = Math.floor(t / STEP); if (!frames.has(k)) frames.set(k, frame(t)); return frames.get(k)!; };
  const out: F[] = [];
  for (const f of flashes) {
    // OPERA covers Europe; elsewhere (the Americas) the satellite's position is kept.
    if (f.lon < -32 || f.lon > 45 || f.lat < 30 || f.lat > 75) { out.push(f); continue; }
    try { out.push(await place(f, await get(f.t), await get(f.t - 2 * STEP))); }
    catch { out.push(f); }
  }
  return out;
}

async function place(f: F, cur: Awaited<ReturnType<typeof frame>>, prev: Awaited<ReturnType<typeof frame>>): Promise<F> {
  if (!cur) return f;
  const g = cur.o.grid, px = g.xscale / 1000;                 // km per pixel (~2)
  const { col, row } = lonLatToGrid(f.lon, f.lat, g);
  if (!Number.isFinite(col)) return f;
  const foot = 4.5 / px;                                     // MTG footprint, in pixels
  const R = Math.ceil(foot * 2.2);
  const c0 = Math.max(0, Math.round(col) - R), c1 = Math.min(g.cols, Math.round(col) + R + 1);
  const r0 = Math.max(0, Math.round(row) - R), r1 = Math.min(g.rows, Math.round(row) + R + 1);
  const W = c1 - c0, H = r1 - r0;
  if (W < 5 || H < 5) return f;
  const Z = dbzWindow(cur.o, r0, r1, c0, c1);
  let maxZ = 0; for (const z of Z) maxZ = Math.max(maxZ, z);
  if (maxZ < 18) return f;                                   // nothing falling: an anvil, keep it
  // How the storm moved: the shift of the echo since 10 minutes before (pixels).
  let vx = 0, vy = 0;
  if (prev && prev.rt < cur.rt) {
    const P = dbzWindow(prev.o, r0, r1, c0, c1);
    let best = Infinity;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      let s = 0, n = 0;
      for (let y = 3; y < H - 3; y++) for (let x = 3; x < W - 3; x++) {
        const a = Z[y * W + x]; if (a < 20) continue;
        const b = P[(y - dy) * W + (x - dx)]; s += (a - b) ** 2; n++;
      }
      if (n > 8 && s / n < best) { best = s / n; vx = dx; vy = dy; }
    }
  }
  const vl = Math.hypot(vx, vy) || 1;
  const shallow = maxZ < 40;                                 // winter showers: tight to the cell
  const strong = f.e > 2e-13;                                // a big flash: may reach out into the light rain
  const sig = foot * (shallow ? 0.9 : 1.3);
  const cx = col - c0, cy = row - r0;
  let bestS = -1, bx = cx, by = cy;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const z = Z[y * W + x];
    const gx = (Z[y * W + x + 1] - Z[y * W + x - 1]) / 2, gy = (Z[(y + 1) * W + x] - Z[(y - 1) * W + x]) / 2;
    const grad = Math.hypot(gx, gy);
    let s: number;
    if (z < 15) s = 0.03;
    else if (z >= 52) s = 0.35;                              // the very centre of a core
    else if (z >= 30) s = 0.35 + 0.65 * Math.min(1, grad / 7);
    else s = strong && !shallow ? 0.45 : 0.12;               // light rain: the anvil / trailing rain
    // The leading side (where the echo falls away in the direction of travel): new growth.
    if (grad > 0.5 && z >= 25) {
      const out = -(gx * vx + gy * vy) / (grad * vl);
      s *= 1 + 0.4 * Math.max(0, out);
    }
    const d2 = (x - cx) ** 2 + (y - cy) ** 2;
    s *= Math.exp(-d2 / (2 * sig * sig));
    if (s > bestS) { bestS = s; bx = x; by = y; }
  }
  // Back to longitude and latitude: the grid's local slope near the flash.
  const dc = bx - cx, dr = by - cy;
  if (Math.abs(dc) < 0.25 && Math.abs(dr) < 0.25) return f;
  const e = 0.01, a = lonLatToGrid(f.lon + e, f.lat, g), b = lonLatToGrid(f.lon, f.lat + e, g);
  const j11 = (a.col - col) / e, j12 = (b.col - col) / e, j21 = (a.row - row) / e, j22 = (b.row - row) / e;
  const det = j11 * j22 - j12 * j21;
  if (!det) return f;
  const dlon = (j22 * dc - j12 * dr) / det, dlat = (-j21 * dc + j11 * dr) / det;
  return { ...f, lon: f.lon + dlon, lat: f.lat + dlat };
}
