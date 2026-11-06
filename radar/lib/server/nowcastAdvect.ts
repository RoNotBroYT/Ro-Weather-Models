// Radar FORECAST by moving the newest picture along the estimated motion —
// the maths only (typed arrays in and out; the caller supplies a function
// that reads the source picture). See radarNowcast.ts for what it is used
// for and nowcastMotion.ts for where the motion and the trend come from.
//
// What it does, for a window of forecast cells:
//
//   1. Where did this rain come from? Each cell is traced BACK along the
//      motion field for the lead time, in steps of at most 10 minutes using
//      the midpoint rule (the motion half a step back decides the step), so
//      curved paths — rain turning round a low — are followed. Only every
//      8th cell is traced; the motion field has one node every 16 km, so the
//      cells in between are interpolated. (Measured in the harness on an
//      exactly known rotation, 60 km/h at 300 km, traced back an hour: these
//      steps miss the origin by 0.01 km, the old first-order 5-minute steps
//      by 0.5 km. Both are small — this is tidier, but it is not where the
//      forecast's error comes from.)
//   2. What is there now? The newest picture is read round those origins.
//      The recent trend is added (rain that has been strengthening is
//      strengthened a little more, fading with lead time — see
//      trendDbPerUnit), and the result is turned into the working value
//      Z^0.4, where Z = 10^(dBZ/10) is rain power; no rain = 0.
//   3. Blur by lead time. The further ahead, the less the small detail can
//      be trusted — showers grow and die in half an hour whatever they are
//      moving at. The working value is averaged with a Gaussian whose width
//      grows with the lead: σ = 0.1 km per minute.
//   4. Each forecast cell takes the blurred value at its origin (bilinear),
//      and is turned back into dBZ.
//
// The blur width, the power 0.4 and the trend's strength were CHOSEN ON THE
// BACKTEST (see ADVECT_DEFAULTS), not picked by eye.
//
// What it cannot do: make rain where there is none now, or turn it. The only
// strengthening or weakening is the recent broad trend continued and fading
// (never more than 7.2 dB, see trendDbPerUnit) — it does not know why the
// rain was changing, so it cannot know when that stops.

/** A motion field in units of the SOURCE grid (1 km cells, cells per minute). */
export interface AdvectField {
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  step: number;
  u: Float32Array;
  v: Float32Array;
  /** Optional, per node: strengthening (+) / weakening (−) per minute (see trendDbPerUnit). */
  trend?: Float32Array;
}

export interface AdvectSettings {
  /** Longest single tracing step (minutes). */
  stepMin: number;
  /** Blur width: σ (km) per minute of lead. 0 = no blur. */
  blurKmPerMin: number;
  /**
   * What is averaged (by the blur and between cells): Z^blurPower. 1 = rain
   * power (strong cores dominate and spread), 0.625 ≈ rain rate, small =
   * close to averaging dBZ.
   */
  blurPower: number;
  /** dB added per unit of the motion's trend per minute. 0 = no trend. */
  trendGain: number;
  /** The trend fades with this time constant (minutes). */
  trendTauMin: number;
}

/**
 * The settings in use — chosen on 11 tuning start times of real OPERA data
 * (development runs scored at 2 km; the reported scores in radarNowcast.ts
 * come from 11 other start times, at 1 km):
 *
 *   blurKmPerMin, blurPower. σ = 0.1 km per minute of lead (1.5 km at +15,
 *     6 km at +60), averaging Z^0.4. Averaging Z itself (what the old code
 *     did) lets strong cores bleed outwards: with the same σ the area of rain
 *     ≥ 20 dBZ came out 1.32× the observed area at +30 and 1.61× at +60.
 *     With Z^0.4 it was 1.03× and 1.02×. Against no blur at all, this blur
 *     lowered the mean error (5.07 → 4.73 dBZ at +30, 6.62 → 5.96 at +60)
 *     and raised the hit scores at 20 and 35 dBZ; the neighbourhood score
 *     (FSS) went DOWN slightly (0.867 → 0.860 at +30) — the price of
 *     softening. The harness's --ablate option shows both sides.
 *     WHAT THE BLUR COSTS, on the 11 scoring start times at 1 km: heavy
 *     cores are flattened, so the forecast shows too LITTLE rain ≥ 35 dBZ —
 *     0.89 of the observed area at +15, 0.85 at +30, 0.75 at +60 (without
 *     blur: 0.94, 0.95, 0.97). The area the map draws (> 10 dBZ) stays close
 *     (1.02, 1.04, 1.07). And the texture goes: a field of scattered showers
 *     becomes one soft area. That is the forecast saying "showers about
 *     here", not "a shower exactly here" — which is all it knows.
 *   trendGain, trendTauMin. 0.6 dB per unit of trend per minute, fading with
 *     a 60-minute time constant. Checked against two controls: the same
 *     amount of strengthening applied everywhere, and the trend map turned
 *     upside down. Neither helped (hit score at 20 dBZ, +60: 0.455 and 0.452
 *     against 0.453 with no trend); the real trend map gave 0.465. Gains of
 *     0.4–1.0 and time constants from 30 minutes to none at all scored
 *     within 0.005 of each other, so these two numbers are not finely tuned.
 *   stepMin. 5, 10 and 30 minute steps scored within 0.002 dBZ of each
 *     other; 10 is used.
 */
export const ADVECT_DEFAULTS: AdvectSettings = {
  stepMin: 10,
  blurKmPerMin: 0.1,
  blurPower: 0.4,
  trendGain: 0.6,
  trendTauMin: 60,
};

export const NOWCAST_NODATA = -9999;
/** dBZ written for "scanned, no rain". */
const DRY_DBZ = -32;

/** Blur width (σ, km) for a lead time (minutes). */
export function blurSigmaKm(leadMin: number, st: AdvectSettings = ADVECT_DEFAULTS): number {
  return Math.max(0, st.blurKmPerMin * leadMin);
}

/**
 * dB to add to rain per unit of trend, for a lead time: the recent trend
 * continued, but fading — gain · τ · (1 − e^(−lead/τ)). At short leads that
 * is gain · lead; it levels off at gain · τ, because nothing strengthens for
 * ever. The trend itself is limited to ±0.2 a minute where it is estimated
 * (nowcastMotion.ts), so with the settings in use no cell is ever changed by
 * more than 0.2 · 0.6 · 60 = 7.2 dB, and by at most 4.6 dB at +60 minutes.
 */
export function trendDbPerUnit(leadMin: number, st: AdvectSettings = ADVECT_DEFAULTS): number {
  if (!(st.trendGain > 0)) return 0;
  const tau = st.trendTauMin;
  return st.trendGain * (tau > 0 ? tau * (1 - Math.exp(-leadMin / tau)) : leadMin);
}

/** Bilinear read of the trend at a source-grid position. */
function trendAt(m: AdvectField, t: Float32Array, x: number, y: number): number {
  let fi = (x - m.x0) / m.step;
  let fj = (y - m.y0) / m.step;
  const mxi = m.nx - 1.001;
  const mxj = m.ny - 1.001;
  if (fi < 0) fi = 0;
  else if (fi > mxi) fi = mxi;
  if (fj < 0) fj = 0;
  else if (fj > mxj) fj = mxj;
  const i0 = Math.floor(fi);
  const j0 = Math.floor(fj);
  const tx = fi - i0;
  const ty = fj - j0;
  const k = j0 * m.nx + i0;
  return t[k] * (1 - tx) * (1 - ty) + t[k + 1] * tx * (1 - ty) + t[k + m.nx] * (1 - tx) * ty + t[k + m.nx + 1] * tx * ty;
}

function velAt(m: AdvectField, x: number, y: number, out: Float64Array): void {
  let fi = (x - m.x0) / m.step;
  let fj = (y - m.y0) / m.step;
  const mxi = m.nx - 1.001;
  const mxj = m.ny - 1.001;
  if (fi < 0) fi = 0;
  else if (fi > mxi) fi = mxi;
  if (fj < 0) fj = 0;
  else if (fj > mxj) fj = mxj;
  const i0 = Math.floor(fi);
  const j0 = Math.floor(fj);
  const tx = fi - i0;
  const ty = fj - j0;
  const k = j0 * m.nx + i0;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  out[0] = m.u[k] * w00 + m.u[k + 1] * w10 + m.u[k + m.nx] * w01 + m.u[k + m.nx + 1] * w11;
  out[1] = m.v[k] * w00 + m.v[k + 1] * w10 + m.v[k + m.nx] * w01 + m.v[k + m.nx + 1] * w11;
}

/**
 * Where the rain arriving at (x, y) after `leadMin` minutes is NOW: traced
 * back along the field with midpoint steps. Writes [x, y] into `out`.
 */
export function traceBack(m: AdvectField, x: number, y: number, leadMin: number, stepMin: number, out: Float64Array): void {
  const steps = Math.max(1, Math.ceil(leadMin / stepMin));
  const dt = leadMin / steps;
  for (let s = 0; s < steps; s++) {
    velAt(m, x, y, out);
    const hx = x - 0.5 * dt * out[0];
    const hy = y - 0.5 * dt * out[1];
    velAt(m, hx, hy, out);
    x -= dt * out[0];
    y -= dt * out[1];
  }
  out[0] = x;
  out[1] = y;
}

/** Separable Gaussian, in place, σ in cells. Edges repeat the edge value. */
function gaussianBlur(a: Float32Array, w: number, h: number, sigma: number) {
  if (!(sigma > 0.3)) return;
  const R = Math.max(1, Math.ceil(3 * sigma));
  const ker = new Float32Array(2 * R + 1);
  let sum = 0;
  for (let i = -R; i <= R; i++) sum += ker[i + R] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < ker.length; i++) ker[i] /= sum;
  const tmp = new Float32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      if (x >= R && x + R < w) for (let i = -R; i <= R; i++) s += ker[i + R] * a[row + x + i];
      else
        for (let i = -R; i <= R; i++) {
          const q = x + i;
          s += ker[i + R] * a[row + (q < 0 ? 0 : q >= w ? w - 1 : q)];
        }
      tmp[x] = s;
    }
    for (let x = 0; x < w; x++) a[row + x] = tmp[x];
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      if (y >= R && y + R < h) for (let i = -R; i <= R; i++) s += ker[i + R] * a[(y + i) * w + x];
      else
        for (let i = -R; i <= R; i++) {
          const q = y + i;
          s += ker[i + R] * a[(q < 0 ? 0 : q >= h ? h - 1 : q) * w + x];
        }
      tmp[y] = s;
    }
    for (let y = 0; y < h; y++) a[y * w + x] = tmp[y];
  }
}

/**
 * The forecast for the window rows r0…r1, columns c0…c1 of the source grid,
 * thinned to every k-th cell (k = 1: every cell). Returns ceil((c1−c0)/k) ×
 * ceil((r1−r0)/k) values in dBZ; NOWCAST_NODATA where the rain would have
 * come from outside the grid (unknown), −32 where no rain is forecast.
 *
 * `readDbz(R0, R1, C0, C1)` must return the source picture's dBZ for that
 * window, row by row; NaN or anything ≤ −32 counts as no rain.
 */
export function forecastWindow(
  readDbz: (R0: number, R1: number, C0: number, C1: number) => Float32Array,
  rows: number,
  cols: number,
  kmPerCell: number,
  m: AdvectField,
  leadMin: number,
  r0: number,
  r1: number,
  c0: number,
  c1: number,
  k: number,
  st: AdvectSettings = ADVECT_DEFAULTS
): Float32Array {
  const wc = Math.ceil((c1 - c0) / k);
  const wr = Math.ceil((r1 - r0) / k);
  const n = wc * wr;
  const out = new Float32Array(n).fill(NOWCAST_NODATA);
  if (n <= 0) return out;

  // 1. Origins on a lattice with one point every S source cells (S ≈ 8).
  //    The lattice is anchored to the GRID, not to this window, so two
  //    neighbouring tiles interpolate between the very same points and agree
  //    where they meet.
  const S = Math.max(1, Math.round(8 / k)) * k;
  const lc0 = Math.floor(c0 / S) * S;
  const lr0 = Math.floor(r0 / S) * S;
  const lx = Math.floor((c0 - lc0 + (wc - 1) * k) / S) + 2;
  const ly = Math.floor((r0 - lr0 + (wr - 1) * k) / S) + 2;
  const ox = new Float32Array(lx * ly);
  const oy = new Float32Array(lx * ly);
  const tmp = new Float64Array(2);
  let minC = Infinity;
  let maxC = -Infinity;
  let minR = Infinity;
  let maxR = -Infinity;
  for (let j = 0; j < ly; j++)
    for (let i = 0; i < lx; i++) {
      const c = lc0 + i * S + (k - 1) / 2;
      const r = lr0 + j * S + (k - 1) / 2;
      traceBack(m, c, r, leadMin, st.stepMin, tmp);
      ox[j * lx + i] = tmp[0];
      oy[j * lx + i] = tmp[1];
      if (tmp[0] < minC) minC = tmp[0];
      if (tmp[0] > maxC) maxC = tmp[0];
      if (tmp[1] < minR) minR = tmp[1];
      if (tmp[1] > maxR) maxR = tmp[1];
    }

  // 2. The source window: the origins plus room for the blur, widened to
  //    whole k×k blocks of the GRID. The thinning below then averages the
  //    same blocks whichever window is asked for; started from the window's
  //    own corner instead, two neighbouring zoomed-out tiles thinned the rain
  //    differently and disagreed where they met (measured on block-aligned
  //    windows, as the 3D height tiles ask for them: up to 25 dBZ at k = 6).
  const sigmaCells = blurSigmaKm(leadMin, st) / kmPerCell / k; // in thinned cells
  const pad = (Math.ceil(3 * sigmaCells) + 2) * k;
  const R0 = Math.max(0, Math.floor((Math.floor(minR) - pad) / k) * k);
  const R1 = Math.min(rows, Math.ceil((Math.ceil(maxR) + pad + 1) / k) * k);
  const C0 = Math.max(0, Math.floor((Math.floor(minC) - pad) / k) * k);
  const C1 = Math.min(cols, Math.ceil((Math.ceil(maxC) + pad + 1) / k) * k);
  if (R1 <= R0 || C1 <= C0) return out;
  const full = readDbz(R0, R1, C0, C1);
  const fc = C1 - C0;
  const fr = R1 - R0;
  const sw = Math.ceil(fc / k);
  const sh = Math.ceil(fr / k);
  const g = st.blurPower;
  // The trend: rain that has been strengthening keeps strengthening for a
  // while (and the reverse), fading with lead time. It rides with the rain,
  // so it is applied here, at the source, before the rain is moved. Only
  // cells that have rain are changed — it cannot make rain where there is none.
  const tr = m.trend && m.trend.length === m.nx * m.ny ? m.trend : null;
  const perUnit = tr ? trendDbPerUnit(leadMin, st) : 0;
  const change = (c: number, r: number) => perUnit * trendAt(m, tr!, c, r);
  // Working value: Z^g, where Z is rain power. Thinning (k > 1) AVERAGES the
  // power of each k×k block with dry cells counted as zero — not the block's
  // maximum, which made every zoomed-out forecast tile swell.
  const Y = new Float32Array(sw * sh);
  if (k === 1) {
    for (let yy = 0; yy < sh; yy++)
      for (let xx = 0; xx < sw; xx++) {
        const i = yy * sw + xx;
        let d = full[i];
        if (!(d > DRY_DBZ)) continue;
        if (perUnit !== 0) d += change(C0 + xx, R0 + yy);
        Y[i] = Math.pow(10, (d * g) / 10);
      }
  } else {
    for (let yy = 0; yy < sh; yy++)
      for (let xx = 0; xx < sw; xx++) {
        let z = 0;
        let cnt = 0;
        for (let a = 0; a < k; a++) {
          const RR = yy * k + a;
          if (RR >= fr) break;
          for (let b = 0; b < k; b++) {
            const CC = xx * k + b;
            if (CC >= fc) break;
            cnt++;
            const d = full[RR * fc + CC];
            if (d > DRY_DBZ) z += Math.pow(10, d / 10);
          }
        }
        if (!(z > 0)) continue;
        // One trend value for the block (the trend is far smoother than a block).
        const dB = 10 * Math.log10(z / cnt) + (perUnit !== 0 ? change(C0 + xx * k + (k - 1) / 2, R0 + yy * k + (k - 1) / 2) : 0);
        Y[yy * sw + xx] = Math.pow(10, (dB * g) / 10);
      }
  }

  // 3. Blur by lead time.
  gaussianBlur(Y, sw, sh, sigmaCells);

  // 4. Each output cell reads its origin (bilinear between lattice origins,
  //    then bilinear in the source).
  const inv = 10 / g;
  for (let y = 0; y < wr; y++) {
    const fj = (r0 - lr0 + y * k) / S;
    const j0 = Math.floor(fj);
    const ty = fj - j0;
    for (let x = 0; x < wc; x++) {
      const fi = (c0 - lc0 + x * k) / S;
      const i0 = Math.floor(fi);
      const tx = fi - i0;
      const q = j0 * lx + i0;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      const c = ox[q] * w00 + ox[q + 1] * w10 + ox[q + lx] * w01 + ox[q + lx + 1] * w11;
      const r = oy[q] * w00 + oy[q + 1] * w10 + oy[q + lx] * w01 + oy[q + lx + 1] * w11;
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue; // came from outside the radar grid
      const fx = (c - C0 - (k - 1) / 2) / k;
      const fy = (r - R0 - (k - 1) / 2) / k;
      let x0 = Math.floor(fx);
      let y0 = Math.floor(fy);
      let ax = fx - x0;
      let ay = fy - y0;
      // On the very edge of the grid there is no neighbour to blend with.
      if (x0 < 0) {
        x0 = 0;
        ax = 0;
      } else if (x0 + 1 >= sw) {
        x0 = sw - 2;
        ax = 1;
      }
      if (y0 < 0) {
        y0 = 0;
        ay = 0;
      } else if (y0 + 1 >= sh) {
        y0 = sh - 2;
        ay = 1;
      }
      if (x0 < 0 || y0 < 0) continue;
      const i00 = y0 * sw + x0;
      const v = Y[i00] * (1 - ax) * (1 - ay) + Y[i00 + 1] * ax * (1 - ay) + Y[i00 + sw] * (1 - ax) * ay + Y[i00 + sw + 1] * ax * ay;
      out[y * wc + x] = v > 0 ? Math.max(DRY_DBZ, inv * Math.log10(v)) : DRY_DBZ;
    }
  }
  return out;
}
