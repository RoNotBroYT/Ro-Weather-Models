// Radar FORECAST (nowcast) for the next ~60 minutes — Europe incl. the UK.
//
// What it is: the newest OPERA rain picture moved forward along the motion
// the rain PATTERN has shown over the last 20 minutes ("extrapolation
// nowcast", the method behind most radar "future" loops), softened with lead
// time. There is no wind measurement in it: the radar is reflectivity only,
// and the motion is an estimate made by comparing pictures.
//
//   1. Motion (nowcastMotion.ts). Four composites — t0 and the ones 5, 15 and
//      20 minutes before — are shrunk to a 4 km grid and compared as two
//      pairs 15 minutes apart. The shift that best lines the older rain up
//      with the newer is found first coarsely (8 km grid, 160 km windows, up
//      to 160 km/h) and then finely (4 km grid, 48 km windows, a node every
//      16 km), matching forwards and backwards, to a fraction of a cell. Each
//      node keeps how well its rain pins the shift down in each direction;
//      one weighted, smoothed solve turns the nodes into a field that covers
//      the whole map (dry areas are filled from the rain around them).
//   2. Forecast (nowcastAdvect.ts). Each forecast pixel is traced BACK along
//      that field (midpoint steps of ≤10 minutes, so curved paths are
//      followed) to where its rain is now, and takes the t0 value there.
//   3. Blur with lead time. Small features are less predictable the further
//      ahead you look, so the picture is averaged with a Gaussian of σ =
//      0.1 km per minute of lead (3 km at +30, 6 km at +60) — averaging
//      Z^0.4, which, unlike averaging rain power Z, does not make the rain
//      area swell.
//   4. Trend. Where the rain has been broadly filling in or thinning out as
//      it moved, that is continued for a while, fading (at most 4.6 dB by
//      +60 minutes). Only pixels that have rain are changed.
//
// HOW GOOD IT IS — measured, not claimed. scripts/validate-nowcast.ts makes
// forecasts from real composites and scores them against what the radar then
// saw (whole grid, 1 km). These are 11 start times, 2 h apart, 2–3 Oct 2026,
// NOT used for choosing any setting. PERS = the t0 picture left where it is;
// OLD = this file before the method above (one pair of pictures, 64 km
// blocks, first-order steps, a disc average of Z).
//
//                 mean error   hits/(hits+misses+false alarms)   neighbourhood
//                 dBZ, wet px   ≥ 20 dBZ       ≥ 35 dBZ          score (FSS), 9 km, ≥ 20
//   +15  PERS        5.71        0.491          0.308            0.840
//        OLD         4.46        0.608          0.387            0.907
//        NEW         3.90        0.654          0.425            0.929
//   +30  PERS        6.88        0.390          0.216            0.729
//        OLD         5.54        0.516          0.304            0.824
//        NEW         4.79        0.573          0.341            0.865
//   +60  PERS        7.97        0.295          0.139            0.595
//        OLD         6.85        0.399          0.219            0.697
//        NEW         5.92        0.463          0.242            0.753
//
// Read it honestly: at +60 minutes fewer than half the pixels forecast or
// observed at ≥ 20 dBZ are hits, and under a quarter at ≥ 35 dBZ. Heavy
// cores are the least predictable thing on the map, and the blur flattens
// them: the forecast shows 0.89 / 0.85 / 0.75 of the observed area ≥ 35 dBZ
// at +15 / +30 / +60 (OLD showed too much: 1.06 / 1.17 / 1.31). Scattered
// showers merge into one soft area — "showers about here", not "a shower
// exactly here". That day was a steady south-westerly flow of about
// 25–35 km/h over Europe; a day of slow, pulsing thunderstorms will score
// worse for every method. Re-run the harness to see today's numbers.
//
// Tiles are served up to +90 minutes, further than the table goes. Scored
// once for the same 11 start times (a one-off run, not part of the harness):
// mean error 6.56 dBZ (OLD 7.58, PERS 8.59), hits at ≥ 20 dBZ 0.391 (0.331,
// 0.237), at ≥ 35 dBZ 0.179 (0.165, 0.094) — and only 0.67 of the observed
// area ≥ 35 dBZ is shown. At that range it is a rough guide to where the
// rain area is heading, no more.
//
// What it is NOT: it cannot grow new showers, and it cannot turn them. The
// only strengthening or weakening is step 4's recent trend, continued and
// fading. Forecast times are counted from t0 (the newest radar picture,
// usually 10–20 min behind the clock). Outside the OPERA area nothing is
// forecast — the tile is left empty, and the radar page says so.

import { createCanvas } from "@napi-rs/canvas";
import { precipFieldNow, precipFieldWait } from "./precipType";
import { drawOpera, opera, renderDemFrom, tile2lat, tile2lon, type OperaFile } from "./radar24";
import { cacheLimit } from "./localBoost";
import { estimateMotion, MOTION_DEFAULTS, pairAges, type CoarseFrame, type MotionSettings } from "./nowcastMotion";
import { ADVECT_DEFAULTS, forecastWindow, NOWCAST_NODATA, type AdvectSettings } from "./nowcastAdvect";

/** Coarse grid for motion: 4 km cells. */
const F = 4;
/** Minutes between OPERA composites, and how far back the motion estimate looks. */
const FRAME_MIN = 5;
const HISTORY_MIN = 30;
/** The longest lead served (minutes after t0). */
export const NOWCAST_MAX_LEAD_MIN = 90;

/**
 * The motion estimate for one start time, on a regular grid of nodes, in
 * 1 km grid cells per minute. An ESTIMATE from how the rain pattern shifted
 * between pictures — not a wind measurement (see nowcastMotion.ts).
 */
export interface Motion {
  nx: number;
  ny: number;
  u: Float32Array;
  v: Float32Array;
  /** Fastest speed anywhere in the field (cells/min), to size read windows. */
  maxSpeed: number;
  /**
   * For the API/UI: the rain-weighted MEDIAN MOTION VECTOR over the nodes
   * that had rain of their own — its speed (km/h) and the direction the rain
   * moves TOWARDS (°, 0 = up the grid, 90 = to its right). Both numbers
   * describe the same vector, so they cannot disagree with each other.
   * "Up the grid" is true north only along 10°E: measured on the OPERA grid,
   * true north lies 8° clockwise of it at London, 13° at Dublin, 9° the
   * other way at Warsaw. One figure for all of Europe is a rough summary in
   * any case; turn it by that much before showing it as a compass bearing
   * for a place.
   */
  medianKmh: number;
  medianToDeg: number;
  /** Nodes whose own rain gave a trusted vector. */
  validBlocks: number;
  /** Node (i, j) sits at 1 km cell (x0 + i·step, y0 + j·step). */
  x0: number;
  y0: number;
  step: number;
  /** Per node, 0–1: how well the rain there pins the motion down (0 = filled in from around). */
  conf: Float32Array;
  /** Per node: recent strengthening (+) / weakening (−) of the rain as it moved, per minute (see nowcastMotion.ts). */
  trend: Float32Array;
  /**
   * One figure for the whole estimate, 0–1: the share of rain-bearing nodes
   * that gave a trusted vector × how well their pictures matched. Low when
   * the rain mostly changed shape instead of moving. Not a probability.
   */
  confidence: number;
  /** Composites that went into it, and the pairs compared. */
  framesUsed: number;
  pairsUsed: number;
  /** Minutes between the two pictures of each pair. */
  lagMin: number;
}

// The caches live on globalThis so a dev-server reload keeps them. The names
// carry a version: the motion object changed shape with this method, and a
// field (or a tile) left over from the previous code must never be read back.
const g = globalThis as unknown as {
  __ncMotion2?: Map<number, Promise<Motion | null>>;
  __ncTiles2?: Map<string, Buffer>;
};
const motionCache = (g.__ncMotion2 ??= new Map());
const tileCache = (g.__ncTiles2 ??= new Map());

/**
 * Mean of clipped dBZ per F×F block over the whole grid (no echo = 0) — the
 * picture the motion is estimated from. (Exported for scripts/validate-nowcast.ts.)
 */
export function coarseField(o: OperaFile): { cw: number; ch: number; a: Float32Array } {
  const cols = o.grid.cols;
  const rows = o.grid.rows;
  const cw = Math.floor(cols / F);
  const ch = Math.floor(rows / F);
  const a = new Float32Array(cw * ch);
  // Whole rows of the file's storage blocks at a time (OPERA stores the grid
  // in blocks 760 rows deep): measured 129 ms a file, against 484 ms for the
  // 256-row strips used before, which unpacked every block three times.
  const STRIP = 760;
  for (let r0 = 0; r0 < ch * F; r0 += STRIP) {
    const r1 = Math.min(ch * F, r0 + STRIP);
    const raw = o.read(r0, r1, 0, cols);
    for (let r = r0; r < r1; r++) {
      const cy = Math.floor(r / F);
      const base = (r - r0) * cols;
      for (let c = 0; c < cw * F; c++) {
        const q = raw[base + c];
        if (q === o.nodata || q === o.undetect || !Number.isFinite(q)) continue;
        let d = q * o.gain + o.offset;
        // Light haze (< 12 dBZ) is mostly noise for motion; cap hail spikes.
        if (d < 12) continue;
        if (d > 55) d = 55;
        a[cy * cw + Math.floor(c / F)] += d;
      }
    }
  }
  const n = F * F;
  for (let i = 0; i < a.length; i++) a[i] /= n;
  return { cw, ch, a };
}

/**
 * The motion estimate from a run of composites (the I/O-free core of
 * motionFor, exported so scripts/validate-nowcast.ts can run it on files of
 * its own). `ageMin` = minutes before the newest picture; the newest (0) must
 * be present. Files on a different grid from the newest are ignored, and only
 * the files that end up in a pair are read.
 */
export function motionFromFiles(frames: { ageMin: number; file: OperaFile }[], settings: Partial<MotionSettings> = {}): Motion | null {
  const newest = frames.find((f) => f.ageMin === 0)?.file;
  if (!newest) return null;
  const usable = new Map<number, OperaFile>();
  for (const f of frames) if (f.file.grid.cols === newest.grid.cols && f.file.grid.rows === newest.grid.rows) usable.set(f.ageMin, f.file);
  const cw = Math.floor(newest.grid.cols / F);
  const ch = Math.floor(newest.grid.rows / F);
  const kmPerCell = (newest.grid.xscale / 1000) * F;
  const coarseByAge = new Map<number, Float32Array>();
  const coarseOf = (age: number) => {
    let a = coarseByAge.get(age);
    if (!a) coarseByAge.set(age, (a = coarseField(usable.get(age)!).a));
    return a;
  };
  // The preferred gap first; if a composite is missing, the nearest gap that
  // still has a pair (a shorter gap resolves speed more coarsely, a longer
  // one lets the rain change more — both are worse, neither is wrong).
  const want = settings.lagMin ?? MOTION_DEFAULTS.lagMin;
  const maxPairs = settings.maxPairs ?? MOTION_DEFAULTS.maxPairs;
  const lags = [want, 10, 20, 15, 5, 25, 30].filter((l, i, a) => a.indexOf(l) === i);
  for (const lagMin of lags) {
    const pairs = pairAges([...usable.keys()], lagMin, maxPairs);
    if (!pairs.length) continue;
    const ages = [...new Set(pairs.flat())];
    const cf: CoarseFrame[] = ages.map((ageMin) => ({ ageMin, a: coarseOf(ageMin) }));
    const mf = estimateMotion(cf, cw, ch, kmPerCell, { ...settings, lagMin });
    if (!mf) continue;
    const n = mf.nx * mf.ny;
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    let maxSpeed = 0;
    for (let i = 0; i < n; i++) {
      u[i] = mf.u[i] * F;
      v[i] = mf.v[i] * F;
      const s = Math.hypot(u[i], v[i]);
      if (s > maxSpeed) maxSpeed = s;
    }
    const mu = mf.medianU * F;
    const mv = mf.medianV * F;
    const kmPerMin = Math.hypot(mu, mv) * (newest.grid.xscale / 1000);
    return {
      nx: mf.nx,
      ny: mf.ny,
      u,
      v,
      maxSpeed,
      medianKmh: kmPerMin * 60,
      // Grid rows run south, so −v is north. Direction the rain moves TOWARDS.
      medianToDeg: mf.validNodes ? ((Math.atan2(mu, -mv) * 180) / Math.PI + 360) % 360 : 0,
      validBlocks: mf.validNodes,
      // Coarse cell j covers 1 km cells jF … jF+F−1, so its centre is at jF + (F−1)/2.
      x0: (mf.x0 + 0.5) * F - 0.5,
      y0: (mf.y0 + 0.5) * F - 0.5,
      step: mf.step * F,
      conf: mf.conf,
      trend: mf.trend,
      confidence: mf.wetNodes ? (mf.validNodes / mf.wetNodes) * mf.matchQuality : 0,
      framesUsed: ages.length,
      pairsUsed: mf.pairsUsed,
      lagMin,
    };
  }
  // No pair of pictures at all: nothing to compare, try again later.
  if (!lags.some((l) => pairAges([...usable.keys()], l, 1).length)) return null;
  // Pictures were there but no rain in them could be matched (a dry map, or
  // rain that only appeared or vanished). The honest field is "no motion
  // known": nothing is moved, and the confidence says 0.
  return {
    nx: 2,
    ny: 2,
    u: new Float32Array(4),
    v: new Float32Array(4),
    maxSpeed: 0,
    medianKmh: 0,
    medianToDeg: 0,
    validBlocks: 0,
    x0: 0,
    y0: 0,
    step: Math.max(newest.grid.cols, newest.grid.rows),
    conf: new Float32Array(4),
    trend: new Float32Array(4),
    confidence: 0,
    framesUsed: coarseByAge.size,
    pairsUsed: 0,
    lagMin: want,
  };
}

/**
 * Downloads only what the estimate uses: the composites 0, 5, 15 and 20
 * minutes before t0 (two pairs 15 minutes apart). Only if those cannot make a
 * single pair — a composite missing from the feed — are the ones in between
 * and before fetched as well, and whatever gap they allow is used instead.
 */
async function computeMotion(t0: number): Promise<Motion | null> {
  const fetchAges = async (ages: number[]) => {
    const files = await Promise.all(ages.map((a) => opera(t0 - a * 60_000).catch(() => null)));
    const out: { ageMin: number; file: OperaFile }[] = [];
    files.forEach((file, i) => {
      if (file) out.push({ ageMin: ages[i], file });
    });
    return out;
  };
  const want = MOTION_DEFAULTS.lagMin;
  const first = [0, FRAME_MIN, want, want + FRAME_MIN];
  const frames = await fetchAges(first);
  if (!frames.some((f) => f.ageMin === 0)) return null;
  if (pairAges(frames.map((f) => f.ageMin), want, MOTION_DEFAULTS.maxPairs).length) return motionFromFiles(frames);
  const rest: number[] = [];
  for (let a = FRAME_MIN; a <= HISTORY_MIN; a += FRAME_MIN) if (!first.includes(a)) rest.push(a);
  return motionFromFiles([...frames, ...(await fetchAges(rest))]);
}

export function motionFor(t0: number): Promise<Motion | null> {
  let p = motionCache.get(t0);
  if (!p) {
    const mine: Promise<Motion | null> = computeMotion(t0)
      .catch((e) => {
        console.warn("[nowcast] motion failed", e);
        return null;
      })
      .then((m) => {
        // "Nothing to compare" means files could not be fetched: forget the
        // failure, so the next request tries again instead of keeping it for good.
        if (!m && motionCache.get(t0) === mine) motionCache.delete(t0);
        return m;
      });
    p = mine;
    motionCache.set(t0, p);
    while (motionCache.size > cacheLimit(4, motionCache.size)) motionCache.delete(motionCache.keys().next().value!);
  }
  return p;
}

/**
 * The forecast as a virtual OPERA file: same grid, values are dBZ at
 * t0 + leadMin. Plugged into the normal drawing code, so forecast frames use
 * the exact colours, smoothing and 3D heights of observed ones.
 * (Exported for scripts/validate-nowcast.ts.)
 */
export function nowcastFile(o: OperaFile, m: Motion, leadMin: number, settings: AdvectSettings = ADVECT_DEFAULTS): OperaFile {
  const rows = o.grid.rows;
  const cols = o.grid.cols;
  const km = o.grid.xscale / 1000;
  // The newest picture as dBZ; out of range and "no rain" both read as NaN
  // (no rain to move).
  const readDbz = (R0: number, R1: number, C0: number, C1: number) => {
    const raw = o.read(R0, R1, C0, C1);
    const n = (R1 - R0) * (C1 - C0);
    const d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const q = raw[i];
      d[i] = q === o.nodata || q === o.undetect || !Number.isFinite(q) ? NaN : q * o.gain + o.offset;
    }
    return d;
  };
  const compute = (r0: number, r1: number, c0: number, c1: number, k: number) => forecastWindow(readDbz, rows, cols, km, m, leadMin, r0, r1, c0, c1, k, settings);
  return {
    grid: o.grid,
    nodata: NOWCAST_NODATA,
    undetect: -9998,
    gain: 1,
    offset: 0,
    read: (r0, r1, c0, c1) => compute(r0, r1, c0, c1, 1),
    readPooled: (r0, r1, c0, c1, k) => compute(r0, r1, c0, c1, k),
    close: () => {},
  };
}

/** The forecast "file" for t0 + leadMin, or null when there is nothing to forecast from. */
export async function forecastSource(t0: number, t: number): Promise<OperaFile | null> {
  const lead = (t - t0) / 60_000;
  if (!(lead > 0 && lead <= NOWCAST_MAX_LEAD_MIN)) return null;
  const [o, m] = await Promise.all([opera(t0), motionFor(t0)]);
  if (!o || !m) return null;
  return nowcastFile(o, m, lead);
}

const inOperaArea = (z: number, x: number, y: number) =>
  tile2lon(x + 1, z) > -32 && tile2lon(x, z) < 50 && tile2lat(y, z) > 30 && tile2lat(y + 1, z) < 75;

/** A forecast colour tile (webp). `final` = can be cached for good. */
export async function renderNowcastTile(t0: number, t: number, z: number, x: number, y: number, scale = 1, smooth = 0): Promise<{ buf: Buffer; final: boolean }> {
  const key = `c/${scale}/${smooth}/${t0}/${t}/${z}/${x}/${y}`;
  const hit = tileCache.get(key);
  if (hit) return { buf: hit, final: true };
  const S = 256 * scale;
  const canvas = createCanvas(S, S);
  let final = true;
  const pf = await precipFieldWait(t);
  if (!pf) final = false;
  if (inOperaArea(z, x, y)) {
    const src = await forecastSource(t0, t);
    if (src) drawOpera(canvas.getContext("2d"), src, tile2lon(x, z), tile2lon(x + 1, z), tile2lat(y, z), tile2lat(y + 1, z), S, smooth, { x, y, z }, pf);
    else final = false; // files not reachable right now — try again later
  }
  const buf = canvas.toBuffer("image/webp", 90);
  if (final) {
    tileCache.set(key, buf);
    while (tileCache.size > cacheLimit(2000, tileCache.size)) tileCache.delete(tileCache.keys().next().value!);
  }
  return { buf, final };
}

/** A forecast 3D height tile (terrain-RGB PNG). */
export async function renderNowcastDem(t0: number, t: number, z: number, x: number, y: number): Promise<{ buf: Buffer; final: boolean }> {
  if (!inOperaArea(z, x, y)) return { buf: renderDemFrom(null, z, x, y), final: true };
  const src = await forecastSource(t0, t);
  return { buf: renderDemFrom(src, z, x, y), final: !!src };
}
