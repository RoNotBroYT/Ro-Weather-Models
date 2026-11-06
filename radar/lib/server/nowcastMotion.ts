// Radar MOTION ESTIMATE — the maths only (typed arrays in, a field out; no
// files, no network, no caches), so it can be tested against known answers.
// The I/O, caching and tile drawing live in radarNowcast.ts; the forecast
// built on the motion is nowcastAdvect.ts; the test harness is
// scripts/validate-nowcast.ts.
//
// HONESTY NOTE, to be repeated by anything that shows these numbers: the
// radar gives REFLECTIVITY only (how hard it is raining). There is no Doppler
// wind in it. The "motion" here is an ESTIMATE of how the rain PATTERN has
// shifted between successive pictures — what your eye does watching a radar
// loop. It is not the wind and no instrument measured it. Where showers grow
// on one side and die on the other, the pattern moves differently from the
// air, and it is the pattern this follows.
//
// METHOD
//
//   1. Two pairs of pictures, not one: (t0, t0−15 min) and (t0−5, t0−20).
//      For every candidate shift the squared differences of BOTH pairs are
//      added before the best shift is chosen, so the answer has to fit both.
//   2. Coarse to fine. First on an 8 km grid, with wide windows (160 km
//      across, most of the weight in the middle 70 km) and the full search
//      range (up to 160 km/h): the large, fast motion, robustly. Then on the
//      4 km grid: the older picture is moved by that first answer and only
//      the small remaining shift is searched, with small windows (48 km
//      across, one node every 16 km), which is what lets showers move
//      differently from a band next to them.
//   3. Squared differences, measured both ways. The cost of a shift is the
//      sum of squared differences in clipped dBZ, summed once over the rain
//      where it is NOW (backward match) and once over where it WAS (forward
//      match). A node whose two answers disagree by more than one cell is
//      dropped. A squared-error surface is close to a parabola at its
//      minimum, so the sub-cell fit (a 2D quadratic through the 3×3
//      neighbours) is not biased the way a fit to absolute differences is.
//   4. The fit also gives the SHAPE of the minimum (a 2×2 matrix): sharp
//      across a rain band, flat along it. That is kept as the node's weight,
//      so a band says how fast it moves across itself and nothing about
//      sliding along itself (the "aperture problem") instead of pretending to
//      know both.
//   5. One smooth field. All nodes and their weights go into a single
//      least-squares solve with a smoothness term, which fills the dry gaps
//      from the rain around them and lets each node's well-determined
//      direction count for more than its poorly determined one.
//   6. A trend. With the motion known, what is left over between the moved
//      older picture and the newer one is rain filling in or thinning out.
//      Its broad pattern (tens of km) is returned with the field; the
//      forecast continues it for a while (see nowcastAdvect.ts).
//
// CHOSEN BY MEASUREMENT. The settings were tuned on 11 start times of real
// OPERA data (2–3 Oct 2026) and the reported scores come from 11 others — see
// the table in radarNowcast.ts, which scripts/validate-nowcast.ts reprints.
// The numbers below are from that tuning: mean error in dBZ of the +15 minute
// forecast (no blur, no trend), scored at 2 km. They are development runs,
// not part of the harness, quoted so the choices can be judged.
//   What mattered: two pairs instead of one (4.16 → 4.02); the fine level
//   (4.13 without it → 4.02); and NOT smoothing heavily (smoothness 0.3:
//   4.00, 1: 4.02, 3: 4.08, 10: 4.22). The old method's field: 4.33.
//   Tried and TAKEN OUT, because the scores did not move:
//   · a normalised median test on the node vectors (3.979 with, 3.979 without);
//   · a third and fourth pair (4 pairs 4.023, 2 pairs 4.021 — and two or
//     three more files to download);
//   · gaps of 5, 10 or 20 minutes instead of 15 (4.03, 4.03, 4.06);
//   · an extra pair 30 minutes apart (3.95 against 3.92 on a later baseline);
//   · a three-level pyramid, 16–8–4 km (4.025 against 4.023);
//   · smoothing only the fine level's correction (never better, 3.92–4.00).
//   The forward/backward check made no difference on real data (3.980
//   against 3.979); it stays because it costs nothing (both sums are needed
//   anyway) and trims the noisy synthetic cases by up to 0.1 km/h.
//
// KNOWN WEAKNESS, visible in the harness: because the field is allowed to
// vary over tens of km, it also follows local shape change. In the synthetic
// test where every blob grows or decays by up to 45 % in 15 minutes under a
// perfectly uniform flow, its error (≈ 5 km/h) is larger than the old
// method's (≈ 4 km/h), whose 64 km averaging happens to suit a uniform flow.
// On real rain the finer field forecasts better, which is why it is kept.
//
// SECOND KNOWN WEAKNESS, not in the harness (whose synthetic test leaves out
// the outer 64 km): the estimate is poor right at the EDGE OF THE GRID. Rain
// crossing the edge has no partner on the other side, and the two matches
// treat that differently — the backward one counts the missing partner as
// dry, the forward one leaves the rain out of the sum, which favours shifts
// that push rain outwards — and the moved older picture has no value for a
// cell whose source lies on or past the last row or column. Measured on blob
// rain reaching the edge of a 1024 km picture: within 48 km of the edge the
// error is about 5 km/h (worst 10–20) against 0.1–0.5 in the interior, and
// four identical pictures (true motion: none) give about 5 km/h there.
// Counting the left-out rain as unmatched and reading the last row properly
// took the identical-pictures case down to 1–2 km/h, but moving rain was
// no better (mean 2–8 km/h either way, worst cases larger), so the matching
// was left as it is. OPERA scans almost nothing within 60 km of its grid's
// edge (about 17 000 km² of 8.4 million on 3 Oct 2026, in the far north and
// south), which is why this does not show in the scores.
//
// WHAT IT DOES NOT DO: it assumes the motion stayed the same over the 20
// minutes it looks at; it cannot see motion where there is no rain (those
// areas are filled in from the rain around them and carry confidence 0); and
// a pattern that only changes shape gives it nothing true to find.

/** One picture on the coarse grid: mean clipped dBZ per cell, 0 = no rain. */
export interface CoarseFrame {
  /** Minutes before the newest picture (0 = newest). */
  ageMin: number;
  a: Float32Array;
}

export interface MotionSettings {
  /** Minutes between the two pictures of a pair. */
  lagMin: number;
  /** Fastest motion searched for (km/h). */
  maxKmh: number;
  /** At most this many pairs, newest first. */
  maxPairs: number;
  /** Levels, coarsest first. */
  levels: LevelSettings[];
  /** A node needs at least this share of its window raining to be used. */
  minWet: number;
  /** Mismatch (0 = identical, 1 = unrelated) above which a node is dropped. */
  maxMismatch: number;
  /** Forward and backward answers may differ by this many cells (−1 = check off). */
  fbTolerance: number;
  /** Smoothness weight relative to a typical node's own weight. */
  smooth: number;
  /** Pull towards the coarser level's answer, times that answer's confidence. */
  priorPull: number;
  /** [1,2,1] passes smoothing the strengthening/weakening trend over the nodes (8 passes: σ = 2 nodes). */
  trendPasses: number;
}

export interface LevelSettings {
  /** Cells of the input grid averaged into one cell of this level. */
  pool: number;
  /** Tile = node spacing, in this level's cells. */
  tile: number;
  /** [1,2,1] passes joining tiles into a window (2 passes ≈ Gaussian, σ = 1 tile). */
  windowPasses: number;
  /** Search radius in this level's cells; 0 = the full range from maxKmh (first level only). */
  search: number;
}

/**
 * The settings in use. Chosen on real data (see the header): start times
 * kept apart from the ones the reported scores come from.
 *
 *   levels   8 km cells, 32 km nodes, window ≈ [1,4,6,4,1] tiles, full search;
 *            then 4 km cells, 16 km nodes, window [1,2,1] tiles, ±3 cells
 *            (the outermost ring only frames the fit, so ±2 cells = ±32 km/h
 *            round the first level's answer can be accepted).
 *   minWet   4 % of the window raining, or the node is left to its neighbours.
 *   maxMismatch  drop a node whose best match still leaves 60 % of the
 *            pictures' energy unexplained (rain that appeared or vanished).
 *   priorPull    not tuned (0, 0.1 and 0.5 scored within 0.02 dBZ): it is
 *            there so a node the fine level cannot use keeps the coarse
 *            level's answer instead of taking its neighbours'.
 */
export const MOTION_DEFAULTS: MotionSettings = {
  lagMin: 15,
  maxKmh: 160,
  maxPairs: 2,
  levels: [
    { pool: 2, tile: 4, windowPasses: 2, search: 0 },
    { pool: 1, tile: 4, windowPasses: 1, search: 3 },
  ],
  minWet: 0.04,
  maxMismatch: 0.6,
  fbTolerance: 1,
  smooth: 0.3,
  priorPull: 0.1,
  trendPasses: 8,
};

/** The motion on a regular grid of nodes. */
export interface MotionField {
  nx: number;
  ny: number;
  /** Node (i, j) sits at input-grid cell (x0 + i·step, y0 + j·step). */
  x0: number;
  y0: number;
  step: number;
  /** Shift per minute, in input-grid cells (+u = east/right, +v = south/down). */
  u: Float32Array;
  v: Float32Array;
  /**
   * 0–1 per node: how well the rain near the node pins the motion down. 0 =
   * no usable rain there, the value was filled in from its surroundings.
   */
  conf: Float32Array;
  /** Nodes whose own rain gave a trusted vector / nodes with enough rain to try. */
  validNodes: number;
  wetNodes: number;
  /** Pairs of pictures that went into the estimate. */
  pairsUsed: number;
  /** Mean match quality of the trusted nodes, 0–1 (1 = the pattern moved without changing). */
  matchQuality: number;
  /** Rain-weighted median motion vector (input-grid cells per minute). */
  medianU: number;
  medianV: number;
  /**
   * Per node: how fast the rain round the node has been strengthening (+) or
   * weakening (−) while moving, in coarse-picture units (mean clipped dBZ of
   * a cell) per minute, smoothed over ~30 km. See trendField.
   */
  trend: Float32Array;
}

interface LevelField {
  nx: number;
  ny: number;
  /** Node positions and spacing in INPUT-grid cells. */
  x0: number;
  y0: number;
  step: number;
  /** Shift over one lag, in INPUT-grid cells. */
  dx: Float32Array;
  dy: Float32Array;
  conf: Float32Array;
  valid: Uint8Array;
  wet: Float32Array;
  wetNodes: number;
  validNodes: number;
  matchQuality: number;
}

/** Mean of each p×p block (edges that do not fill a block are dropped). */
function poolMean(a: Float32Array, w: number, h: number, p: number): { a: Float32Array; w: number; h: number } {
  if (p === 1) return { a, w, h };
  const pw = Math.floor(w / p);
  const ph = Math.floor(h / p);
  const out = new Float32Array(pw * ph);
  for (let y = 0; y < ph * p; y++) {
    const row = Math.floor(y / p) * pw;
    const src = y * w;
    for (let x = 0; x < pw * p; x++) out[row + Math.floor(x / p)] += a[src + x];
  }
  const n = p * p;
  for (let i = 0; i < out.length; i++) out[i] /= n;
  return { a: out, w: pw, h: ph };
}

/** Bilinear read of a node field at an input-grid position. */
function fieldAt(f: { nx: number; ny: number; x0: number; y0: number; step: number }, a: Float32Array, x: number, y: number): number {
  let fi = (x - f.x0) / f.step;
  let fj = (y - f.y0) / f.step;
  if (fi < 0) fi = 0;
  else if (fi > f.nx - 1) fi = f.nx - 1;
  if (fj < 0) fj = 0;
  else if (fj > f.ny - 1) fj = f.ny - 1;
  const i0 = Math.min(f.nx - 2, Math.floor(fi));
  const j0 = Math.min(f.ny - 2, Math.floor(fj));
  if (f.nx < 2 || f.ny < 2) return a[0];
  const tx = fi - i0;
  const ty = fj - j0;
  const k = j0 * f.nx + i0;
  return a[k] * (1 - tx) * (1 - ty) + a[k + 1] * tx * (1 - ty) + a[k + f.nx] * (1 - tx) * ty + a[k + f.nx + 1] * tx * ty;
}

/**
 * The older picture moved by the coarser level's answer:
 * out(x) = O(x − d(x)), read bilinearly. Positions are this level's cells;
 * the field is in input-grid cells, hence the `pool` factor.
 */
function warpByField(O: Float32Array, w: number, h: number, f: { nx: number; ny: number; x0: number; y0: number; step: number; dx: Float32Array; dy: Float32Array }, pool: number, box: Box): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = box.y0; y < box.y1; y++) {
    // The field varies slowly: evaluate it every 4 cells and interpolate.
    const cy = (y + 0.5) * pool - 0.5;
    let x = box.x0;
    while (x < box.x1) {
      const xe = Math.min(box.x1, x + 4);
      const ca = (x + 0.5) * pool - 0.5;
      const cb = (xe + 0.5) * pool - 0.5;
      const dxa = fieldAt(f, f.dx, ca, cy) / pool;
      const dya = fieldAt(f, f.dy, ca, cy) / pool;
      const dxb = fieldAt(f, f.dx, cb, cy) / pool;
      const dyb = fieldAt(f, f.dy, cb, cy) / pool;
      const n = xe - x;
      for (let q = 0; q < n; q++) {
        const t = q / n;
        const sx = x + q - (dxa + (dxb - dxa) * t);
        const sy = y - (dya + (dyb - dya) * t);
        const ix = Math.floor(sx);
        const iy = Math.floor(sy);
        if (ix < 0 || iy < 0 || ix + 1 >= w || iy + 1 >= h) continue;
        const fx = sx - ix;
        const fy = sy - iy;
        const i00 = iy * w + ix;
        out[y * w + x + q] = O[i00] * (1 - fx) * (1 - fy) + O[i00 + 1] * fx * (1 - fy) + O[i00 + w] * (1 - fx) * fy + O[i00 + w + 1] * fx * fy;
      }
      x = xe;
    }
  }
  return out;
}

/** Two pictures one gap apart: the newer and the older. */
interface Pair {
  N: Float32Array;
  O: Float32Array;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Squared-difference cost of every shift, for every tile, added into `cb`
 * (backward: summed over the tile in the NEWER picture) and `cf` (forward:
 * summed over the tile in the OLDER picture, i.e. over the same shift's
 * squared differences one shift further along).
 *
 * Shift d means "the newer rain at p came from the older rain at p − d".
 * Done as one pass over the picture per shift with a running sum along each
 * row, so the cost does not depend on the window size or the node spacing.
 */
function tileCosts(N: Float32Array, O: Float32Array, w: number, h: number, s: number, R: number, box: Box, tx: number, ty: number, cb: Float32Array, cf: Float32Array) {
  const side = 2 * R + 1;
  const K = side * side;
  const P = new Float64Array(w + 1);
  const bx0 = box.x0;
  const bx1 = box.x1;
  const clampX = (x: number) => (x < bx0 ? bx0 : x > bx1 ? bx1 : x);
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) {
      const k = (dy + R) * side + dx + R;
      for (let y = box.y0; y < box.y1; y++) {
        const yo = y - dy;
        const rowN = y * w;
        let acc = 0;
        P[bx0] = 0;
        if (yo < 0 || yo >= h) {
          for (let x = bx0; x < bx1; x++) {
            const d = N[rowN + x];
            acc += d * d;
            P[x + 1] = acc;
          }
        } else {
          const rowO = yo * w - dx;
          // Columns whose older-picture partner lies outside the grid count as dry.
          const xa = Math.max(bx0, dx);
          const xb = Math.min(bx1, w + dx);
          let x = bx0;
          for (; x < xa && x < bx1; x++) {
            const d = N[rowN + x];
            acc += d * d;
            P[x + 1] = acc;
          }
          for (; x < xb; x++) {
            const d = N[rowN + x] - O[rowO + x];
            acc += d * d;
            P[x + 1] = acc;
          }
          for (; x < bx1; x++) {
            const d = N[rowN + x];
            acc += d * d;
            P[x + 1] = acc;
          }
        }
        // Backward: this row belongs to tile row floor(y / s).
        const jb = Math.floor(y / s);
        if (jb < ty) {
          const base = jb * tx;
          for (let i = 0; i < tx; i++) {
            const v = P[clampX((i + 1) * s)] - P[clampX(i * s)];
            if (v !== 0) cb[(base + i) * K + k] += v;
          }
        }
        // Forward: the tile at (i, j) in the older picture is at +d now.
        const jf = Math.floor(yo / s);
        if (jf >= 0 && jf < ty) {
          const base = jf * tx;
          for (let i = 0; i < tx; i++) {
            const v = P[clampX((i + 1) * s + dx)] - P[clampX(i * s + dx)];
            if (v !== 0) cf[(base + i) * K + k] += v;
          }
        }
      }
    }
}

/** Sum of squares and count of raining cells per tile. */
function tileStats(a: Float32Array, w: number, s: number, box: Box, tx: number, ty: number, energy: Float32Array, wet: Float32Array | null) {
  for (let y = box.y0; y < box.y1; y++) {
    const j = Math.floor(y / s);
    if (j >= ty) break;
    for (let x = box.x0; x < box.x1; x++) {
      const i = Math.floor(x / s);
      if (i >= tx) break;
      const q = a[y * w + x];
      if (q > 0) {
        energy[j * tx + i] += q * q;
        // ≥ 4 = a quarter of a 4 km cell at ≥ 16 dBZ, on average.
        if (wet && q >= 4) wet[j * tx + i]++;
      }
    }
  }
}

/** `passes` × [1,2,1]/4 along x then y, for each of the K values of a tile. */
function joinTiles(a: Float32Array, tx: number, ty: number, K: number, passes: number) {
  if (passes <= 0) return;
  const tmp = new Float32Array(Math.max(tx, ty) * K);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < ty; j++) {
      const row = j * tx * K;
      for (let i = 0; i < tx; i++) {
        const il = i > 0 ? i - 1 : i;
        const ir = i < tx - 1 ? i + 1 : i;
        for (let k = 0; k < K; k++) tmp[i * K + k] = 0.25 * a[row + il * K + k] + 0.5 * a[row + i * K + k] + 0.25 * a[row + ir * K + k];
      }
      for (let q = 0; q < tx * K; q++) a[row + q] = tmp[q];
    }
    for (let i = 0; i < tx; i++) {
      for (let j = 0; j < ty; j++) {
        const jl = j > 0 ? j - 1 : j;
        const jr = j < ty - 1 ? j + 1 : j;
        for (let k = 0; k < K; k++) tmp[j * K + k] = 0.25 * a[(jl * tx + i) * K + k] + 0.5 * a[(j * tx + i) * K + k] + 0.25 * a[(jr * tx + i) * K + k];
      }
      for (let j = 0; j < ty; j++) for (let k = 0; k < K; k++) a[(j * tx + i) * K + k] = tmp[j * K + k];
    }
  }
}

function median(a: number[]): number {
  if (!a.length) return 0;
  a.sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

function weightedMedian(vals: number[], wts: number[]): number {
  const idx = vals.map((_, i) => i).sort((p, q) => vals[p] - vals[q]);
  let total = 0;
  for (const w of wts) total += w;
  if (!(total > 0)) return 0;
  let acc = 0;
  for (const i of idx) {
    acc += wts[i];
    if (acc >= total / 2) return vals[i];
  }
  return vals[idx[idx.length - 1]];
}

/**
 * The smooth field, by successive over-relaxation (red/black sweeps):
 *
 *   minimise  Σ (d − m)ᵀ W (d − m)            each node's own measurement
 *           + smooth · Σ |d − neighbour|²      neighbours agree
 *           + pw · |d − prior|²                the coarser level's answer
 *           + a whisper towards (gx, gy)       so nodes with no rain anywhere
 *                                              near still have an answer
 *
 * W is zero for nodes without a trusted measurement; those are filled from
 * their surroundings. dx, dy hold the starting guess and receive the result.
 */
function relax(dx: Float32Array, dy: Float32Array, tx: number, ty: number, wxx: Float32Array, wxy: Float32Array, wyy: Float32Array, mx: Float32Array, my: Float32Array, px: Float32Array, py: Float32Array, pw: Float32Array, gx: number, gy: number, smooth: number, iters: number) {
  const TINY = 1e-4;
  const OMEGA = 1.85;
  for (let it = 0; it < iters; it++) {
    for (let colour = 0; colour < 2; colour++)
      for (let j = 0; j < ty; j++)
        for (let i = (j + colour) & 1; i < tx; i += 2) {
          const id = j * tx + i;
          let sx = 0;
          let sy = 0;
          let deg = 0;
          if (i > 0) {
            sx += dx[id - 1];
            sy += dy[id - 1];
            deg++;
          }
          if (i < tx - 1) {
            sx += dx[id + 1];
            sy += dy[id + 1];
            deg++;
          }
          if (j > 0) {
            sx += dx[id - tx];
            sy += dy[id - tx];
            deg++;
          }
          if (j < ty - 1) {
            sx += dx[id + tx];
            sy += dy[id + tx];
            deg++;
          }
          const pp = pw[id];
          const b = wxy[id];
          const a = smooth * deg + TINY + pp + wxx[id];
          const d = smooth * deg + TINY + pp + wyy[id];
          const rx = smooth * sx + TINY * gx + pp * px[id] + wxx[id] * mx[id] + b * my[id];
          const ry = smooth * sy + TINY * gy + pp * py[id] + b * mx[id] + wyy[id] * my[id];
          const det = a * d - b * b;
          dx[id] += OMEGA * ((d * rx - b * ry) / det - dx[id]);
          dy[id] += OMEGA * ((a * ry - b * rx) / det - dy[id]);
        }
  }
}

/**
 * One level: match every tile-window, drop what cannot be trusted, and solve
 * for the smooth field. `prior` is the coarser level's field (null on the
 * first level); the older pictures are moved by it first, so only the small
 * remaining shift is searched here.
 */
function solveLevel(pairs: Pair[], w0: number, h0: number, lv: LevelSettings, st: MotionSettings, fullSearch: number, prior: LevelField | null, box0: Box): LevelField | null {
  const p = lv.pool;
  const s = lv.tile;
  const w = Math.floor(w0 / p);
  const h = Math.floor(h0 / p);
  const tx = Math.floor(w / s);
  const ty = Math.floor(h / s);
  if (tx < 3 || ty < 3) return null;
  const R = lv.search > 0 ? lv.search : Math.max(1, Math.ceil(fullSearch / p));
  const side = 2 * R + 1;
  const K = side * side;
  // Only the part of the grid that has rain in it (plus room for the search).
  const pad = R + s * (2 * lv.windowPasses + 1);
  const box: Box = {
    x0: Math.max(0, Math.floor(box0.x0 / p) - pad),
    y0: Math.max(0, Math.floor(box0.y0 / p) - pad),
    x1: Math.min(tx * s, Math.ceil(box0.x1 / p) + pad),
    y1: Math.min(ty * s, Math.ceil(box0.y1 / p) + pad),
  };
  // Snap to tile edges so every tile is either fully inside or fully outside.
  box.x0 = Math.floor(box.x0 / s) * s;
  box.y0 = Math.floor(box.y0 / s) * s;
  box.x1 = Math.min(tx * s, Math.ceil(box.x1 / s) * s);
  box.y1 = Math.min(ty * s, Math.ceil(box.y1 / s) * s);
  if (box.x1 <= box.x0 || box.y1 <= box.y0) return null;

  const cb = new Float32Array(tx * ty * K);
  const cf = new Float32Array(tx * ty * K);
  const energy = new Float32Array(tx * ty);
  const wet = new Float32Array(tx * ty);
  for (const pr of pairs) {
    const N = poolMean(pr.N, w0, h0, p).a;
    let O = poolMean(pr.O, w0, h0, p).a;
    if (prior) O = warpByField(O, w, h, prior, p, box);
    tileCosts(N, O, w, h, s, R, box, tx, ty, cb, cf);
    tileStats(N, w, s, box, tx, ty, energy, wet);
    tileStats(O, w, s, box, tx, ty, energy, null);
  }
  joinTiles(cb, tx, ty, K, lv.windowPasses);
  joinTiles(cf, tx, ty, K, lv.windowPasses);
  joinTiles(energy, tx, ty, 1, lv.windowPasses);
  joinTiles(wet, tx, ty, 1, lv.windowPasses);

  const n = tx * ty;
  const step = s * p;
  const out: LevelField = {
    nx: tx,
    ny: ty,
    x0: (s * p) / 2 - 0.5,
    y0: (s * p) / 2 - 0.5,
    step,
    dx: new Float32Array(n),
    dy: new Float32Array(n),
    conf: new Float32Array(n),
    valid: new Uint8Array(n),
    wet: new Float32Array(n),
    wetNodes: 0,
    validNodes: 0,
    matchQuality: 0,
  };
  // Per node: the measured shift (this level's cells) and its 2×2 weight.
  const mx = new Float32Array(n);
  const my = new Float32Array(n);
  const wxx = new Float32Array(n);
  const wxy = new Float32Array(n);
  const wyy = new Float32Array(n);
  const mism = new Float32Array(n);
  // Prior at each node (input-grid cells per lag).
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  const pc = new Float32Array(n);
  if (prior)
    for (let j = 0; j < ty; j++)
      for (let i = 0; i < tx; i++) {
        const X = out.x0 + i * step;
        const Y = out.y0 + j * step;
        px[j * tx + i] = fieldAt(prior, prior.dx, X, Y);
        py[j * tx + i] = fieldAt(prior, prior.dy, X, Y);
        pc[j * tx + i] = fieldAt(prior, prior.conf, X, Y);
      }

  const cellsPerTile = s * s * pairs.length;
  const scales: number[] = [];
  for (let id = 0; id < n; id++) {
    const wetFrac = wet[id] / cellsPerTile;
    out.wet[id] = wetFrac;
    if (wetFrac < st.minWet) continue;
    out.wetNodes++;
    const base = id * K;
    let best = Infinity;
    let bk = 0;
    let bestB = Infinity;
    let kB = 0;
    let bestF = Infinity;
    let kF = 0;
    for (let k = 0; k < K; k++) {
      const b = cb[base + k];
      const f = cf[base + k];
      const c = b + f;
      if (c < best) {
        best = c;
        bk = k;
      }
      if (b < bestB) {
        bestB = b;
        kB = k;
      }
      if (f < bestF) {
        bestF = f;
        kF = k;
      }
    }
    const bx = (bk % side) - R;
    const by = Math.floor(bk / side) - R;
    // A minimum on the edge of the search is not a minimum: the true shift is
    // further out (or the match is unrelated). No vector from this node.
    if (Math.abs(bx) === R || Math.abs(by) === R) continue;
    if (st.fbTolerance >= 0) {
      const fbx = Math.abs((kB % side) - (kF % side));
      const fby = Math.abs(Math.floor(kB / side) - Math.floor(kF / side));
      if (fbx > st.fbTolerance || fby > st.fbTolerance) continue;
    }
    const E = 2 * energy[id];
    if (!(E > 0)) continue;
    const q = best / E;
    if (q > st.maxMismatch) continue;
    // Least-squares 2D quadratic through the 3×3 costs round the minimum.
    const c = (ix: number, iy: number) => cb[base + (by + iy + R) * side + bx + ix + R] + cf[base + (by + iy + R) * side + bx + ix + R];
    const c00 = c(-1, -1), c10 = c(0, -1), c20 = c(1, -1);
    const c01 = c(-1, 0), c11 = c(0, 0), c21 = c(1, 0);
    const c02 = c(-1, 1), c12 = c(0, 1), c22 = c(1, 1);
    const gx = (c20 + c21 + c22 - c00 - c01 - c02) / 6;
    const gy = (c02 + c12 + c22 - c00 - c10 - c20) / 6;
    let hxx = (c00 + c01 + c02 + c20 + c21 + c22 - 2 * (c10 + c11 + c12)) / 3;
    let hyy = (c00 + c10 + c20 + c02 + c12 + c22 - 2 * (c01 + c11 + c21)) / 3;
    let hxy = (c22 + c00 - c20 - c02) / 4;
    // Keep the curvature non-negative in every direction.
    const tr = hxx + hyy;
    const det = hxx * hyy - hxy * hxy;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
    const l1 = tr / 2 + disc;
    const l2 = tr / 2 - disc;
    if (!(l1 > 0)) continue;
    if (l2 < 0) {
      // Project onto the one direction that does curve upwards.
      let ex = hxy;
      let ey = l1 - hxx;
      if (Math.abs(ex) + Math.abs(ey) < 1e-12) {
        ex = l1 - hyy;
        ey = hxy;
      }
      const en = Math.hypot(ex, ey) || 1;
      ex /= en;
      ey /= en;
      hxx = l1 * ex * ex;
      hxy = l1 * ex * ey;
      hyy = l1 * ey * ey;
    }
    // Sub-cell offset: minimum of the quadratic, with a little damping so a
    // flat direction (along a band) stays at the whole-cell answer.
    const lam = 0.02 * l1;
    const a11 = hxx + lam;
    const a22 = hyy + lam;
    const dd = a11 * a22 - hxy * hxy;
    let sx = -(a22 * gx - hxy * gy) / dd;
    let sy = -(a11 * gy - hxy * gx) / dd;
    if (sx > 1) sx = 1;
    else if (sx < -1) sx = -1;
    if (sy > 1) sy = 1;
    else if (sy < -1) sy = -1;
    mx[id] = bx + sx;
    my[id] = by + sy;
    // Weight = curvature over the leftover mismatch: sharp, clean minima
    // count for most. (For independent errors this is the inverse variance
    // of the shift, up to a constant.)
    const noise = best + 0.02 * E;
    wxx[id] = hxx / noise;
    wxy[id] = hxy / noise;
    wyy[id] = hyy / noise;
    mism[id] = q;
    out.valid[id] = 1;
    scales.push((wxx[id] + wyy[id]) / 2);
  }
  if (!scales.length) {
    // Nothing matched on this level: keep the coarser answer where there is one.
    if (!prior) return null;
    for (let id = 0; id < n; id++) {
      out.dx[id] = px[id];
      out.dy[id] = py[id];
    }
    return out;
  }
  // Weights relative to a typical node, and capped, so the smoothness setting
  // means the same thing whatever the rain looks like.
  const scale = median(scales) || 1;
  const CAP = 4;
  for (let id = 0; id < n; id++) {
    if (!out.valid[id]) continue;
    let a = wxx[id] / scale;
    let b = wxy[id] / scale;
    let d = wyy[id] / scale;
    const tr = a + d;
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (a * d - b * b)));
    const l1 = tr / 2 + disc;
    if (l1 > CAP) {
      const f = CAP / l1;
      a *= f;
      b *= f;
      d *= f;
    }
    wxx[id] = a;
    wxy[id] = b;
    wyy[id] = d;
    // To input-grid cells per lag, on top of the prior the picture was moved by.
    mx[id] = mx[id] * p + px[id];
    my[id] = my[id] * p + py[id];
  }

  // Rain-weighted median of the measured shifts: the far-field value.
  const mvx: number[] = [];
  const mvy: number[] = [];
  const mw: number[] = [];
  for (let id = 0; id < n; id++)
    if (out.valid[id]) {
      mvx.push(mx[id]);
      mvy.push(my[id]);
      mw.push(out.wet[id]);
    }
  const gx0 = weightedMedian(mvx, mw);
  const gy0 = weightedMedian(mvy, mw);

  // The solve (see relax): data + smoothness + a pull towards the coarser
  // level's answer where that answer was itself well founded.
  const dx = out.dx;
  const dy = out.dy;
  const pw = new Float32Array(n);
  for (let id = 0; id < n; id++) {
    dx[id] = prior ? px[id] : gx0;
    dy[id] = prior ? py[id] : gy0;
    pw[id] = prior ? st.priorPull * pc[id] : 0;
    if (!out.valid[id]) wxx[id] = wxy[id] = wyy[id] = 0;
  }
  let mq = 0;
  for (let id = 0; id < n; id++)
    if (out.valid[id]) {
      out.validNodes++;
      mq += 1 - mism[id];
    }
  out.matchQuality = out.validNodes ? mq / out.validNodes : 0;
  relax(dx, dy, tx, ty, wxx, wxy, wyy, mx, my, px, py, pw, gx0, gy0, st.smooth, prior ? 120 : 400);
  // Confidence: the weaker of the node's two directions, 0–1.
  for (let id = 0; id < n; id++) {
    if (!out.valid[id]) continue;
    const tr = wxx[id] + wyy[id];
    const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (wxx[id] * wyy[id] - wxy[id] * wxy[id])));
    const l2 = Math.max(0, tr / 2 - disc);
    out.conf[id] = l2 / (l2 + 0.25);
  }
  return out;
}

/**
 * The strengthening / weakening TREND that rides along with the rain.
 *
 * Once the motion is known, each older picture is moved onto its newer
 * partner; what is left over (newer − moved older) is change that the motion
 * does not explain — rain areas filling in or thinning out. Averaged over
 * each node's tile and all pairs, limited to ±MAX per minute (a radar
 * dropping in or out of the composite makes a huge false "trend"; the limit
 * keeps that from being believed) and smoothed over the nodes, so only the
 * broad pattern (tens of km) is kept — single showers flicker too fast for a
 * trend to mean anything.
 */
function trendField(pairs: Pair[], cw: number, ch: number, f: LevelField, lagMin: number, passes: number, box: Box): Float32Array {
  const n = f.nx * f.ny;
  const t = new Float32Array(n);
  const s = f.step;
  for (const pr of pairs) {
    const moved = warpByField(pr.O, cw, ch, f, 1, box);
    for (let y = box.y0; y < box.y1; y++) {
      const j = Math.floor(y / s);
      if (j >= f.ny) break;
      for (let x = box.x0; x < box.x1; x++) {
        const i = Math.floor(x / s);
        if (i >= f.nx) break;
        t[j * f.nx + i] += pr.N[y * cw + x] - moved[y * cw + x];
      }
    }
  }
  const MAX = 0.2; // per minute: 3 units in 15 minutes
  const norm = 1 / (s * s * pairs.length * lagMin);
  for (let id = 0; id < n; id++) {
    const v = t[id] * norm;
    t[id] = v > MAX ? MAX : v < -MAX ? -MAX : v;
  }
  joinTiles(t, f.nx, f.ny, 1, passes);
  return t;
}

/**
 * Which pictures are compared: every [newer, older] pair of ages exactly
 * `lagMin` apart, newest first, at most `maxPairs` of them.
 */
export function pairAges(ages: number[], lagMin: number, maxPairs: number): [number, number][] {
  const have = new Set(ages);
  const out: [number, number][] = [];
  for (const a of [...have].sort((p, q) => p - q)) if (have.has(a + lagMin) && out.length < maxPairs) out.push([a, a + lagMin]);
  return out;
}

/**
 * The motion estimate from a short run of pictures on one coarse grid.
 *
 * @param frames  pictures on a cw × ch grid (see CoarseFrame), any order
 * @param cellKm  size of one grid cell in km (used only for the speed limit)
 * @returns null when no pair of pictures the right distance apart exists, or
 *          no rain could be matched at all.
 */
export function estimateMotion(frames: CoarseFrame[], cw: number, ch: number, cellKm: number, settings: Partial<MotionSettings> = {}): MotionField | null {
  const st: MotionSettings = { ...MOTION_DEFAULTS, ...settings };
  const byAge = new Map<number, Float32Array>();
  for (const f of frames) byAge.set(f.ageMin, f.a);
  const pairs: Pair[] = pairAges([...byAge.keys()], st.lagMin, st.maxPairs).map(([n, o]) => ({ N: byAge.get(n)!, O: byAge.get(o)! }));
  if (!pairs.length) return null;

  // Where there is rain at all, in any picture used.
  const box: Box = { x0: cw, y0: ch, x1: 0, y1: 0 };
  for (const pr of pairs)
    for (const a of [pr.N, pr.O])
      for (let y = 0; y < ch; y++) {
        const row = y * cw;
        let first = -1;
        let last = -1;
        for (let x = 0; x < cw; x++)
          if (a[row + x] > 0) {
            if (first < 0) first = x;
            last = x;
          }
        if (first < 0) continue;
        if (first < box.x0) box.x0 = first;
        if (last + 1 > box.x1) box.x1 = last + 1;
        if (y < box.y0) box.y0 = y;
        if (y + 1 > box.y1) box.y1 = y + 1;
      }
  if (box.x1 <= box.x0) return null;

  const fullSearch = (st.maxKmh * (st.lagMin / 60)) / cellKm + 1; // +1: the edge itself is not accepted
  let field: LevelField | null = null;
  for (const lv of st.levels) {
    const next = solveLevel(pairs, cw, ch, lv, st, fullSearch, field, box);
    if (!next) {
      if (!field) return null;
      break;
    }
    field = next;
  }
  if (!field) return null;

  const n = field.nx * field.ny;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const perMin = 1 / st.lagMin;
  const sx: number[] = [];
  const sy: number[] = [];
  const sw: number[] = [];
  for (let id = 0; id < n; id++) {
    u[id] = field.dx[id] * perMin;
    v[id] = field.dy[id] * perMin;
    if (field.valid[id]) {
      sx.push(u[id]);
      sy.push(v[id]);
      sw.push(field.wet[id]);
    }
  }
  return {
    nx: field.nx,
    ny: field.ny,
    x0: field.x0,
    y0: field.y0,
    step: field.step,
    u,
    v,
    conf: field.conf,
    validNodes: field.validNodes,
    wetNodes: field.wetNodes,
    pairsUsed: pairs.length,
    matchQuality: field.matchQuality,
    medianU: weightedMedian(sx, sw),
    medianV: weightedMedian(sy, sw),
    trend: trendField(pairs, cw, ch, field, st.lagMin, st.trendPasses, box),
  };
}
