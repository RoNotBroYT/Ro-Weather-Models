/**
 * Storm cells, worked out once per radar frame here so every visitor (site and app) sees the same ones.
 * One scan over a fixed area (UK + Europe, 35-72N, 25W-45E) at zoom 7, the dBZ read straight from the
 * radar file (no colours read back), the newest frame plus the 3 before it (5 min apart) for motion.
 * Uses the website's own scanner (lib/storm, copied from weatherapp-3 src/lib; keep in step).
 * Ids and names carry on from the last file. No randomness: the same frames give the same file.
 */
import { opera, tile2lat, tile2lon } from "./lib/server/radar24";
import { lonLatToGrid, type LaeaGrid } from "./lib/server/operaRadar";
// @ts-ignore plain JS
import { cellsFromGrids, rememberCells, intensityLabel } from "./lib/storm/stormCellScan.js";
// @ts-ignore plain JS
import { scanRotationOnGrids } from "./lib/storm/rotationDetect.js";

export const CELL_AREA = { z: 7, tx0: 55, tx1: 80, ty0: 26, ty1: 50 } as const;
const FRAMES = 4, STEP = 5 * 60_000;
const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const r1 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 10) / 10);

// Where each pixel of the area falls on the radar's own grid, worked out once (the 4 frames share it):
// the corner cell and the two blend weights (in 1/255), the same blend the tiles are drawn with.
let map: { key: string; i00: Int32Array; fx: Uint8Array; fy: Uint8Array } | null = null;
function pixelMap(g: LaeaGrid) {
  const key = JSON.stringify(g);
  if (map?.key === key) return map;
  const A = CELL_AREA, W = (A.tx1 - A.tx0 + 1) * 256, H = (A.ty1 - A.ty0 + 1) * 256;
  const i00 = new Int32Array(W * H).fill(-1), fx = new Uint8Array(W * H), fy = new Uint8Array(W * H);
  const west = tile2lon(A.tx0, A.z), east = tile2lon(A.tx1 + 1, A.z);
  const mercN = Math.log(Math.tan(Math.PI / 4 + (tile2lat(A.ty0, A.z) * Math.PI) / 360));
  const mercS = Math.log(Math.tan(Math.PI / 4 + (tile2lat(A.ty1 + 1, A.z) * Math.PI) / 360));
  for (let py = 0; py < H; py++) {
    const lat = (Math.atan(Math.sinh(mercN + ((mercS - mercN) * (py + 0.5)) / H)) * 180) / Math.PI;
    for (let px = 0; px < W; px++) {
      const { col, row } = lonLatToGrid(west + ((east - west) * (px + 0.5)) / W, lat, g);
      const x = col - 0.5, y = row - 0.5, x0 = Math.floor(x), y0 = Math.floor(y);
      if (!(x0 >= 0 && y0 >= 0 && x0 + 1 < g.cols && y0 + 1 < g.rows)) continue;
      const i = py * W + px;
      i00[i] = y0 * g.cols + x0; fx[i] = Math.round((x - x0) * 255); fy[i] = Math.round((y - y0) * 255);
    }
  }
  return (map = { key, i00, fx, fy });
}

async function dbzGrid(t: number): Promise<Int16Array | null> {
  const o = await opera(t);
  if (!o) return null;
  const g = o.grid, m = pixelMap(g);
  const raw = o.read(0, g.rows, 0, g.cols);
  // nodata (outside every radar) and undetect (no rain) both count as nothing here.
  const d = new Float32Array(g.rows * g.cols);
  for (let i = 0; i < d.length; i++) { const v = raw[i]; d[i] = v === o.nodata || v === o.undetect || !Number.isFinite(v) ? -32 : v * o.gain + o.offset; }
  const out = new Int16Array(m.i00.length).fill(-32), C = g.cols;
  for (let i = 0; i < out.length; i++) {
    const k = m.i00[i];
    if (k < 0) continue;
    const tx = m.fx[i] / 255, ty = m.fy[i] / 255;
    const v = d[k] * (1 - tx) * (1 - ty) + d[k + 1] * tx * (1 - ty) + d[k + C] * (1 - tx) * ty + d[k + C + 1] * tx * ty;
    if (v >= 5) out[i] = Math.round(v);
  }
  return out;
}

/** The cells file for frame t (JSON text), or null when the frame's radar file is missing. prev = the last file. */
export async function scanCells(t: number, prev: { cells?: unknown[] } | null): Promise<string | null> {
  const A = CELL_AREA;
  const grid = { z: A.z, tx0: A.tx0, ty0: A.ty0, width: (A.tx1 - A.tx0 + 1) * 256, height: (A.ty1 - A.ty0 + 1) * 256 };
  const times = Array.from({ length: FRAMES }, (_, i) => t - (FRAMES - 1 - i) * STEP);
  const grids: (Int16Array | null)[] = [];
  for (const ft of times) grids.push(await dbzGrid(ft));
  if (!grids[grids.length - 1]) return null;
  const decoded = times.map((time, i) => ({ time, dbz: grids[i], width: grid.width, height: grid.height })).filter((f) => f.dbz);
  rememberCells(prev?.cells ?? []);
  const cells = decoded.length >= 2 ? cellsFromGrids(decoded, grid, 30) : [];
  const rot = scanRotationOnGrids(grids.slice(-3), grid, times.slice(-3)) as Record<string, unknown>[];
  const ll = (p: { lon: number; lat: number } | null) => (p ? { lon: r4(p.lon), lat: r4(p.lat) } : null);
  const body = {
    time: t,
    area: { west: tile2lon(A.tx0, A.z), east: tile2lon(A.tx1 + 1, A.z), north: tile2lat(A.ty0, A.z), south: tile2lat(A.ty1 + 1, A.z), z: A.z },
    cells: (cells as Record<string, any>[]).map((c) => ({
      ...c,
      lon: r4(c.lon), lat: r4(c.lat),
      intensity: intensityLabel(c.maxDbz),
      headingDeg: r1(c.headingDeg), speedKmh: r1(c.speedKmh),
      speedSigmaKmh: r1(c.speedSigmaKmh), headingSigmaDeg: r1(c.headingSigmaDeg),
      projectedRadiusKm: r1(c.projectedRadiusKm), onwardRadiusKm: r1(c.onwardRadiusKm), areaKm2: r1(c.areaKm2),
      peakLon: c.peakLon == null ? null : r4(c.peakLon), peakLat: c.peakLat == null ? null : r4(c.peakLat),
      projected: ll(c.projected), onward: ll(c.onward),
      // The last 30 minutes of the track.
      path: c.path.filter((p: { time: number }) => p.time >= t - 30 * 60_000).map((p: any) => ({ lon: r4(p.lon), lat: r4(p.lat), time: p.time, maxDbz: p.maxDbz })),
    })),
    rotation: rot.map((s) => ({
      lon: r4(s.lon as number), lat: r4(s.lat as number), tier: s.tier, score: s.score, maxDbz: s.maxDbz,
      hasNotch: s.hasNotch, hasHole: s.hasHole, hasTightGradient: s.hasTightGradient,
      seenIn: s.seenIn, scans: s.scans, deviationDeg: s.deviationDeg, deviationSigmaDeg: s.deviationSigmaDeg, motionCells: s.motionCells,
    })),
  };
  return JSON.stringify(body);
}

// Local test: bun cells.ts [time ms] - scans that frame twice, checks both are the same, prints UK cells.
if (import.meta.main) {
  const { latestOperaTime } = await import("./lib/server/radar24");
  const t = Number(process.argv[2]) || (await latestOperaTime());
  const t0 = Date.now();
  const a = await scanCells(t, null);
  const t1 = Date.now();
  const b = await scanCells(t, null);
  console.log(`frame ${new Date(t).toISOString()}: ${a?.length ?? 0} bytes, ${Math.round((t1 - t0) / 1000)} s; second run ${a === b ? "identical" : "DIFFERENT"}`);
  if (a) {
    const j = JSON.parse(a);
    console.log(`${j.cells.length} cells, ${j.rotation.length} rotation markers in the whole area`);
    for (const c of j.cells.filter((c: any) => c.lat > 49.5 && c.lat < 61 && c.lon > -11 && c.lon < 2.5))
      console.log(`${c.name} ${c.id} ${c.lat},${c.lon} ${c.maxDbz} dBZ ${c.intensity}; ${c.speedKmh ?? "-"} km/h to ${c.headingDeg ?? "-"} deg (${c.motionConfidence}), ${c.framesTracked} frames, ${c.areaKm2} km2`);
  }
}
