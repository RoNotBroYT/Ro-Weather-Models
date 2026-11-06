// Reflectivity-based rotation-signature detection ("possible rotation").
//
// IMPORTANT HONESTY NOTE, reflected in all UI that consumes this: real
// rotation detection needs Doppler VELOCITY data (air moving toward/away
// from the radar). RainViewer only provides REFLECTIVITY (precipitation
// intensity), so everything here is inference from storm SHAPE — the same
// morphological cues a trained spotter reads off a reflectivity display:
//   - hook echoes / inflow notches (a curl or bite carved into a storm's
//     flank by rotating inflow),
//   - BWER-like holes (bounded weak echo region: a small pocket of weak
//     echo surrounded by strong echo — rain held aloft by a strong updraft),
//   - tight reflectivity gradients on the notch flank.
// These correlate with rotation but do not prove it. False positives are
// expected. Every detection this module returns must be presented as
// "possible rotation — inferred from reflectivity shape, not measured
// velocity", never as a confirmed mesocyclone.
//
// Data source: RainViewer tiles —
//   {host}{path}/256/{z}/{x}/{y}/2/0_0.png
// with smoothing OFF (the "0" in 0_0 — smoothing interpolates colours that
// aren't in the palette, which would corrupt decoding). The tilecache
// IGNORES the colour-scheme path parameter and always serves the
// "Universal Blue" palette (verified empirically 25 Aug 2026: scheme 0 vs
// 2 vs 4 return byte-identical tiles, and RainViewer's own colour-scheme
// docs now list Universal Blue as the only available scheme). So dBZ is
// recovered via an exact colour->dBZ lookup table built from RainViewer's
// published palette CSV (rainviewer.com/files/rainviewer_api_colors_table.csv)
// — verified against a live storm tile: 24,450/24,450 non-transparent
// pixels matched the LUT exactly, zero unknowns. Where a colour repeats
// across several dBZ rows (the extremes), the LOWEST dBZ is kept, so
// intensity is never overstated. Unknown colours (shouldn't happen with
// smoothing off) decode to -32 (no echo) — fail toward fewer detections,
// not more.
//
// Thresholds are deliberately UK-tuned (lower than US textbook values):
// UK rotating storms are low-topped and modest on reflectivity — cores of
// 38-48 dBZ with shallow, subtle notches — so the classic US thresholds
// (50+ dBZ hook echoes) would miss nearly everything that matters here.
// The cost is more false positives; that's the accepted trade-off, and the
// tier system (see below) exists to express that uncertainty honestly.
//
// Tiers ("score" -> tier):
//   green  — weak signature: one subtle cue (shallow notch OR small hole).
//            "Worth a glance", most are nothing.
//   yellow — notable: clear notch on a solid core, or hole + gradient.
//   red    — strong: hook-like concavity AND weak-echo pocket AND tight
//            gradient on the same cell. Rare in the UK; still unproven
//            rotation, but the shape is textbook.
//
// This file is plain JS (with JSDoc types) on purpose: it is used verbatim
// by BOTH the website (imported from src/lib) and the desktop app
// (copied into desktop/renderer/vendor/ by desktop/build-main.js at build
// time) — one source of truth, no drift between the two radars.

// --- Tunable constants (UK-tuned; see note above) -------------------------
export const ROTATION_TUNING = {
  CELL_MIN_DBZ: 34, // pixels at/above this belong to a "storm cell"
  CELL_MIN_PIXELS: 24, // ignore specks smaller than this (~cell area floor)
  CORE_MIN_DBZ: 40, // a cell must contain at least one pixel this strong
  // Splitting one patch of rain into its separate storms (detectStormCells).
  // A patch at 34+ dBZ often holds several storm cores joined by moderate
  // rain — a line of showers, or two storms side by side in a frontal band.
  // Each separate area at CORE_SPLIT_DBZ+ of at least CORE_SPLIT_MIN_PIXELS
  // is a core; when a patch has two or more, its pixels are shared out to
  // the nearest core (grown outwards through the patch) and each part is
  // its own cell. The same idea as the multi-threshold step in radar
  // storm trackers (TITAN, SCIT).
  CORE_SPLIT_DBZ: 46,
  CORE_SPLIT_MIN_PIXELS: 12,
  HOLE_RING_MIN_DBZ: 38, // ring strength for a weak-echo hole to count
  HOLE_DEPTH_DBZ: 9, // ring minus hole pixel must be at least this
  HOLE_MAX_PIXELS: 40, // holes bigger than this are just gaps, not BWERs
  NOTCH_MIN_DEPTH_PX: 2.2, // concavity depth (pixels) below the convex hull
  NOTCH_MIN_DEPTH_RATIO: 0.3, // depth / mouth width — a bite, not a shallow bow
  NOTCH_MAX_MOUTH_FRAC: 0.7, // mouth width / hull diameter — reject crescents
  // Notches only mean anything on discrete storm cells. On big multicell
  // clusters / squall segments (thousands of px at z7 — a pixel there is
  // about 0.72 km at 54°N; 1.22 km is the figure at the equator) every
  // ragged boundary between merged cells reads as a "notch" — live testing
  // on an ordinary UK convective day produced 9 spurious red flags almost
  // entirely from cluster-scale cells before this cap existed.
  NOTCH_MAX_CELL_PIXELS: 1500,
  GRADIENT_MIN_DBZ_PER_PX: 7, // "tight gradient" threshold
  SCORE_GREEN: 2,
  SCORE_YELLOW: 4,
  SCORE_RED: 6,
};

/**
 * @typedef {Object} RotationSignature
 * @property {number} x        grid x of the signature centroid (pixels)
 * @property {number} y        grid y of the signature centroid (pixels)
 * @property {"green"|"yellow"|"red"} tier
 * @property {number} score
 * @property {number} maxDbz   strongest reflectivity in the cell
 * @property {boolean} hasNotch
 * @property {boolean} hasHole
 * @property {boolean} hasTightGradient
 * @property {number} cellPixels
 */

// Universal Blue palette -> dBZ lookup, generated from RainViewer's
// published colour table CSV (see header). Packed as (r<<16)|(g<<8)|b.
const UB_COLORS = new Int32Array([255,767,1791,2559,3327,4095,4863,5631,6399,7167,8191,8959,9727,10495,11263,12287,13055,13823,14591,15359,16383,18280,19056,20088,20864,21896,23438,25237,27036,28835,30634,32692,35007,37322,39637,41952,65280,148223,411135,608511,805887,1003519,1200895,1398271,1595647,1793023,1814242,2056191,2253567,2450943,2648319,2845695,3108863,3306239,3503615,3586789,3700991,3898367,4161535,4358911,4556287,4753663,4951039,5214207,5359080,5411583,5608959,5806335,6003711,6094848,6266879,6512985,6661631,6710106,6907484,7056383,7104605,7131627,7301983,7499361,7516927,7696482,7733248,7893860,7911679,8156517,8353895,8372223,8551273,8748394,8766975,8945772,8969710,9142893,9161727,9340271,9371648,9603185,9622271,10017023,10392437,10477567,10872319,11010048,11181689,11267071,11727615,11970942,12122367,12582911,12648447,12648448,12713983,12760194,12779519,12845055,12910591,12976127,13041663,13107199,13172735,13238271,13303807,13369343,13434879,13438208,13500415,13549703,13565951,13812875,14076047,14228224,14339219,14602391,15083520,15873536,16729088,16731903,16734463,16737023,16739583,16742399,16744704,16744959,16747264,16747519,16749824,16750079,16752384,16752639,16755200,16755455,16758528,16762112,16765440,16769024,16772608,16777215]);
const UB_DBZ = new Int16Array([75,74,73,72,71,70,69,68,67,66,65,64,63,62,61,60,59,58,57,56,55,34,33,32,31,30,29,28,27,26,25,24,23,22,21,20,75,54,53,52,51,50,49,48,47,46,19,45,44,43,42,41,40,39,38,18,37,36,35,34,33,32,31,30,17,29,28,27,26,54,25,-10,24,-9,-8,23,-7,16,-6,-5,22,-4,53,-3,21,-2,-1,20,0,1,19,2,15,3,18,4,52,5,17,16,6,15,14,51,7,13,12,8,11,9,8,50,7,9,6,4,3,2,1,-1,-2,-3,-4,-6,-7,49,-8,10,-9,11,12,48,13,14,47,46,45,64,63,62,61,60,44,59,43,58,42,57,41,56,40,55,39,38,37,36,35,65]);

const UB_LUT = new Map();
for (let i = 0; i < UB_COLORS.length; i++) UB_LUT.set(UB_COLORS[i], UB_DBZ[i]);

/**
 * Decode a stitched RGBA pixel buffer (RainViewer Universal Blue tiles,
 * smoothing OFF, drawn onto a canvas) into a flat dBZ grid. Transparent
 * pixels (no echo) and any colour not in the palette decode to -32.
 *
 * @param {Uint8ClampedArray} rgba  canvas ImageData.data
 * @param {number} width
 * @param {number} height
 * @returns {Int16Array} dBZ per pixel
 */
export function decodeDbzGrid(rgba, width, height) {
  const out = new Int16Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3];
    if (a === 0) {
      out[i] = -32;
      continue;
    }
    const packed = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
    const dbz = UB_LUT.get(packed);
    out[i] = dbz === undefined ? -32 : dbz;
  }
  return out;
}

// Connected-component labelling (4-neighbour flood fill, iterative) over
// pixels >= CELL_MIN_DBZ. Returns { labels, cells } where cells is a list
// of pixel-index arrays.
function segmentCells(dbz, width, height, tuning) {
  const labels = new Int32Array(width * height).fill(-1);
  const cells = [];
  const stack = [];
  for (let start = 0; start < dbz.length; start++) {
    if (labels[start] !== -1 || dbz[start] < tuning.CELL_MIN_DBZ) continue;
    const cell = [];
    const label = cells.length;
    stack.length = 0;
    stack.push(start);
    labels[start] = label;
    while (stack.length) {
      const idx = stack.pop();
      cell.push(idx);
      const x = idx % width;
      const y = (idx / width) | 0;
      if (x > 0 && labels[idx - 1] === -1 && dbz[idx - 1] >= tuning.CELL_MIN_DBZ) { labels[idx - 1] = label; stack.push(idx - 1); }
      if (x < width - 1 && labels[idx + 1] === -1 && dbz[idx + 1] >= tuning.CELL_MIN_DBZ) { labels[idx + 1] = label; stack.push(idx + 1); }
      if (y > 0 && labels[idx - width] === -1 && dbz[idx - width] >= tuning.CELL_MIN_DBZ) { labels[idx - width] = label; stack.push(idx - width); }
      if (y < height - 1 && labels[idx + width] === -1 && dbz[idx + width] >= tuning.CELL_MIN_DBZ) { labels[idx + width] = label; stack.push(idx + width); }
    }
    cells.push(cell);
  }
  return { labels, cells };
}

// Boundary pixels of a cell (any cell pixel with a non-cell 4-neighbour).
function boundaryOf(cell, labels, width, height, label) {
  const boundary = [];
  for (const idx of cell) {
    const x = idx % width;
    const y = (idx / width) | 0;
    if (
      x === 0 || x === width - 1 || y === 0 || y === height - 1 ||
      labels[idx - 1] !== label || labels[idx + 1] !== label ||
      labels[idx - width] !== label || labels[idx + width] !== label
    ) {
      boundary.push([x, y]);
    }
  }
  return boundary;
}

// Andrew's monotone-chain convex hull. Points: [x,y][]. Returns hull in
// counter-clockwise order.
function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// Hook/notch detection via convexity defects: for each convex-hull edge,
// sample points along the edge and march inward (perpendicular, toward the
// hull interior) until hitting a cell pixel. The march distance is the gap
// between the hull "bridge" and the actual storm edge at that spot — zero
// where the boundary touches the hull, and deep exactly inside a carved-in
// notch. Notch depth = the deepest such gap on any edge.
//
// (First attempt measured "max perpendicular distance from hull edge to any
// boundary pixel" — that silently measures the whole cell's span, because
// every far-side boundary pixel projects onto every edge. Caught by the
// synthetic hook-echo fixture: every edge reported ~23px of "sag" located
// on the opposite flank. Marching through the grid can't make that
// mistake, since it stops at the first cell pixel it meets.)
//
// Orientation: interior side of each edge is derived from the hull's
// signed area (image coordinates have y growing downward, which flips the
// winding of a standard monotone-chain hull — don't assume CCW).
function findDeepestNotch(labels, label, width, height, hull, tuning) {
  if (hull.length < 3) return { depth: 0, at: null };

  let area2 = 0;
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i];
    const [x2, y2] = hull[(i + 1) % hull.length];
    area2 += x1 * y2 - x2 * y1;
  }
  const interiorSign = area2 > 0 ? 1 : -1;
  const MAX_MARCH = 18; // px — deeper than any plausible notch at these zooms

  const inCell = (x, y) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return false;
    return labels[yi * width + xi] === label;
  };

  // Hull diameter (max vertex-to-vertex distance) — used to reject
  // crescent/banana-shaped cells, whose "defect" bridge spans nearly the
  // whole cell rather than being a localized bite.
  let hullDiam = 0;
  for (let i = 0; i < hull.length; i++) {
    for (let j = i + 1; j < hull.length; j++) {
      const d = Math.hypot(hull[i][0] - hull[j][0], hull[i][1] - hull[j][1]);
      if (d > hullDiam) hullDiam = d;
    }
  }

  let best = { depth: 0, at: null };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey); // the defect's "mouth" width
    if (len < 3) continue; // too short an edge to host a meaningful notch
    if (len / hullDiam > tuning.NOTCH_MAX_MOUTH_FRAC) continue; // crescent, not a bite
    // inward-pointing unit normal
    const nx = (-ey / len) * interiorSign;
    const ny = (ex / len) * interiorSign;

    let edgeMax = 0;
    let edgeAt = null;
    for (let s = 1; s < len; s += 1) {
      const t = s / len;
      const px = a[0] + ex * t;
      const py = a[1] + ey * t;
      let d = 0;
      while (d <= MAX_MARCH && !inCell(px + nx * d, py + ny * d)) d += 0.5;
      if (d > MAX_MARCH) continue; // marched off past the cell — ignore sample
      if (d > edgeMax) {
        edgeMax = d;
        // signature point: where the march lands on the cell edge (that's
        // where the hook curls — where a wall cloud would sit)
        edgeAt = [Math.round(px + nx * d), Math.round(py + ny * d)];
      }
    }
    // Depth must be meaningful both absolutely and relative to the mouth —
    // a deep-vs-mouth "bite" is a hook/notch, a wide shallow bow is just an
    // irregular cell edge.
    if (
      edgeMax >= tuning.NOTCH_MIN_DEPTH_PX &&
      edgeMax / len >= tuning.NOTCH_MIN_DEPTH_RATIO &&
      edgeMax > best.depth
    ) {
      best = { depth: edgeMax, at: edgeAt };
    }
  }
  return best;
}

// BWER-like holes: weak pixels fully inside the cell's bounding box whose
// 8-ring at radius 2 is consistently strong. Cheap approximation of
// "bounded weak echo region" that behaves well at tile resolution.
function findHoles(cell, dbz, width, height, labels, label, tuning) {
  const holes = [];
  const seen = new Set();
  for (const idx of cell) {
    const x = idx % width;
    const y = (idx / width) | 0;
    if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) continue;
    // candidate weak pixel adjacent to (inside) this cell
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nx = x + dx;
      const ny = y + dy;
      const nIdx = ny * width + nx;
      if (labels[nIdx] === label || seen.has(nIdx)) continue;
      seen.add(nIdx);
      const holeVal = dbz[nIdx];
      // ring at radius 2 around the weak pixel must be strong all around
      let ringMin = Infinity;
      let ok = true;
      for (let ry = -2; ry <= 2 && ok; ry++) {
        for (let rx = -2; rx <= 2; rx++) {
          if (Math.abs(rx) !== 2 && Math.abs(ry) !== 2) continue;
          const rIdx = (ny + ry) * width + (nx + rx);
          const v = dbz[rIdx];
          if (v < tuning.HOLE_RING_MIN_DBZ) { ok = false; break; }
          if (v < ringMin) ringMin = v;
        }
      }
      if (ok && ringMin - holeVal >= tuning.HOLE_DEPTH_DBZ) {
        holes.push({ x: nx, y: ny, depth: ringMin - holeVal });
      }
    }
  }
  // Merge adjacent hole pixels; reject blobs too big to be a BWER.
  return holes.length > 0 && holes.length <= tuning.HOLE_MAX_PIXELS ? holes : [];
}

// Max reflectivity gradient magnitude (dBZ per pixel) across the cell,
// central differences.
function maxGradient(cell, dbz, width, height) {
  let best = 0;
  for (const idx of cell) {
    const x = idx % width;
    const y = (idx / width) | 0;
    if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue;
    const gx = (dbz[idx + 1] - dbz[idx - 1]) / 2;
    const gy = (dbz[idx + width] - dbz[idx - width]) / 2;
    const g = Math.hypot(gx, gy);
    if (g > best) best = g;
  }
  return best;
}

/**
 * Run the full detection over a dBZ grid.
 *
 * @param {Int16Array} dbz
 * @param {number} width
 * @param {number} height
 * @param {Partial<typeof ROTATION_TUNING>} [overrides]
 * @returns {RotationSignature[]}
 */
/**
 * @typedef {Object} StormCell
 * @property {number} x        centroid, pixels
 * @property {number} y
 * @property {number} areaPx   number of pixels at/above CELL_MIN_DBZ
 * @property {number} maxDbz   peak reflectivity in the cell
 * @property {number} meanDbz  mean reflectivity across the cell
 * @property {{minX:number,minY:number,maxX:number,maxY:number}} bbox
 * @property {number} peakX    location of the peak dBZ pixel — the core,
 *   which is what a forecaster points at, and is often offset from the
 *   area centroid on a storm with a trailing anvil or precipitation shield.
 * @property {number} peakY
 * @property {number} weightedX  reflectivity-weighted centre: each pixel
 *   counts in proportion to how far it is above CELL_MIN_DBZ. This is the
 *   point to use for MOTION. It leans towards the core like the peak does,
 *   but it is an average over the whole cell, so it does not hop when the
 *   single strongest pixel changes — on integer dBZ data several pixels tie
 *   for "the peak" and which one wins is arbitrary. Measured on real
 *   frames (RainViewer z6, 3 Oct 2026, 80–520 cell pairs per fetch; rerun
 *   with `node scripts/validate-tracker.mjs --live`) against the
 *   block-matched displacement of the same echo: this centre stepped a
 *   median 0.75–1.0 px off it per frame, the peak pixel 2.1–2.9 px (RMS
 *   1.7–2.1 px against 6–9 px).
 * @property {number} weightedY
 * @property {boolean} touchesEdge  true when the cell reaches the border of
 *   the grid it was found on, i.e. part of it may lie outside the scanned
 *   area. Every centre above is then the centre of the VISIBLE part only,
 *   and as the storm moves in or out that point lags the storm itself — a
 *   round cell crossing the border appears to travel at about half its
 *   real speed. Motion code must not take such positions at face value
 *   (see EDGE_CLIP_SIGMA_RADIUS_FRAC in stormTracker.js).
 */

/**
 * Every storm cell in a frame, whether or not it shows rotation cues.
 *
 * detectRotationSignatures below returns only cells whose SHAPE suggests
 * rotation. That is the right filter for a "possible rotation" warning
 * layer, but it is the wrong one for letting a forecaster pick a storm to
 * follow: most cells worth tracking — a heavy shower, a squall segment, a
 * developing tower — never show a notch or a BWER at all.
 *
 * So this exposes the segmentation that was already happening internally.
 * Same CELL_MIN_DBZ threshold and same connected-component pass; it simply
 * does not discard the cells that lack rotation cues.
 *
 * HONESTY NOTE, carried from this module's header: a "cell" here is a
 * contiguous blob of reflectivity at or above 34 dBZ. It is not a
 * thunderstorm identification, and area/intensity say nothing about whether
 * a storm is severe. It is what the radar shows, segmented.
 *
 * @param {Int16Array} dbz
 * @param {number} width
 * @param {number} height
 * @param {Partial<typeof ROTATION_TUNING>} [overrides]
 * @returns {StormCell[]} sorted strongest-first by peak reflectivity
 */
export function detectStormCells(dbz, width, height, overrides) {
  const tuning = { ...ROTATION_TUNING, ...overrides };
  const { cells: patches } = segmentCells(dbz, width, height, tuning);
  /** @type {StormCell[]} */
  const out = [];
  const part = new Int32Array(width * height).fill(-1);

  for (let patchIndex = 0; patchIndex < patches.length; patchIndex++) {
    const patch = patches[patchIndex];
    if (patch.length < tuning.CELL_MIN_PIXELS) continue;
    const pieces = splitAtCores(patch, dbz, width, height, tuning, part);
    for (const cell of pieces) {
      let sumX = 0;
      let sumY = 0;
      let sumDbz = 0;
      let sumW = 0;
      let sumWX = 0;
      let sumWY = 0;
      let maxDbz = -32;
      let peakX = 0;
      let peakY = 0;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const idx of cell) {
        const x = idx % width;
        const y = (idx / width) | 0;
        const v = dbz[idx];
        sumX += x;
        sumY += y;
        sumDbz += v;
        // Weight for the motion centre: dB above the cell threshold, plus one
        // so a pixel exactly on the threshold still counts.
        const w = v - tuning.CELL_MIN_DBZ + 1;
        sumW += w;
        sumWX += w * x;
        sumWY += w * y;
        if (v > maxDbz) {
          maxDbz = v;
          peakX = x;
          peakY = y;
        }
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }

      out.push({
        x: sumX / cell.length,
        y: sumY / cell.length,
        areaPx: cell.length,
        maxDbz,
        meanDbz: sumDbz / cell.length,
        bbox: { minX, minY, maxX, maxY },
        peakX,
        peakY,
        weightedX: sumWX / sumW,
        weightedY: sumWY / sumW,
        touchesEdge: minX <= 0 || minY <= 0 || maxX >= width - 1 || maxY >= height - 1,
        // Cells split from the same patch of rain share this: they are parts
        // of one storm system, and get one name with letters (stormCellScan).
        patch: patchIndex,
        partOfPatch: pieces.length > 1,
      });
    }
  }

  out.sort((a, b) => b.maxDbz - a.maxDbz);
  return out;
}

/**
 * One patch of rain as its separate storms: the patch itself when it has
 * fewer than two cores, otherwise one piece per core (see CORE_SPLIT_DBZ).
 * Pieces are grown out from the cores at the same pace, through the patch's
 * own pixels, so each pixel goes to the core it is nearest along the rain.
 * `part` is scratch space the size of the grid, all -1 on entry and exit.
 */
function splitAtCores(patch, dbz, width, height, tuning, part) {
  const cores = [];
  const inPatch = new Set(patch);
  const stack = [];
  for (const start of patch) {
    if (dbz[start] < tuning.CORE_SPLIT_DBZ || part[start] !== -1) continue;
    const core = [];
    const id = cores.length;
    part[start] = id; stack.length = 0; stack.push(start);
    while (stack.length) {
      const idx = stack.pop();
      core.push(idx);
      const x = idx % width;
      for (const n of [x > 0 ? idx - 1 : -1, x < width - 1 ? idx + 1 : -1, idx - width, idx + width]) {
        if (n < 0 || n >= dbz.length || part[n] !== -1 || dbz[n] < tuning.CORE_SPLIT_DBZ || !inPatch.has(n)) continue;
        part[n] = id; stack.push(n);
      }
    }
    cores.push(core);
  }
  const big = cores.filter((c) => c.length >= tuning.CORE_SPLIT_MIN_PIXELS);
  if (big.length < 2) {
    for (const c of cores) for (const idx of c) part[idx] = -1;
    return [patch];
  }
  // Specks below the size floor go back into the pool to be grown into.
  for (const c of cores) if (c.length < tuning.CORE_SPLIT_MIN_PIXELS) for (const idx of c) part[idx] = -1;
  const pieces = big.map(() => []);
  let front = [];
  big.forEach((c, i) => { for (const idx of c) { part[idx] = i; pieces[i].push(idx); front.push(idx); } });
  while (front.length) {
    const next = [];
    for (const idx of front) {
      const x = idx % width;
      for (const n of [x > 0 ? idx - 1 : -1, x < width - 1 ? idx + 1 : -1, idx - width, idx + width]) {
        if (n < 0 || n >= dbz.length || part[n] !== -1 || !inPatch.has(n)) continue;
        part[n] = part[idx]; pieces[part[idx]].push(n); next.push(n);
      }
    }
    front = next;
  }
  for (const idx of patch) part[idx] = -1;
  // A piece too small to be a cell on its own is folded into the biggest.
  const kept = pieces.filter((p) => p.length >= tuning.CELL_MIN_PIXELS);
  if (kept.length < 2) return [patch];
  const spare = pieces.filter((p) => p.length < tuning.CELL_MIN_PIXELS).flat();
  kept.sort((a, b) => b.length - a.length);
  kept[0].push(...spare);
  return kept;
}

export function detectRotationSignatures(dbz, width, height, overrides) {
  const tuning = { ...ROTATION_TUNING, ...overrides };
  const { labels, cells } = segmentCells(dbz, width, height, tuning);
  /** @type {RotationSignature[]} */
  const out = [];

  for (let label = 0; label < cells.length; label++) {
    const cell = cells[label];
    if (cell.length < tuning.CELL_MIN_PIXELS) continue;

    let maxDbz = -32;
    for (const idx of cell) if (dbz[idx] > maxDbz) maxDbz = dbz[idx];
    if (maxDbz < tuning.CORE_MIN_DBZ) continue; // no real core, skip

    const boundary = boundaryOf(cell, labels, width, height, label);
    const hull = convexHull(boundary);
    // Notch cue is only computed for discrete-storm-sized cells — see
    // NOTCH_MAX_CELL_PIXELS comment. Holes and gradient still apply to
    // clusters (a BWER inside a cluster is still a BWER).
    const notch = cell.length <= tuning.NOTCH_MAX_CELL_PIXELS
      ? findDeepestNotch(labels, label, width, height, hull, tuning)
      : { depth: 0, at: null };
    const holes = findHoles(cell, dbz, width, height, labels, label, tuning);
    const gradient = maxGradient(cell, dbz, width, height);

    const hasNotch = notch.depth > 0;
    const hasHole = holes.length > 0;
    const hasTightGradient = gradient >= tuning.GRADIENT_MIN_DBZ_PER_PX;

    // Scoring, structured so RED (6) is unreachable without BOTH primary
    // cues: notch contributes at most 3 (2 base + up to 1 for depth), hole
    // 2, and the two supporting cues (tight gradient, ≥50 dBZ core) 0.5
    // each — max without a hole is 4, max without a notch is 3. So red
    // truly means notch + hole + both supports = the "textbook shape" bar
    // in the header, yellow means one primary cue plus strong support, and
    // green is a single cue worth a glance. (The first cut let notch +
    // gradient + strong core reach red on their own — live testing on an
    // ordinary UK convective day produced nine red flags in one view, which
    // is exactly what red must never be.)
    let score = 0;
    if (hasNotch) score += 2 + Math.min(1, notch.depth - tuning.NOTCH_MIN_DEPTH_PX);
    if (hasHole) score += 2;
    if (hasTightGradient) score += 0.5;
    if (maxDbz >= 50) score += 0.5;

    if (score < tuning.SCORE_GREEN) continue;

    // Signature location: prefer the notch point (that's where a wall
    // cloud/mesocyclone would sit), else the deepest hole, else the core.
    let sx;
    let sy;
    if (notch.at) {
      [sx, sy] = notch.at;
    } else if (holes.length) {
      const deepest = holes.reduce((a, b) => (b.depth > a.depth ? b : a));
      sx = deepest.x;
      sy = deepest.y;
    } else {
      let coreIdx = cell[0];
      for (const idx of cell) if (dbz[idx] > dbz[coreIdx]) coreIdx = idx;
      sx = coreIdx % width;
      sy = (coreIdx / width) | 0;
    }

    out.push({
      x: sx,
      y: sy,
      tier: score >= tuning.SCORE_RED ? "red" : score >= tuning.SCORE_YELLOW ? "yellow" : "green",
      score: Math.round(score * 10) / 10,
      maxDbz,
      hasNotch,
      hasHole,
      hasTightGradient,
      cellPixels: cell.length,
    });
  }

  return out;
}

// --- Geo helpers (Web Mercator, for mapping grid pixels back to lat/lon) --

/** @param {number} lat @param {number} lon @param {number} zoom */
export function lonLatToPixel(lon, lat, zoom) {
  const scale = 256 * Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
  return [x, y];
}

/** @param {number} px @param {number} py @param {number} zoom */
export function pixelToLonLat(px, py, zoom) {
  const scale = 256 * Math.pow(2, zoom);
  const lon = (px / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * py) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lon, lat];
}

// --- Browser-side viewport scan (needs fetch + canvas; not for Node) ------
//
// Fetches the RainViewer tiles covering the given map bounds for one radar
// frame, stitches them onto an offscreen canvas, decodes to dBZ, runs the
// detector, and returns signatures with lon/lat attached. Both the website
// radar page and the desktop app's Radar tab call this on the LATEST frame
// only (markers mean "now" — rescanning during animation scrubbing would
// hammer the tile server for no informational gain).
//
// Scan zoom is capped at 7: RainViewer's radar data itself only exists up
// to z7 (about 0.72 km/px at 54°N — 1.22 km/px only at the equator), so
// scanning "deeper" would just be resampling the same data. It's also
// floored at 5 so a zoomed-out view still scans at a resolution where a
// 3-4px notch means something.

const SCAN_MAX_TILES = 30; // hard cap on tile fetches per scan

/**
 * @param {string} host      RainViewer API host (weather-maps.json "host")
 * @param {string} framePath RainViewer frame path (e.g. "/v2/radar/<id>")
 * @param {{west:number,south:number,east:number,north:number}} bounds
 * @param {number} viewZoom  current map zoom (used to pick scan zoom)
 * @returns {Promise<Array<RotationSignature & {lon:number, lat:number}>>}
 */
export async function scanViewportForRotation(host, framePath, bounds, viewZoom) {
  const z = Math.max(5, Math.min(7, Math.round(viewZoom)));
  const n = Math.pow(2, z);

  const [pxWest, pyNorth] = lonLatToPixel(bounds.west, bounds.north, z);
  const [pxEast, pySouth] = lonLatToPixel(bounds.east, bounds.south, z);
  let tx0 = Math.max(0, Math.floor(pxWest / 256));
  let ty0 = Math.max(0, Math.floor(pyNorth / 256));
  let tx1 = Math.min(n - 1, Math.floor(pxEast / 256));
  let ty1 = Math.min(n - 1, Math.floor(pySouth / 256));

  // Cap the tile count (a whole-world view at z7 would be thousands) by
  // shrinking the range around its centre rather than refusing to scan.
  while ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > SCAN_MAX_TILES) {
    if (tx1 - tx0 > ty1 - ty0) {
      tx0++;
      tx1--;
    } else {
      ty0++;
      ty1--;
    }
    if (tx1 < tx0 || ty1 < ty0) return [];
  }

  const cols = tx1 - tx0 + 1;
  const rows = ty1 - ty0 + 1;
  const width = cols * 256;
  const height = rows * 256;

  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement("canvas"), { width, height });
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return [];

  const fetches = [];
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      // smoothing OFF (0_0) — smoothed tiles interpolate colours off the
      // palette and would decode as gaps. See header.
      const url = `${host}${framePath}/256/${z}/${tx}/${ty}/2/0_0.png`;
      fetches.push(
        fetch(url)
          .then((r) => (r.ok ? r.blob() : null))
          .then((blob) => (blob ? createImageBitmap(blob) : null))
          .then((bmp) => {
            if (bmp) ctx.drawImage(bmp, (tx - tx0) * 256, (ty - ty0) * 256);
          })
          .catch(() => {})
      );
    }
  }
  await Promise.all(fetches);

  const rgba = ctx.getImageData(0, 0, width, height).data;
  const dbz = decodeDbzGrid(rgba, width, height);
  const sigs = detectRotationSignatures(dbz, width, height);

  return sigs.map((s) => {
    const [lon, lat] = pixelToLonLat(tx0 * 256 + s.x, ty0 * 256 + s.y, z);
    return { ...s, lon, lat };
  });
}

/**
 * Works out which tiles cover a viewport, capped to SCAN_MAX_TILES.
 *
 * Pulled out of scanViewportForRotation so a multi-frame scan can compute
 * the grid ONCE and reuse it for every frame. That matters for more than
 * speed: every frame in a track must be decoded on an identical pixel grid,
 * or a cell's apparent position would shift between frames purely because
 * the tile window moved, and the tracker would read that as storm motion.
 *
 * @returns {{z:number, tx0:number, ty0:number, width:number, height:number}|null}
 */
export function viewportTileGrid(bounds, viewZoom) {
  const z = Math.max(5, Math.min(7, Math.round(viewZoom)));
  const n = Math.pow(2, z);
  const [pxWest, pyNorth] = lonLatToPixel(bounds.west, bounds.north, z);
  const [pxEast, pySouth] = lonLatToPixel(bounds.east, bounds.south, z);
  let tx0 = Math.max(0, Math.floor(pxWest / 256));
  let ty0 = Math.max(0, Math.floor(pyNorth / 256));
  let tx1 = Math.min(n - 1, Math.floor(pxEast / 256));
  let ty1 = Math.min(n - 1, Math.floor(pySouth / 256));

  while ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > SCAN_MAX_TILES) {
    if (tx1 - tx0 > ty1 - ty0) {
      tx0++;
      tx1--;
    } else {
      ty0++;
      ty1--;
    }
    if (tx1 < tx0 || ty1 < ty0) return null;
  }
  return { z, tx0, ty0, width: (tx1 - tx0 + 1) * 256, height: (ty1 - ty0 + 1) * 256 };
}

/**
 * Fetches and decodes one radar frame's reflectivity over a tile grid from
 * viewportTileGrid.
 *
 * @returns {Promise<Int16Array|null>} dBZ grid, or null if nothing loaded
 */
export async function fetchDbzGrid(host, framePath, grid) {
  const { z, tx0, ty0, width, height } = grid;
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement("canvas"), { width, height });
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const cols = width / 256;
  const rows = height / 256;
  const fetches = [];
  let loaded = 0;
  for (let cx = 0; cx < cols; cx++) {
    for (let cy = 0; cy < rows; cy++) {
      // smoothing OFF (0_0) — smoothed tiles interpolate colours off the
      // palette and would decode as gaps. See header.
      const url = `${host}${framePath}/256/${z}/${tx0 + cx}/${ty0 + cy}/2/0_0.png`;
      fetches.push(
        fetch(url)
          .then((r) => (r.ok ? r.blob() : null))
          .then((blob) => (blob ? createImageBitmap(blob) : null))
          .then((bmp) => {
            if (bmp) {
              ctx.drawImage(bmp, cx * 256, cy * 256);
              loaded++;
            }
          })
          .catch(() => {})
      );
    }
  }
  await Promise.all(fetches);
  if (loaded === 0) return null;
  return decodeDbzGrid(ctx.getImageData(0, 0, width, height).data, width, height);
}

/** Converts a grid pixel back to lon/lat. */
export function gridPixelToLonLat(grid, x, y) {
  const [lon, lat] = pixelToLonLat(grid.tx0 * 256 + x, grid.ty0 * 256 + y, grid.z);
  return { lon, lat };
}

/**
 * Ground distance represented by one grid pixel, in kilometres, at the
 * given latitude. Web-mercator pixels shrink with latitude, so this is
 * computed for where the storms actually are rather than assumed — the
 * tracker's speeds are only as honest as this number.
 */
export function kmPerPixelAt(grid, lat) {
  const EARTH_CIRCUMFERENCE_KM = 40075.017;
  return (EARTH_CIRCUMFERENCE_KM * Math.cos((lat * Math.PI) / 180)) / (256 * Math.pow(2, grid.z));
}

// --- Multi-scan rotation check -------------------------------------------
//
// One radar picture on its own is a poor rotation detector: ragged shower
// edges produce "notches" all the time, and they vanish in the next scan.
// Real rotating storms behave differently OVER TIME:
//   PERSISTENCE  the hook/notch/weak-echo cue is still there 10–20 minutes
//                later (a mesocyclone lasts tens of minutes);
//   DEVIANT MOTION  a rotating storm (a "right-mover") travels to the RIGHT
//                of the other storms' motion, often more slowly — the same
//                split behaviour watched on 29 Sep near Lydd.
// So the latest scan's signatures are re-scored against the previous scans:
//   seen in an earlier scan too  +1   (only in the latest of 3 scans  −1.5)
//   its cell moves ≥ 20° right of the storms around it               +1
// Tiers are then re-assigned with the same thresholds as before.
// Still inference from reflectivity SHAPE and MOTION — not Doppler velocity.
//
// HOW THE MOTION CUE IS MEASURED (cellMotionAgainstNeighbours below)
//
//   1. Between each pair of scans, the displacement most cells share is
//      found by voting (estimateBulkShift), and each cell is then linked to
//      the earlier cell that sits where that shared motion says it came
//      from. Linking each cell to its merely NEAREST earlier cell, as this
//      used to, breaks down exactly where it matters — among closely spaced
//      storms.
//   2. A cell's motion is its displacement over ALL the scans it can be
//      followed through (up to three), measured between reflectivity-
//      weighted centres, not peak pixels (see StormCell.weightedX for the
//      measured difference: the peak pixel hops further per scan than most
//      storms move, so a heading taken from it was mostly noise).
//   3. The reference is the MEDIAN motion of the OTHER cells within
//      REFERENCE_RADIUS_KM — never including the cell being judged, and a
//      median so that one or two odd movers cannot drag it.
//   4. The answer is given only when it can be trusted: at least
//      REFERENCE_MIN_CELLS other cells, and a combined uncertainty (the
//      cell's own heading plus the reference's) of no more than
//      DEVIATION_MAX_SIGMA_DEG. Otherwise deviationDeg is null and the UI
//      says "not measurable". A slow storm seen in two scans usually IS not
//      measurable: its displacement is too small against the position noise
//      for its heading to mean anything, and saying so is the honest answer.
//   5. A cell cut by the edge of the scanned grid is not trusted: only the
//      part in view can be measured, and that part's centre lags the storm
//      as it moves in or out. Such a cell is left out of the reference, and
//      its own deviation carries the extra uncertainty (so is normally "not
//      measurable").
//
// What this does not claim: a deviation is the difference between two
// ESTIMATED headings. At the 12° limit, a storm moving exactly with its
// neighbours will still read 20° or more to the right about one time in
// twenty by chance.

/** Constants for the motion cue. The position-noise terms mirror TRACK_TUNING in stormTracker.js. */
export const MOTION_TUNING = {
  /** Minutes between scans, assumed only when the caller passes no scan times. */
  SCAN_INTERVAL_MIN: 10,
  /** No storm is linked across scans at more than this speed. */
  MAX_SPEED_KMH: 180,
  SLACK_KM: 6,
  /** Frame-to-frame wander of a cell's weighted centre, per axis (measured — see StormCell.weightedX). */
  POSITION_SIGMA_KM: 1.0,
  POSITION_SIGMA_MIN_PX: 0.4,
  POSITION_SIGMA_RADIUS_FRAC: 0.07,
  /**
   * Extra position uncertainty, as a share of the visible part's radius, for
   * a cell cut by the edge of the scanned grid (StormCell.touchesEdge) — the
   * same figure and reasoning as TRACK_TUNING.EDGE_CLIP_SIGMA_RADIUS_FRAC.
   * In practice it makes the motion comparison "not measurable" for all but
   * the smallest cut cells, which is the honest answer.
   */
  EDGE_CLIP_SIGMA_RADIUS_FRAC: 1.0,
  /** How far (per axis) one cell's velocity may differ from the shared motion and still be linked. */
  FLOW_SPREAD_KMH: 20,
  /** Cells in one airstream still differ by a few km/h; this much counts as "the same motion" when voting. */
  FLOW_DIFFER_KMH: 6,
  /** "The other storms" are those within this distance of the cell being judged. */
  REFERENCE_RADIUS_KM: 200,
  REFERENCE_MIN_CELLS: 3,
  /** A deviation less certain than this (one standard deviation, degrees) is reported as not measurable. */
  DEVIATION_MAX_SIGMA_DEG: 12,
};

/**
 * The displacement that most cells share between two scans — the "bulk"
 * motion of the scene — found WITHOUT first deciding which cell is which.
 *
 * Every (earlier cell, later cell) pair within reach casts a vote for the
 * displacement that would carry one onto the other. Pairs that really are
 * the same storm all vote for nearly the same displacement; wrong pairs
 * scatter. The densest spot in the votes is the shared motion.
 *
 * Votes between cells of similar size and peak intensity count for more, so
 * that in an evenly spaced line of showers the true shift beats the "every
 * cell became its neighbour" alias. A perfectly regular line of identical
 * cells remains ambiguous — nothing in two pictures of it can say which
 * shift happened — and whichever answer has the most support is returned.
 *
 * @param {Array<{x:number, y:number, maxDbz?:number, areaPx?:number}>} before
 * @param {Array<{x:number, y:number, maxDbz?:number, areaPx?:number}>} after
 * @param {number} maxShiftPx  largest displacement considered
 * @param {number} tolPx       how closely two displacements must agree to count as the same motion
 * @returns {{dx:number, dy:number, support:number, spread:number, spreadCells:number}|null}
 *   `support` is how many different cells agree; `spread` is the per-axis
 *   scatter (px) of the cells' displacements about the answer, taken over
 *   `spreadCells` cells. null when
 *   fewer than three cells (or under a third of them) agree — there is then
 *   no shared motion to speak of
 */
export function estimateBulkShift(before, after, maxShiftPx, tolPx) {
  if (before.length < 3 || after.length < 3 || !(tolPx > 0)) return null;
  const vdx = [];
  const vdy = [];
  const vw = [];
  const vb = [];
  const va = [];
  const bins = new Map();
  const OFFSET = 1 << 14;
  const keyOf = (ix, iy) => (ix + OFFSET) * (OFFSET * 2) + (iy + OFFSET);
  for (let bi = 0; bi < before.length; bi++) {
    const b = before[bi];
    for (let ai = 0; ai < after.length; ai++) {
      const a = after[ai];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      if (dx * dx + dy * dy > maxShiftPx * maxShiftPx) continue;
      let like = 0;
      if (b.areaPx > 0 && a.areaPx > 0) like += (Math.log(a.areaPx / b.areaPx) / 0.7) ** 2;
      if (typeof b.maxDbz === "number" && typeof a.maxDbz === "number") like += ((a.maxDbz - b.maxDbz) / 6) ** 2;
      const w = Math.exp(-0.5 * like);
      vdx.push(dx);
      vdy.push(dy);
      vw.push(w);
      vb.push(bi);
      va.push(ai);
      const k = keyOf(Math.round(dx / tolPx), Math.round(dy / tolPx));
      bins.set(k, (bins.get(k) || 0) + w);
    }
  }
  if (!vw.length) return null;

  // Densest bin, counting half of each of its eight neighbours so a peak
  // that straddles a bin edge is not split in two.
  let bestScore = -1;
  let cx = 0;
  let cy = 0;
  for (const [k, w] of bins) {
    const ix = Math.floor(k / (OFFSET * 2)) - OFFSET;
    const iy = (k % (OFFSET * 2)) - OFFSET;
    let score = w;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        if (ox || oy) score += 0.5 * (bins.get(keyOf(ix + ox, iy + oy)) || 0);
      }
    }
    if (score > bestScore) {
      bestScore = score;
      cx = ix * tolPx;
      cy = iy * tolPx;
    }
  }
  // Refine to the weighted mean of the votes around it (a few rounds).
  const r2 = (1.5 * tolPx) ** 2;
  for (let round = 0; round < 4; round++) {
    let sw = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < vw.length; i++) {
      if ((vdx[i] - cx) ** 2 + (vdy[i] - cy) ** 2 > r2) continue;
      sw += vw[i];
      sx += vw[i] * vdx[i];
      sy += vw[i] * vdy[i];
    }
    if (!(sw > 0)) return null;
    cx = sx / sw;
    cy = sy / sw;
  }
  // Support = how many DIFFERENT cells agree (one cell voting several times
  // through several neighbours is still one cell).
  const fromCells = new Set();
  const toCells = new Set();
  for (let i = 0; i < vw.length; i++) {
    if ((vdx[i] - cx) ** 2 + (vdy[i] - cy) ** 2 > r2) continue;
    fromCells.add(vb[i]);
    toCells.add(va[i]);
  }
  const support = Math.min(fromCells.size, toCells.size);
  if (support < 3 || support < 0.34 * Math.min(before.length, after.length)) return null;
  // Spread: how much the cells' own steps differ from one another. This is
  // position noise (twice over — both ends of the step wander) plus real
  // differences between the cells' motions, and it is how the tracker learns
  // how jumpy positions are in THIS scene rather than assuming it. Each
  // earlier cell contributes its vote nearest the answer; the scatter is
  // then measured about the MEDIAN of those votes, not about the answer
  // itself — the answer is the densest knot of votes, and measuring scatter
  // from the middle of a knot makes it look smaller than it is.
  const bestD2 = new Float64Array(before.length).fill(Infinity);
  const bestVote = new Int32Array(before.length).fill(-1);
  const wide2 = (3 * tolPx) ** 2;
  for (let i = 0; i < vw.length; i++) {
    const d2 = (vdx[i] - cx) ** 2 + (vdy[i] - cy) ** 2;
    if (d2 <= wide2 && d2 < bestD2[vb[i]]) {
      bestD2[vb[i]] = d2;
      bestVote[vb[i]] = i;
    }
  }
  const stepX = [];
  const stepY = [];
  for (const i of bestVote) {
    if (i < 0) continue;
    stepX.push(vdx[i]);
    stepY.push(vdy[i]);
  }
  let spread = 0;
  if (stepX.length >= 2) {
    const mx = medianOf(stepX);
    const my = medianOf(stepY);
    const misses = stepX.map((x, i) => Math.hypot(x - mx, stepY[i] - my));
    // Median radial miss → per-axis sigma (a round 2-D spread has median
    // 1.1774 sigma), with the usual n/(n−1) allowance for having taken the
    // centre from the same handful of cells.
    spread = (medianOf(misses) / 1.1774) * Math.sqrt(stepX.length / (stepX.length - 1));
  }
  return { dx: cx, dy: cy, support, spread, spreadCells: stepX.length };
}

/** Component-wise median. */
function medianOf(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * For every cell in the newest scan: how it has moved across the scans, and
 * how that compares with the cells around it. See "HOW THE MOTION CUE IS
 * MEASURED" above.
 *
 * @param {StormCell[][]} scans     cells per scan (from detectStormCells), OLDEST first
 * @param {number[]} minutes        time of each scan in minutes — only the differences are used
 * @param {(cell: StormCell) => number} kmPerPixelOf  ground km per pixel at a cell
 * @returns {Array<{vx:number, vy:number, spanMinutes:number, headingDeg:number,
 *   deviationDeg:number|null, deviationSigmaDeg:number|null, others:number}|null>}
 *   one entry per cell of the newest scan, null where the cell could not be
 *   followed back. vx/vy are pixels per minute (y grows southwards).
 *   deviationDeg is positive to the RIGHT of the neighbours' motion, and
 *   null whenever it is not measurable.
 */
export function cellMotionAgainstNeighbours(scans, minutes, kmPerPixelOf) {
  const T = MOTION_TUNING;
  const last = scans.length - 1;
  if (last < 0) return [];
  const now = scans[last];
  const px = (c) => c.weightedX ?? c.peakX;
  const py = (c) => c.weightedY ?? c.peakY;
  const point = (c) => ({ x: px(c), y: py(c), maxDbz: c.maxDbz, areaPx: c.areaPx });

  // links[k][i] = index, in scan k-1, of the cell that became cell i of scan k.
  const links = scans.map(() => null);
  for (let k = 1; k <= last; k++) {
    const dt = minutes[k] - minutes[k - 1];
    const cur = scans[k];
    const prev = scans[k - 1];
    if (!(dt > 0) || !cur.length || !prev.length) continue;
    let kmpp = 0;
    for (const c of cur) kmpp += kmPerPixelOf(c);
    kmpp /= cur.length;
    const maxShift = ((T.MAX_SPEED_KMH / 60) * dt + T.SLACK_KM) / kmpp;
    const tol = Math.max(1.5, (2 * T.POSITION_SIGMA_KM + (T.FLOW_DIFFER_KMH / 60) * dt) / kmpp);
    const shift = estimateBulkShift(prev.map(point), cur.map(point), maxShift, tol);
    if (!shift) continue; // no shared motion → nothing to compare a cell against
    const reach = Math.min(maxShift, (3.5 * Math.hypot(Math.SQRT2 * T.POSITION_SIGMA_KM, (T.FLOW_SPREAD_KMH / 60) * dt)) / kmpp);
    const candidates = [];
    for (let i = 0; i < cur.length; i++) {
      for (let j = 0; j < prev.length; j++) {
        const d = Math.hypot(px(cur[i]) - shift.dx - px(prev[j]), py(cur[i]) - shift.dy - py(prev[j]));
        if (d <= reach) candidates.push({ i, j, d });
      }
    }
    // With the shared motion already taken out, the nearest candidate is
    // almost always the right one; each cell is used once.
    candidates.sort((a, b) => a.d - b.d);
    const link = new Int32Array(cur.length).fill(-1);
    const taken = new Uint8Array(prev.length);
    for (const c of candidates) {
      if (link[c.i] !== -1 || taken[c.j]) continue;
      link[c.i] = c.j;
      taken[c.j] = 1;
    }
    links[k] = link;
  }

  // Each newest cell's displacement over the longest chain of links.
  const motions = now.map((cell, i) => {
    let k = last;
    let idx = i;
    while (k > 0 && links[k] && links[k][idx] >= 0) {
      idx = links[k][idx];
      k--;
    }
    if (k === last) return null;
    const origin = scans[k][idx];
    const span = minutes[last] - minutes[k];
    const kmpp = kmPerPixelOf(cell);
    const posSigma = (c) => {
      const radius = Math.sqrt(c.areaPx / Math.PI);
      const seen = Math.max(T.POSITION_SIGMA_MIN_PX, T.POSITION_SIGMA_KM / kmpp, T.POSITION_SIGMA_RADIUS_FRAC * radius);
      // A cell cut by the edge of the grid: its centre is the centre of the
      // part in view, which can be most of a radius from the storm's own.
      return c.touchesEdge ? Math.hypot(seen, T.EDGE_CLIP_SIGMA_RADIUS_FRAC * radius) : seen;
    };
    const vx = (px(cell) - px(origin)) / span;
    const vy = (py(cell) - py(origin)) / span;
    return {
      vx,
      vy,
      spanMinutes: span,
      kmpp,
      // One-sigma uncertainty of each velocity component, px/min.
      vSigma: Math.hypot(posSigma(cell), posSigma(origin)) / span,
      headingDeg: ((Math.atan2(vx, -vy) * 180) / Math.PI + 360) % 360,
      cut: cell.touchesEdge === true || origin.touchesEdge === true,
    };
  });

  return motions.map((m, i) => {
    if (!m) return null;
    const out = { vx: m.vx, vy: m.vy, spanMinutes: m.spanMinutes, headingDeg: m.headingDeg, deviationDeg: null, deviationSigmaDeg: null, others: 0 };
    const reachPx = T.REFERENCE_RADIUS_KM / m.kmpp;
    const ox = [];
    const oy = [];
    for (let j = 0; j < now.length; j++) {
      // A neighbour cut by the edge of the grid is no reference: its
      // apparent motion is that of the part in view, not of the storm.
      if (j === i || !motions[j] || motions[j].cut) continue;
      if (Math.hypot(px(now[j]) - px(now[i]), py(now[j]) - py(now[i])) > reachPx) continue;
      ox.push(motions[j].vx);
      oy.push(motions[j].vy);
    }
    out.others = ox.length;
    if (ox.length < T.REFERENCE_MIN_CELLS) return out;
    const rx = medianOf(ox);
    const ry = medianOf(oy);
    // Spread of the others about their median → how well the median itself
    // is known (1.25 × sigma / √n is the standard error of a median).
    const resid = ox.map((v, j) => Math.hypot(v - rx, oy[j] - ry));
    const refSigma = (1.2533 * (medianOf(resid) / 1.1774)) / Math.sqrt(ox.length);
    const toDeg = 180 / Math.PI;
    const cellSigmaDeg = Math.atan2(m.vSigma, Math.hypot(m.vx, m.vy)) * toDeg;
    const refSigmaDeg = Math.atan2(refSigma, Math.hypot(rx, ry)) * toDeg;
    const sigmaDeg = Math.hypot(cellSigmaDeg, refSigmaDeg);
    out.deviationSigmaDeg = sigmaDeg;
    if (sigmaDeg > T.DEVIATION_MAX_SIGMA_DEG) return out;
    const refHeading = ((Math.atan2(rx, -ry) * 180) / Math.PI + 360) % 360;
    out.deviationDeg = ((m.headingDeg - refHeading + 540) % 360) - 180; // + = right of the others
    return out;
  });
}

/**
 * @param {string[]} frameBases  scan bases (host+path), OLDEST first, newest last (2–3 of them)
 * @param {{west:number,south:number,east:number,north:number}} bounds
 * @param {number} viewZoom
 * @param {number[]} [frameTimes]  time of each scan (epoch seconds or
 *   milliseconds), same order as frameBases. Optional: without it the scans
 *   are taken to be SCAN_INTERVAL_MIN apart, which only matters for how far
 *   a storm is allowed to have moved between them.
 * @returns {Promise<Array<RotationSignature & {lon:number,lat:number,seenIn:number,scans:number,
 *   deviationDeg:number|null, deviationSigmaDeg:number|null, motionCells:number}>>}
 *   deviationDeg is null whenever the motion comparison is not measurable;
 *   deviationSigmaDeg is its one-sigma uncertainty (null if the cell could
 *   not be followed at all); motionCells is how many other cells it was
 *   compared with.
 */
export async function scanRotationMultiFrame(frameBases, bounds, viewZoom, frameTimes) {
  const grid = viewportTileGrid(bounds, viewZoom);
  if (!grid || !frameBases.length) return [];
  const { width, height } = grid;
  const grids = await Promise.all(frameBases.map((b) => fetchDbzGrid(b, "", grid)));
  const latest = grids[grids.length - 1];
  if (!latest) return [];
  const earlier = grids.slice(0, -1).filter(Boolean);
  const scale = Math.pow(2, grid.z - 7); // pixels per z7 pixel
  const MATCH_PX = 14 * scale; // ~10 km at 54°N: how far a signature may sit from where it was seen before

  const sigsNow = detectRotationSignatures(latest, width, height);
  const sigsBefore = earlier.map((g) => detectRotationSignatures(g, width, height));
  const cellsNow = detectStormCells(latest, width, height);

  // Motion of every current cell against its neighbours, over every scan
  // that loaded. A scan that failed to load is skipped, and its place in the
  // sequence is kept so the time between the remaining scans stays right.
  const usedScans = [];
  const usedMinutes = [];
  // Scan times are used only if EVERY scan has one. Mixing real times with
  // assumed ones would put the scans decades apart on one clock, and a
  // "storm" could then be linked across the whole map.
  const timed = Array.isArray(frameTimes) && frameBases.every((_, i) => Number.isFinite(frameTimes[i]));
  for (let i = 0; i < grids.length; i++) {
    if (!grids[i]) continue;
    const t = timed ? frameTimes[i] : null;
    usedScans.push(i === grids.length - 1 ? cellsNow : detectStormCells(grids[i], width, height));
    usedMinutes.push(t == null ? i * MOTION_TUNING.SCAN_INTERVAL_MIN : (t > 1e11 ? t / 1000 : t) / 60);
  }
  const kmPerPixelOf = (c) => kmPerPixelAt(grid, pixelToLonLat(grid.tx0 * 256 + c.x, grid.ty0 * 256 + c.y, grid.z)[1]);
  const cellMotion = cellMotionAgainstNeighbours(usedScans, usedMinutes, kmPerPixelOf);

  const tuning = ROTATION_TUNING;
  const out = [];
  for (const s of sigsNow) {
    let seen = 0;
    for (const prev of sigsBefore) if (prev.some((p) => Math.hypot(p.x - s.x, p.y - s.y) <= MATCH_PX)) seen++;
    let score = s.score;
    if (sigsBefore.length) score += seen > 0 ? 1 : sigsBefore.length >= 2 ? -1.5 : -0.5;

    // The cell this signature belongs to: the one whose outline contains it
    // (nearest centre if several do), else the nearest cell centre.
    let own = -1;
    let ownD = Infinity;
    let inside = false;
    for (let i = 0; i < cellsNow.length; i++) {
      const c = cellsNow[i];
      const within = s.x >= c.bbox.minX - 1 && s.x <= c.bbox.maxX + 1 && s.y >= c.bbox.minY - 1 && s.y <= c.bbox.maxY + 1;
      const d = Math.hypot(c.x - s.x, c.y - s.y);
      if (within ? !inside || d < ownD : !inside && d <= MATCH_PX && d < ownD) {
        own = i;
        ownD = d;
        inside = inside || within;
      }
    }
    const motion = own >= 0 ? cellMotion[own] : null;
    const deviationDeg = motion ? motion.deviationDeg : null;
    if (deviationDeg != null && deviationDeg >= 20 && deviationDeg <= 90) score += 1;

    if (score < tuning.SCORE_GREEN) continue;
    const [lon, lat] = pixelToLonLat(grid.tx0 * 256 + s.x, grid.ty0 * 256 + s.y, grid.z);
    out.push({
      ...s,
      score: Math.round(score * 10) / 10,
      tier: score >= tuning.SCORE_RED ? "red" : score >= tuning.SCORE_YELLOW ? "yellow" : "green",
      lon,
      lat,
      seenIn: seen + 1,
      scans: sigsBefore.length + 1,
      deviationDeg: deviationDeg == null ? null : Math.round(deviationDeg),
      deviationSigmaDeg: motion && motion.deviationSigmaDeg != null ? Math.round(motion.deviationSigmaDeg) : null,
      motionCells: motion ? motion.others : 0,
    });
  }
  return out;
}
