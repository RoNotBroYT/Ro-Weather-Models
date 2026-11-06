// The 3D radar surface: how rain intensity (dBZ) becomes a height, and how
// that height field is smoothed and sampled into a map tile.
//
// ONE definition, used by the server's height tiles
// (src/lib/server/radar24.ts) and by the browser's (src/components/radar3d.ts),
// so the website's 3D view, the broadcast 3D and the video renderer cannot
// drift apart. Before this file the height law was written three times, two
// different ways. Pure maths only: no Node, no DOM, no imports.
//
// WHAT THE HEIGHT IS — AND IS NOT
//
// The radar gives REFLECTIVITY ONLY: one number per place, the strongest echo
// in the column above it. The surface is a picture of that number — heavier
// rain is drawn higher. It is NOT cloud height, NOT an echo top and NOT a
// measured altitude of anything; a 10 km dome means "about 47 dBZ here",
// nothing more. Every label in the UI has to keep saying so.
//
// THE METHOD, IN ORDER
//
//   1. Height law. Each radar cell's dBZ becomes a height (dbzToHeightM).
//   2. Smoothing. The HEIGHTS are averaged with a Gaussian whose width is set
//      in kilometres (demSigmaKm), not in pixels: 1 km at radar resolution,
//      wider only when a tile pixel is itself bigger than that.
//   3. Sampling. The smooth surface is read at the points where MapLibre
//      places the tile's pixels (see "WHAT MAPLIBRE DOES WITH A TILE" below).
//
// WHY HEIGHTS ARE SMOOTHED, RATHER THAN THE RAIN FIELD
//
// The other order — smooth dBZ (or rain power) first, then apply the height
// law — was considered and rejected, for four reasons:
//
//   a. What the 3D mesh samples is the height. A low-pass filter only
//      protects a sampled signal if it is the LAST thing done to it; a curved
//      law applied afterwards puts fine structure straight back.
//   b. Averaging heights keeps the volume under the surface. That is exactly
//      what makes a zoomed-out tile the average of its four children. The law
//      is convex, so smoothing dBZ first sinks every storm a little more with
//      each zoom-out (the mean of a curve is not the curve of the mean).
//   c. "No echo" has no dBZ. The files mark it with a flag (−32 here), not a
//      measurement, so an average across the edge of the rain depends on
//      whatever number the flag happens to be. As a height, no rain is
//      exactly 0 and the average means something.
//   d. Averaging rain POWER (as the colour tiles' optional smoothing does)
//      spreads cores outwards: one 50 dBZ cell becomes a dome several km wide,
//      raising ground the colours show as dry. Measured in
//      scripts/validate-dem.ts ("order of operations").
//
// The cost, stated plainly: any smoothing lowers narrow peaks. Measured by the
// validator on Gaussian storms: one 12 km wide (standard deviation of its dBZ)
// keeps 99% of its peak height, 4 km wide 89%, 1.5 km wide 50%, and a single
// isolated 1 km cell 16% — the same at every zoom from 7 in. (The old tiles
// kept 3% of that single cell at zoom 8 and 34% at zoom 10: how tall a small
// storm stood depended on how far in you had zoomed.)
//
// WHAT MAPLIBRE DOES WITH A TILE
//
// Read from its source (maplibre-gl 5.9.0), not measured on a screen:
//
//   Where a pixel is. The terrain reads pixel i of a raster-dem tile as the
//   height at tile fraction i / size — the pixel's top-left CORNER, not its
//   centre (render/terrain.ts getDEMElevation; the get_elevation shader,
//   coord = pos × dim). The tile's right and bottom edges are filled in from
//   the neighbouring tile's first column and row. So heights are sampled at
//   corners here. Sampling at centres, as before, put the whole surface half
//   a height-pixel north-west of the rain colours draped over it.
//
//   How much of a tile it uses. The terrain mesh is 128 × 128 quads per 512 px
//   of map (Terrain.meshSize; TerrainSourceCache.tileSize), and each mesh tile
//   reads the height tile one zoom level up (deltaZoom = 1) — a quarter of it,
//   128 × 128 pixels of a 256 px tile. One vertex per pixel, exactly. A 512 px
//   height tile would have every second pixel skipped, so none is offered;
//   more pixels on the screen (4K) do not change this, the mesh is counted in
//   CSS pixels. Past the source's maxzoom the deepest tile is stretched, read
//   by straight lines between pixels; because this surface holds nothing
//   finer than 1 km, zoom 10 tiles differ from a stretched zoom 8 tile by
//   about 1% of the peak (validator, "RESOLUTION").
//
//   Height against width. Metres are turned into map units with ONE factor
//   for the whole view, the scale at the latitude of the map's CENTRE
//   (mercator_transform.ts: _pixelPerMeter). Widths on a Mercator map
//   stretch by 1 / cos(latitude) at each point's own latitude. So at the
//   centre of the view heights are in true proportion to distances, at 55°N
//   and at 35°N alike; away from it a storm at latitude φ is drawn
//   cos φ ÷ cos(centre) times as tall for its width — within 4% across a view
//   300 km deep over Britain, 11% from one end of Britain to the other, and
//   0.66× at 65°N, 1.27× at 35°N when all of Europe is on screen centred on
//   50°N. Not corrected here: a tile cannot know where the view is centred,
//   and the height is a picture of intensity, not an altitude.

/* ------------------------------------------------------------------ */
/* The height law                                                      */
/* ------------------------------------------------------------------ */

/** Metres per (dBZ above the knee)^HEIGHT_POWER. */
export const HEIGHT_SCALE_M = 110;
/** > 1, so strong cores stand out from a broad area of moderate rain. */
export const HEIGHT_POWER = 1.3;
/** The surface leaves the ground around here. */
export const HEIGHT_KNEE_DBZ = 15;
/** Width of the rounded toe, in dB. */
export const HEIGHT_TOE_DB = 2;
/** Below this the height is exactly 0 (the law would give 0.02 mm there). */
const HEIGHT_MIN_DBZ = -10;
/** Above this the law is held flat, so a corrupt value cannot build a 100 km spire. */
const HEIGHT_MAX_DBZ = 80;

/**
 * Height in metres for a reflectivity, BEFORE the 3D view's own exaggeration
 * (×2 by default, ×1–5 on the slider).
 *
 *   h = 110 × s^1.3,   s = 2 × ln(1 + e^((dBZ − 15) / 2))
 *
 * `s` is "dBZ above 15" with the corner at 15 rounded off: from about 21 dBZ
 * up it IS dBZ − 15 to within 0.1 dB, so the law is the one this site has
 * always used — 2.2 km at 25 dBZ, 5.4 km at 35, 11.2 km at 50. Below that it
 * eases to the ground instead of meeting it in a crease: 10 m at 10 dBZ (the
 * faintest rain the colour tiles draw), 170 m at 15, 930 m at 20. The old law
 * was flat zero up to 15 dBZ and then rose with infinite curvature, which is
 * the hard foot visible round every shower.
 *
 * NaN and "no echo" give 0. Rain intensity, not cloud height.
 */
export function dbzToHeightM(dbz: number): number {
  if (!(dbz > HEIGHT_MIN_DBZ)) return 0;
  const u = ((dbz > HEIGHT_MAX_DBZ ? HEIGHT_MAX_DBZ : dbz) - HEIGHT_KNEE_DBZ) / HEIGHT_TOE_DB;
  const s = u > 30 ? u * HEIGHT_TOE_DB : HEIGHT_TOE_DB * Math.log1p(Math.exp(u));
  return HEIGHT_SCALE_M * Math.pow(s, HEIGHT_POWER);
}

// The same law from a table (steps of 1/16 dB, straight lines between), for
// the loops that convert a few hundred thousand cells per tile. The validator
// checks it against dbzToHeightM: the largest difference is under 2 cm, and a
// height tile's own step is 10 cm.
const LUT_PER_DB = 16;
const LUT_N = (HEIGHT_MAX_DBZ - HEIGHT_MIN_DBZ) * LUT_PER_DB;
let lut: Float32Array | null = null;

/** dbzToHeightM, from a table. */
export function heightOfDbz(dbz: number): number {
  if (!(dbz > HEIGHT_MIN_DBZ)) return 0;
  if (!lut) {
    lut = new Float32Array(LUT_N + 2);
    for (let i = 0; i <= LUT_N + 1; i++) lut[i] = dbzToHeightM(HEIGHT_MIN_DBZ + i / LUT_PER_DB);
    lut[0] = 0;
  }
  const p = ((dbz > HEIGHT_MAX_DBZ ? HEIGHT_MAX_DBZ : dbz) - HEIGHT_MIN_DBZ) * LUT_PER_DB;
  const i = p | 0;
  return lut[i] + (lut[i + 1] - lut[i]) * (p - i);
}

/* ------------------------------------------------------------------ */
/* How much to smooth                                                  */
/* ------------------------------------------------------------------ */

const EARTH_CIRCUMFERENCE_KM = 40075.017;
const DEG = Math.PI / 180;

/** Smoothing at radar resolution: a Gaussian of this standard deviation, in km. */
export const DEM_SIGMA_KM = 1;
/** …and never narrower than this many height-tile pixels (measured at DEM_REF_LAT). */
export const DEM_SIGMA_PIXELS = 0.7;
/** The latitude at which a "pixel" is measured for that rule. Mid-Europe. */
export const DEM_REF_LAT = 50;

/** Ground size of one pixel of a `tilePx`-pixel Web-Mercator tile, in km. */
export function tilePixelKm(z: number, lat: number, tilePx = 256): number {
  return (EARTH_CIRCUMFERENCE_KM * Math.cos(lat * DEG)) / (tilePx * 2 ** z);
}

/**
 * The standard deviation of the smoothing, in km, for height tiles at zoom z.
 *
 * 1 km wherever a tile can show it (zoom 7 and deeper): enough that the 1 km
 * radar cells stop reading as facets and single cells stop standing as
 * needles, and no more — the surface stays as detailed as the radar. From
 * zoom 6 outwards a tile pixel is itself bigger than that, and the mesh draws
 * one vertex per pixel, so anything narrower than a pixel would alias into
 * spikes that flicker as storms cross the pixel grid; there the width is 0.7
 * of a pixel, at which the finest ripple a pixel grid can hold is cut to
 * under a tenth. No wider than that, so zoomed-out storms are not melted
 * together: they are averaged over about the area one pixel covers.
 *
 * It depends on the ZOOM ONLY — not on the tile — so two neighbouring tiles
 * are always cut from the same surface. (A width that followed each tile's
 * own latitude would differ across every horizontal tile edge.)
 */
export function demSigmaKm(z: number): number {
  return Math.max(DEM_SIGMA_KM, DEM_SIGMA_PIXELS * tilePixelKm(z, DEM_REF_LAT));
}

/**
 * How many radar cells are averaged into one block before smoothing: the
 * largest power of two that is still no bigger than the smoothing width (1 at
 * zoom 6 and deeper for the 1 km OPERA grid, 2 at zoom 5, 4 at zoom 4 …).
 * Blocks are counted from the grid's own corner, never from the tile, so
 * every tile sees the same blocks.
 */
export function demPoolFactor(z: number, cellKm: number): number {
  const r = demSigmaKm(z) / cellKm;
  return r >= 2 ? 2 ** Math.floor(Math.log2(r)) : 1;
}

/**
 * Gaussian weights for offsets −R…R (R = 3 standard deviations, rounded up),
 * adding up to 1. `sigma` is in samples; under a quarter of a sample there is
 * nothing to do and the kernel is the single weight [1].
 */
export function gaussianKernel(sigma: number): Float32Array {
  if (!(sigma > 0.25)) return new Float32Array([1]);
  const R = Math.ceil(3 * sigma);
  const k = new Float32Array(2 * R + 1);
  let sum = 0;
  for (let i = -R; i <= R; i++) sum += k[i + R] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/**
 * Separable Gaussian blur of a w × h field. Outside the field counts as 0, so
 * values within a kernel radius of the border are short of their full sum —
 * callers read a margin that wide and never use them.
 *
 * Each value is the same weights times the same samples in the same order
 * wherever the window happens to start, so two overlapping windows give
 * bit-identical results where they overlap. That is what makes tile edges
 * agree exactly instead of "to within rounding". (Rows that are all zero —
 * most of a radar picture — are skipped; adding zeros changes nothing.)
 */
export function gaussianBlur(src: Float32Array, w: number, h: number, k: Float32Array): Float32Array {
  const R = (k.length - 1) >> 1;
  if (R === 0) return src;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const live = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let any = false;
    for (let x = 0; x < w; x++)
      if (src[row + x] !== 0) {
        any = true;
        break;
      }
    if (!any) continue;
    live[y] = 1;
    for (let x = 0; x < w; x++) {
      const a = x < R ? -x : -R;
      const b = x + R >= w ? w - 1 - x : R;
      let s = 0;
      for (let i = a; i <= b; i++) s += k[i + R] * src[row + x + i];
      tmp[row + x] = s;
    }
  }
  for (let y = 0; y < h; y++) {
    const a = y < R ? -y : -R;
    const b = y + R >= h ? h - 1 - y : R;
    const row = y * w;
    for (let i = a; i <= b; i++) {
      if (!live[y + i]) continue;
      const kk = k[i + R];
      const srow = (y + i) * w;
      for (let x = 0; x < w; x++) out[row + x] += kk * tmp[srow + x];
    }
  }
  return out;
}

/**
 * Cubic B-spline weights for the four samples round a point `t` (0…1) of the
 * way from the second to the third. Used to read the smoothed radar grid at
 * a tile pixel: unlike the straight-line (bilinear) reading it replaces, the
 * result has no creases at cell boundaries, and unlike a sharper cubic it can
 * never overshoot — heights stay ≥ 0 and no ripples appear beside a core.
 * It is itself a small blur (variance 1/3 of a sample), which the Gaussian
 * before it is narrowed to allow for.
 */
export function bsplineWeights(t: number, out: Float64Array): void {
  const t2 = t * t;
  const t3 = t2 * t;
  const u = 1 - t;
  out[0] = (u * u * u) / 6;
  out[1] = (3 * t3 - 6 * t2 + 4) / 6;
  out[2] = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
  out[3] = t3 / 6;
}
/** The blur a cubic B-spline reading adds, as a variance in samples². */
export const BSPLINE_VARIANCE = 1 / 3;

/* ------------------------------------------------------------------ */
/* Where the data stop                                                 */
/* ------------------------------------------------------------------ */

/**
 * How far a source's surface is trusted at a point, 0…1, from the smoothed
 * COVERAGE there — the share of the smoothing window that source actually
 * scanned: 1 well inside its range, ½ on a straight edge of it, 0 beyond.
 *
 *   share = c ÷ (c + 0.18 × (1 − c))
 *
 * What it is for. Smoothing gives two numbers at each point: `num`, the
 * average height with unscanned cells counted as zero, and `c`. Showing
 * `num` as it stands treats no data as no rain: a band running off the edge
 * of the radars would be halved at the last scanned cell. Dividing by `c`
 * (the average over scanned cells only) keeps it whole, but then the surface
 * ends in a wall where the data stop. The height shown is in between:
 *
 *   height = share × num ÷ c = num ÷ (0.18 + 0.82 × c)
 *
 * which never divides by nothing. On a straight edge that is 97% of the full
 * height one smoothing width inside the range and 84% where the scanned
 * cells end (measured; the old tiles were at 89% and 5% there, a cliff), then
 * a slope about as steep as the one at the edge of real rain (measured: 14%
 * steeper) — as if the rain stopped one smoothing width beyond the data
 * (0.18 is e^−1.7, the constant that makes a logistic curve follow the
 * Gaussian's own).
 *
 * That slope is NOT data. Nothing was measured out there; it exists only so
 * that the place where the data stop is not drawn as a cliff of rain.
 *
 * Where a second source covers the gap, the two are mixed by this share
 * (see demHeights in radar24.ts), so the hand-over is a blend, not a step.
 */
export function coverageShare(c: number): number {
  return c >= 1 ? 1 : c > 0 ? c / (c + COVER_SOFT * (1 - c)) : 0;
}
const COVER_SOFT = 0.18;

/** The height to show from smoothed `num` and coverage `c` (see coverageShare). */
export function coveredHeight(num: number, c: number): number {
  return c > 0 ? num / (COVER_SOFT + (1 - COVER_SOFT) * c) : 0;
}

/* ------------------------------------------------------------------ */
/* Terrain-RGB                                                         */
/* ------------------------------------------------------------------ */

/** Mapbox terrain-RGB: height = −10000 + (R × 65536 + G × 256 + B) × 0.1 m. */
export function encodeTerrainRgb(heights: ArrayLike<number>, rgba: Uint8ClampedArray | Uint8Array): void {
  for (let i = 0, n = heights.length; i < n; i++) {
    const v = Math.round((heights[i] + 10000) / 0.1);
    rgba[i * 4] = (v >> 16) & 255;
    rgba[i * 4 + 1] = (v >> 8) & 255;
    rgba[i * 4 + 2] = v & 255;
    rgba[i * 4 + 3] = 255;
  }
}

/** The height (m) stored in pixel i of terrain-RGB data. */
export function decodeTerrainRgb(rgba: ArrayLike<number>, i: number): number {
  return -10000 + (rgba[i * 4] * 65536 + rgba[i * 4 + 1] * 256 + rgba[i * 4 + 2]) * 0.1;
}

/* ------------------------------------------------------------------ */
/* The surface from a PICTURE of the radar (tile pixels, not a grid)   */
/* ------------------------------------------------------------------ */
//
// NEXRAD and RainViewer arrive as map tiles: dBZ per tile pixel, already in
// Web Mercator. The same three steps are applied in pixel space — by the
// server for its height tiles outside Europe, and by the browser for frames
// it builds itself — through this one function, so both give the same surface
// from the same picture.

/** Latitude (degrees) of a Web-Mercator y given as a fraction of the world, 0 = top. */
function mercatorLat(yFraction: number): number {
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * yFraction))) / DEG;
  // The tile pyramid ends at ±85.05°; rows beyond it exist only as margin.
  return lat > 85.06 ? 85.06 : lat < -85.06 ? -85.06 : lat;
}

/**
 * The Gaussian's standard deviation in SOURCE PIXELS for one pixel row, so
 * that it measures demSigmaKm(z) on the ground at that row's latitude.
 * A function of the row's position on the globe only (never of the tile it
 * was reached from), rounded to 1/64 pixel so rows share kernels.
 * `resampleVar` is the small blur the final corner reading adds.
 */
function rowSigmaPx(n: number, z: number, y: number, rowInTile: number, resampleVar: number): number {
  const lat = mercatorLat((y + (rowInTile + 0.5) / n) / 2 ** z);
  const sp = demSigmaKm(z) / tilePixelKm(z, lat, n);
  return Math.round(Math.sqrt(Math.max(0, sp * sp - resampleVar)) * 64) / 64;
}

/** Reading a pixel-centred field at pixel corners averages neighbours: variance in px². */
const resampleVariance = (n: number, S: number) => (n % S === 0 ? 0.25 : 1 / 6);

/**
 * The margin (in source pixels) surfaceFromPixelDbz needs round a tile for
 * its edges to be exact: the widest kernel any row of the tile, or of the
 * margin itself, can have, plus the pixel the corner reading reaches for.
 * Never more than one whole tile.
 */
export function pixelSurfaceMargin(n: number, z: number, y: number, S = 256): number {
  const rv = resampleVariance(n, S);
  // Kernels widen towards the poles; the margin rows are at most a tile away.
  const worst = Math.max(rowSigmaPx(n, z, y, -n, rv), rowSigmaPx(n, z, y, 2 * n - 1, rv));
  return Math.min(n, Math.ceil(3 * worst) + 2);
}

/**
 * The height surface for one map tile from dBZ given per pixel.
 *
 * @param dbz  (n + 2P)² values, row by row: the tile's n × n pixels plus a
 *             margin of P pixels on every side, each value at its pixel's
 *             CENTRE. NaN = no data there (not "no rain").
 * @param n    source pixels across the tile
 * @param P    margin in source pixels (see pixelSurfaceMargin; with a smaller
 *             one the kernel runs off the window, and the tile's edges ease
 *             down as they would where the data stop)
 * @param S    output size: heights are returned on an S × S grid of pixel
 *             CORNERS (tile fractions 0, 1/S … (S−1)/S), as MapLibre reads them
 * @param z, y the tile's zoom and row — for the latitude, hence km per pixel
 * @param edge also return the tile's far edge (fraction 1): (S+1) × (S+1)
 *             values. Only the validator uses it, to compare a tile's own
 *             idea of its edge with its neighbour's first column.
 * @returns num — smoothed height × coverage (null: no rain anywhere);
 *          cov — smoothed coverage (null: 1 everywhere).
 *          The height to show is coveredHeight(num, cov).
 */
export function surfaceFromPixelDbz(
  dbz: ArrayLike<number>,
  n: number,
  P: number,
  S: number,
  z: number,
  y: number,
  edge = false
): { num: Float32Array | null; cov: Float32Array | null } {
  const W = n + 2 * P;
  const M = S + (edge ? 1 : 0);
  const h = new Float32Array(W * W);
  let cover: Float32Array | null = null;
  let wet = false;
  for (let i = 0; i < W * W; i++) {
    const d = dbz[i];
    if (d !== d) {
      if (!cover) cover = new Float32Array(W * W).fill(1);
      cover[i] = 0;
      continue;
    }
    const v = heightOfDbz(d);
    if (v > 0) {
      h[i] = v;
      wet = true;
    }
  }
  // No rain in reach of this tile: flat, whatever the coverage.
  if (!wet) return { num: null, cov: null };

  // One kernel per window row (they differ only as latitude changes).
  const rv = resampleVariance(n, S);
  const kernels = new Map<number, Float32Array>();
  const rowKernel: Float32Array[] = new Array(W);
  let reach = 0;
  for (let r = 0; r < W; r++) {
    const s = rowSigmaPx(n, z, y, r - P, rv);
    let k = kernels.get(s);
    if (!k) kernels.set(s, (k = gaussianKernel(s)));
    rowKernel[r] = k;
    reach = Math.max(reach, (k.length - 1) >> 1);
  }
  // The pixels the corner reading uses: one before the tile to one after.
  const lo = Math.max(0, P - 1);
  const hi = Math.min(W, P + n + (edge ? 2 : 1));
  // A margin too small for the kernel: weights falling off the window are
  // lost, so divide by the weight that did land (the coverage pass does it).
  if (!cover && (lo - reach < 0 || hi + reach > W)) cover = new Float32Array(W * W).fill(1);

  const blur = (src: Float32Array): Float32Array => {
    // Across: each row with its own kernel, for the columns that are needed.
    // Rows with nothing in them are skipped (adding zeros changes nothing).
    const tmp = new Float32Array(W * W);
    const live = new Uint8Array(W);
    const r0 = Math.max(0, lo - reach);
    const r1 = Math.min(W, hi + reach);
    for (let r = r0; r < r1; r++) {
      const k = rowKernel[r];
      const R = (k.length - 1) >> 1;
      const row = r * W;
      let any = false;
      for (let c = 0; c < W; c++)
        if (src[row + c] !== 0) {
          any = true;
          break;
        }
      if (!any) continue;
      live[r] = 1;
      for (let c = lo; c < hi; c++) {
        const a = c < R ? -c : -R;
        const b = c + R >= W ? W - 1 - c : R;
        let s = 0;
        for (let i = a; i <= b; i++) s += k[i + R] * src[row + c + i];
        tmp[row + c] = s;
      }
    }
    // Down: the kernel of the row being written.
    const out = new Float32Array(W * W);
    for (let r = lo; r < hi; r++) {
      const k = rowKernel[r];
      const R = (k.length - 1) >> 1;
      const a = r < R ? -r : -R;
      const b = r + R >= W ? W - 1 - r : R;
      const row = r * W;
      for (let i = a; i <= b; i++) {
        if (!live[r + i]) continue;
        const kk = k[i + R];
        const srow = (r + i) * W;
        for (let c = lo; c < hi; c++) out[row + c] += kk * tmp[srow + c];
      }
    }
    return out;
  };
  const hs = blur(h);
  const cs = cover ? blur(cover) : null;

  // Read at the output's pixel corners: corner i sits at source position
  // i × n / S, i.e. between pixel centres (i × n / S − ½) ± ½.
  const num = new Float32Array(M * M);
  const cov = cs ? new Float32Array(M * M) : null;
  const at = (f: Float32Array, x0: number, y0: number, tx: number, ty: number) => {
    const xa = x0 < 0 ? 0 : x0;
    const xb = x0 + 1 >= W ? W - 1 : x0 + 1;
    const ya = (y0 < 0 ? 0 : y0) * W;
    const yb = (y0 + 1 >= W ? W - 1 : y0 + 1) * W;
    return (f[ya + xa] * (1 - tx) + f[ya + xb] * tx) * (1 - ty) + (f[yb + xa] * (1 - tx) + f[yb + xb] * tx) * ty;
  };
  for (let j = 0; j < M; j++) {
    const v = (j * n) / S - 0.5 + P;
    const y0 = Math.floor(v);
    const ty = v - y0;
    for (let i = 0; i < M; i++) {
      const u = (i * n) / S - 0.5 + P;
      const x0 = Math.floor(u);
      const tx = u - x0;
      num[j * M + i] = at(hs, x0, y0, tx, ty);
      if (cov) cov[j * M + i] = at(cs!, x0, y0, tx, ty);
    }
  }
  return { num, cov };
}

/**
 * surfaceFromPixelDbz, finished: the heights (m) to put in the tile, with
 * unscanned pixels kept out of the average and the surface eased to the
 * ground where the data stop (coveredHeight). Null = flat, no rain.
 */
export function heightsFromPixelDbz(dbz: ArrayLike<number>, n: number, P: number, S: number, z: number, y: number, edge = false): Float32Array | null {
  const s = surfaceFromPixelDbz(dbz, n, P, S, z, y, edge);
  if (!s.num) return null;
  if (!s.cov) return s.num;
  const out = new Float32Array(s.num.length);
  for (let i = 0; i < out.length; i++) out[i] = coveredHeight(s.num[i], s.cov[i]);
  return out;
}
