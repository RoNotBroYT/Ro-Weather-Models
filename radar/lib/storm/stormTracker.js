// Multi-frame storm motion tracking, built on top of rotationDetect.js.
//
// rotationDetect.js reads ONE reflectivity frame and infers rotation shape
// cues (notch, hole, gradient) from it. That is a snapshot: it says nothing
// about whether a signature is real motion or a one-frame speckle, and it
// cannot see the thing a human analyst watching an animated radar loop
// would catch immediately — a mesocyclone weakening on one cell while a NEW
// one spins up just downstream of it (a "cyclic" supercell handoff).
//
// This module adds that temporal layer:
//   1. TRACKING — link the same storm cell (or rotation signature) across
//      consecutive radar frames and estimate its motion (heading + speed).
//      How, in four steps per frame:
//        a. SHARED MOTION. Before deciding which cell is which, the
//           displacement most cells have in common between the previous
//           frame and this one is found by voting (estimateBulkShift in
//           rotationDetect.js). Without it, a line of showers moving along
//           its own length is mis-linked wholesale: each shower lands
//           nearer to where its NEIGHBOUR was than to where it was itself.
//        b. PREDICTION. Every track's position at this frame's time is
//           predicted from its own filtered motion; a track seen only once
//           borrows the shared motion (or a nearby track's) as a first
//           guess, with a wide tolerance.
//        c. ASSIGNMENT. Tracks and detections are paired so that the TOTAL
//           mismatch over the whole frame is as small as possible (the
//           Hungarian method), not pair-by-pair greedily. The mismatch is
//           the distance from the predicted position, measured in units of
//           how uncertain that prediction is, plus small penalties for a
//           change in size and in peak intensity. Pairs that would need a
//           speed above MAX_SPEED_KMH are never considered.
//        d. FILTERING. Each track carries a constant-velocity Kalman
//           filter. Every matched position nudges the track's position and
//           velocity by an amount set by how noisy positions are (measured:
//           see MEAS_SIGMA_KM) against how fast real storms change course
//           (ACCEL_SIGMA_KMH_PER_10MIN). Time between frames is always the
//           real difference of their timestamps, never a frame count. A
//           position far outside what the filter expects (a merge, a split,
//           a core re-forming) is down-weighted rather than believed, and a
//           detection too far from every prediction starts a new track
//           instead of being forced onto an old one. A cell cut by the edge
//           of the scanned grid is followed but hardly believed: only part
//           of it can be seen (see EDGE_CLIP_SIGMA_RADIUS_FRAC).
//      The filter also yields how uncertain the velocity still is, which
//      the summaries below report next to the speed.
//   2. PERSISTENCE — a signature seen on the SAME tracked cell in 2+
//      consecutive frames is far less likely to be a single-frame false
//      positive than a one-off flash. Persistent tracks are flagged; the
//      UI may choose to weight them more heavily. This does NOT change the
//      tier maths in rotationDetect.js — it is a separate, explicit
//      "seen again" signal, not a silent score boost.
//   3. HANDOFF — when a tracked signature is lost (fades below CELL_MIN_DBZ
//      or its notch/hole cues drop out) and a NEW signature appears shortly
//      after, close to where that lost cell's motion vector projects it to
//      be, the two tracks are linked as a probable mesocyclone handoff —
//      the radar-shape analogue of what storm chasers call a "cyclic"
//      supercell.
//
// IMPORTANT HONESTY NOTE (same standard as rotationDetect.js): this is
// still inference from reflectivity, not measured velocity. "Speed" here is
// how fast a blob of echo has been displacing across the map — the motion
// of the STORM, estimated from a handful of positions 5–10 minutes apart.
// It is not the wind, and it is not Doppler. With two positions the
// estimate is little better than a guess (two points always make a line),
// and the summaries say so in their uncertainty fields rather than hiding
// it. Tracking and persistence make a rotation signal more trustworthy than
// a single frame, but it is still not a confirmed mesocyclone and must be
// presented as such everywhere it's shown.
//
// What this module does NOT do: it does not forecast growth, decay or
// turning; it does not split one large blob into the separate cores inside
// it (a merged line of showers above 34 dBZ is ONE cell here, and its
// "motion" is the motion of the blob's weighted centre); it cannot tell a
// storm that genuinely jumped from one whose echo re-formed nearby; and it
// cannot properly measure a storm that is only partly inside the scanned
// area — its speed then comes from earlier frames, from the storms around
// it, or from how its one visible edge is moving, and is marked "low" until
// the whole of it has been in view for three frames.
//
// Data availability: RainViewer's public API only exposes roughly the past
// 2 hours of frames (see WeatherRadar.tsx's fetchFrames). This module tracks
// storms LIVE, frame-to-frame, as new frames arrive — it cannot retroactively
// track a storm from before this window (e.g. it cannot replay a past named
// event unless raw tiles for that event were captured and saved at the time).
//
// Verified by scripts/validate-tracker.mjs (synthetic scenes with known
// truth, old code against new) and scripts/validate-rotation.mjs.

import { detectRotationSignatures, detectStormCells, estimateBulkShift } from "./rotationDetect.js";

// --- Tunable constants -----------------------------------------------------
export const TRACK_TUNING = {
  // Matching gate: max pixels a cell could plausibly move between two
  // frames, expressed as speed (px per minute at the detector's scan zoom).
  // Only used when no scale is passed — see MAX_SPEED_KMH. One z7 pixel is
  // ~0.72 km at 54°N (1.22 km only at the equator), so 2.5 px/min is
  // ~108 km/h there. UK convective storms typically run 0-25 m/s
  // (0-90 km/h). We deliberately allow above the fast end (organised UK
  // squall lines can outrun typical storm-motion assumptions) rather than
  // lose a fast-moving cell from its track.
  MAX_SPEED_PX_PER_MIN: 2.5,
  MATCH_SLACK_PX: 4, // fixed extra tolerance on top of the speed gate
  /**
   * The same gate expressed physically, in km/h. USE THIS ONE where the
   * scale is known — pass kmPerPixel to stepStormTracks and the pixel gate
   * above is ignored.
   *
   * WHY THIS EXISTS
   *
   * A pixel gate is only meaningful at the zoom it was tuned for. The scan
   * zoom is clamped 5..7 depending on how far the map is zoomed out, and a
   * z5 pixel is four times the size of a z7 one — so the identical pixel
   * constant becomes a four-times-wider gate (~430 km/h at 54°N).
   *
   * At that width the matcher will happily call two completely unrelated
   * storms on opposite sides of the country "the same cell", producing a
   * track that leaps hundreds of kilometres between frames. A follow shot
   * built on such a track flies the camera across empty sea, which is
   * exactly the "I am tracking air" failure.
   *
   * 180 km/h is deliberately generous: organised UK squall lines can run at
   * 100+ km/h, and losing a fast cell is worse than occasionally linking a
   * near neighbour. It is an outer limit on the displacement from the last
   * OBSERVED position; inside it, the prediction-based test described in
   * the header decides.
   */
  MAX_SPEED_KMH: 180,
  /**
   * Physical equivalent of MATCH_SLACK_PX, in km. Also the smallest radius
   * around a track's predicted position inside which a detection may still
   * be linked to it, however confident the filter is — a storm's weighted
   * centre can step a few km when its core re-forms.
   */
  MATCH_SLACK_KM: 6,
  MAX_MISSED_FRAMES: 2, // frames a track can go unmatched before it's "lost"
  // Handoff gate: how close (px) and how soon (minutes) a new signature
  // must appear to a lost track's motion-projected position to count as a
  // probable mesocyclone handoff rather than an unrelated new cell.
  HANDOFF_MAX_DIST_PX: 14,
  HANDOFF_MAX_MINUTES: 25,
  // A track needs a signature (score >= SCORE_GREEN) in this many
  // consecutive frames to be flagged "persistent".
  PERSISTENT_MIN_FRAMES: 2,

  // --- Motion filter ------------------------------------------------------
  /**
   * Scale assumed when the caller passes none (legacy calls): a z7 pixel at
   * 54°N. Only the filter's noise terms use it; the reported speed always
   * uses the scale given to the summary function.
   */
  ASSUMED_KM_PER_PX: 0.72,
  /**
   * How far a cell's tracked point wanders, frame to frame, for reasons
   * that are not motion (the echo changing shape). One standard deviation
   * per axis, km.
   *
   * MEASURED, not assumed: on real frames (RainViewer zoom-6 tiles over
   * Florida and the central Mediterranean, 3 Oct 2026; 80–520 cell pairs
   * per fetch — rerun with `node scripts/validate-tracker.mjs --live`) the
   * step of the reflectivity-weighted centre differed from the
   * block-matched displacement of the same echo by a median of 0.75–1.0 px
   * (~1.7 km), i.e. roughly 1 km per axis per position. The same test on
   * the peak pixel (what this tracker used to follow) gave a median of
   * 2.1–2.9 px and an RMS of 6–9 px against 1.7–2.1 px. Larger cells wander
   * more, hence the radius term below. Where a scene's cells mostly share
   * one motion, the tracker also measures this noise for itself from how
   * much their steps disagree, and uses that if it is larger.
   */
  MEAS_SIGMA_KM: 1.0,
  MEAS_SIGMA_MIN_PX: 0.4, // a position is never trusted to better than this
  MEAS_SIGMA_RADIUS_FRAC: 0.07, // …nor to better than this share of the cell's radius
  /**
   * Position noise for a detection with no area (a rotation signature: the
   * notch or hole point, which hops around the cell edge much as the peak
   * pixel does). Not measured — set at twice the cell figure.
   */
  MEAS_SIGMA_NO_AREA_KM: 2.0,
  /**
   * Extra position uncertainty for a cell CUT BY THE EDGE of the scanned
   * grid (StormCell.touchesEdge), as a share of the radius of the part in
   * view. Only that part can be seen, and its centre is not the storm's: as
   * a storm moves in or out the visible part's centre lags, so the cell
   * appears to travel at about half its real speed (a round, even cell: 42%
   * while less than half of it is in view, 58% after) — and it does so
   * smoothly, frame after frame, which a filter would otherwise read as
   * well-established slow motion.
   *
   * With this term such positions keep the track alive but barely move its
   * motion estimate, which then rests on the frames where the whole cell
   * was in view, or on the motion shared with the cells around it. A storm
   * with neither — alone, and never wholly in view — is handled by the
   * far-side measurement below.
   *
   * Synthetic test (`validate-tracker.mjs` tier E, 100 scenes each; mean
   * speed error without → with this term, "without" being
   * `--tune EDGE_CLIP_SIGMA_RADIUS_FRAC=0`): a storm entering among six
   * others 23.5 → 12.6 km/h, with the true speed inside the stated 2 sigma
   * for 31 of 89 → 89 of 89; a storm leaving 6.1 → 2.7 km/h.
   *
   * The visible part's radius is the right order of size for the error
   * (half in view: 0.6 of it; a sliver: more). An assumption, not a
   * measurement; 0.5–1.5 give the same picture (tier E, `--tune`).
   */
  EDGE_CLIP_SIGMA_RADIUS_FRAC: 1.0,
  /**
   * THE FAR SIDE of an edge-cut cell. A cell cut by ONE side of the grid
   * still has its opposite extreme wholly in view, and that extreme moves
   * with the storm (as long as the storm keeps its shape). So for a track
   * with nothing better to go on — it began with no shared motion to
   * borrow, and has not yet had two whole-cell positions in a row — the
   * step of that extreme between two frames (and, along the border, the
   * step of the visible centre) is taken as a direct reading of velocity.
   * These two figures are how far that extreme is trusted, per position:
   * the 34 dBZ outline frays by a pixel or two from frame to frame.
   *
   * Without it such a track has only the edge-cut centres above, and with
   * those all but ignored its speed shrinks towards "not moving". Measured,
   * mean speed error without → with (switch it off for a run with
   * `validate-tracker.mjs --tune FAR_SIDE_SIGMA_KM=1000000`):
   *   synthetic lone storm entering (tier E)      32.6 → 12.8 km/h
   *       (the old two-point method: 19.7)
   *   real cell shapes, one at a time, slid rigidly across the border
   *   (`--real`/`--live` check 5; 3 Oct 2026, 19–130 cells per figure):
   *       entering   25–29 → 10–19 km/h   (old method 24–31)
   *       leaving     8–11 →  5–8 km/h    (old method 18–33)
   * It is NOT applied to tracks that have a shared motion to lean on: tried
   * during review on real shapes, it gave no gain there — the outline is
   * noisier than the prior it would replace. Either way the cell stays
   * "low" until three whole-cell positions are in.
   *
   * What it cannot allow for: a storm growing or decaying while it crosses.
   * Its outline then moves for reasons that are not travel.
   */
  FAR_SIDE_SIGMA_KM: 2.0,
  FAR_SIDE_SIGMA_MIN_PX: 1.5,
  /**
   * How much a storm's velocity is allowed to drift: one standard deviation
   * of the change per axis over ten minutes, km/h. This is the dial between
   * steadiness and responsiveness, and it is a compromise:
   *   - on real frames (hold-out test in validate-tracker.mjs, two scenes,
   *     ~130 cells) anything from 2 to 8 predicted the echo's position
   *     20–30 minutes on about equally well, and 10+ did slightly worse;
   *   - on a synthetic storm swinging 30–40° over a 40-minute loop, 4 lags
   *     the turn by ~13° (worse than a plain two-point difference), 8 keeps
   *     up to ~8° (level with it), while still halving its error on storms
   *     that hold their course.
   * 8 is the smallest value that follows the turn, and the largest the
   * real frames support. An assumption about storms, not a measurement.
   */
  ACCEL_SIGMA_KMH_PER_10MIN: 8,
  /** Spread (per axis, km/h) of the velocity of a cell about which nothing is known. */
  COLD_SPEED_SIGMA_KMH: 60,
  /** Spread (per axis, km/h) of one cell's velocity around the shared motion of the cells near it. */
  FLOW_SPEED_SIGMA_KMH: 20,
  /** Cells in one airstream still differ by a few km/h; this much (per axis) is "the same motion" when voting. */
  FLOW_DIFFER_KMH: 6,
  /** A detection further than this many standard deviations from a track's prediction is not that track. */
  GATE_SIGMAS: 3.5,
  /** Beyond this many standard deviations a matched position is down-weighted (it is a jump, not motion). */
  OUTLIER_SIGMAS: 3,
  /** A new cell this close to an established track starts from that track's motion (a split). */
  NEIGHBOUR_PRIOR_KM: 40,
};

/**
 * @typedef {Object} TrackPoint
 * @property {number} time    frame timestamp (ms epoch, from RainViewer frame.time * 1000)
 * @property {number} x       observed position this frame, pixels — never smoothed
 * @property {number} y
 * @property {"green"|"yellow"|"red"|null} tier  null if this point is a
 *   tracked storm cell with no rotation signature this frame
 * @property {number} score
 * @property {number} maxDbz
 * @property {number} [areaPx]  cell area this frame, when the detector reports one
 * @property {number} [peakX]   strongest pixel this frame, when the detector reports one
 * @property {number} [peakY]
 * @property {boolean} [edgeClipped]  present (true) when the cell was cut by
 *   the edge of the scanned grid this frame, so x/y is the centre of the
 *   part in view only — see EDGE_CLIP_SIGMA_RADIUS_FRAC
 * @property {{side:"W"|"E"|"N"|"S", at:number}} [farSide]  for a cell cut by
 *   one side of the grid: that side, and the pixel coordinate (x for W/E,
 *   y for N/S) of the cell's opposite extreme — see FAR_SIDE_SIGMA_KM
 */

/**
 * @typedef {Object} StormTrack
 * @property {string} id
 * @property {TrackPoint[]} points        chronological, oldest first
 * @property {number|null} vx             filtered velocity, px/min, null until 2+ points
 * @property {number|null} vy
 * @property {number} consecutiveSignatureFrames  current persistence streak
 * @property {boolean} persistent         consecutiveSignatureFrames >= PERSISTENT_MIN_FRAMES
 * @property {number} missedFrames        frames since last matched signature
 * @property {boolean} active             false once missedFrames > MAX_MISSED_FRAMES
 * @property {string|null} handoffFrom    id of the track this one probably continues from
 * @property {string|null} handoffTo      id of the track that probably continues this one
 * @property {number|null} [velSigma]     1-sigma uncertainty of vx and of vy, px/min; null until 2+ points
 * @property {string|null} [splitFrom]    id of the established track this one appeared beside (a probable split)
 * @property {Object} [kf]                filter state — internal, do not rely on its shape
 */

let trackIdCounter = 0;
function nextTrackId() {
  trackIdCounter += 1;
  return `t${trackIdCounter}`;
}

/**
 * For a cell cut by exactly ONE side of the grid: which side, and where the
 * cell's opposite extreme is — the one edge of it that is wholly in view
 * (see FAR_SIDE_SIGMA_KM). null for a cell clear of the border, or cut by
 * two sides at once (a corner, or a band right across the grid).
 */
function farSideOf(cell, width, height) {
  const b = cell.bbox;
  if (!b) return null;
  const west = b.minX <= 0;
  const east = b.maxX >= width - 1;
  const north = b.minY <= 0;
  const south = b.maxY >= height - 1;
  if (Number(west) + Number(east) + Number(north) + Number(south) !== 1) return null;
  if (west) return { side: "W", at: b.maxX };
  if (east) return { side: "E", at: b.minX };
  if (north) return { side: "N", at: b.maxY };
  return { side: "S", at: b.minY };
}

/** Euclidean distance between two points. */
function dist(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

/**
 * Ground distance per pixel at a grid position. `kmPerPixel` may be a plain
 * number (one scale for the whole grid) or a function of (x, y) — Web
 * Mercator pixels shrink towards the poles, so over a UK-wide scan the
 * scale at 50°N and at 61°N differ by a third.
 */
function scaleAt(kmPerPixel, x, y) {
  const s = typeof kmPerPixel === "function" ? kmPerPixel(x, y) : kmPerPixel;
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? s : null;
}

/**
 * Smallest-total-cost pairing of rows to columns (the Hungarian method,
 * Kuhn–Munkres with potentials, O(rows² × cols)). Needs rows <= cols.
 *
 * @param {Float64Array[]} cost  cost[row][col]
 * @returns {Int32Array} column chosen for each row
 */
function assignMinCost(cost, rows, cols) {
  const u = new Float64Array(rows + 1);
  const v = new Float64Array(cols + 1);
  const p = new Int32Array(cols + 1);
  const way = new Int32Array(cols + 1);
  const minv = new Float64Array(cols + 1);
  const used = new Uint8Array(cols + 1);
  for (let i = 1; i <= rows; i++) {
    p[0] = i;
    let j0 = 0;
    minv.fill(Infinity);
    used.fill(0);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= cols; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= cols; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }
  const out = new Int32Array(rows).fill(-1);
  for (let j = 1; j <= cols; j++) if (p[j]) out[p[j] - 1] = j - 1;
  return out;
}

/**
 * Penalty (in the same "standard deviations squared" units as the position
 * mismatch) for a detection that differs in size or peak intensity from
 * what the track last looked like. Deliberately mild and capped: cells
 * really do grow and decay between frames, so this only breaks ties
 * between detections that are about equally well placed.
 */
function attributePenalty(last, sig) {
  let pen = 0;
  if (last.areaPx > 0 && sig.areaPx > 0) {
    const l = Math.log(sig.areaPx / last.areaPx) / 0.7;
    pen += Math.min(3, l * l);
  }
  if (typeof last.maxDbz === "number" && typeof sig.maxDbz === "number") {
    const d = (sig.maxDbz - last.maxDbz) / 6;
    pen += Math.min(3, d * d);
  }
  return pen;
}
const ATTRIBUTE_PENALTY_MAX = 6;

/** Component-wise median of a list of numbers (empty list → null). */
function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Advance the track set by one frame's worth of detections (rotation
 * signatures or storm cells — anything with x, y and maxDbz).
 * Call this once per frame, oldest to newest, reusing the returned `tracks`
 * array as the input for the next call.
 *
 * A frame whose time is not later than the newest one already processed is
 * ignored (the same array is returned): a frame listed twice would
 * otherwise be read as a storm that covered no distance in no time, and a
 * frame out of order as one going backwards.
 *
 * @param {StormTrack[]} tracks   tracks from the previous call (or [] to start)
 * @param {number} time           this frame's timestamp, ms epoch
 * @param {import("./rotationDetect").RotationSignature[]} signatures
 *   An optional `areaPx` on each detection sharpens the matching and sets
 *   how far its position is trusted.
 * @param {Partial<typeof TRACK_TUNING>} [overrides]
 * @param {number | ((x:number, y:number) => number)} [kmPerPixel] ground
 *   distance per pixel at the scan zoom — a number, or a function of grid
 *   position when the grid spans enough latitude for the scale to vary.
 *   Strongly recommended: without it the matching gate falls back to a pixel
 *   constant tuned for zoom 7, which at wider zooms is several times too
 *   generous and links unrelated storms. See TRACK_TUNING.MAX_SPEED_KMH.
 * @returns {StormTrack[]} updated track list (active + recently-lost, for handoff linking)
 */
export function stepStormTracks(tracks, time, signatures, overrides, kmPerPixel) {
  const tuning = { ...TRACK_TUNING, ...overrides };

  // Frames must run forwards. `lastFrameTime` is remembered on the array so
  // that an EMPTY frame (which leaves no point behind) still counts.
  let newest = typeof tracks.lastFrameTime === "number" ? tracks.lastFrameTime : -Infinity;
  for (const t of tracks) newest = Math.max(newest, t.points[t.points.length - 1].time);
  if (!(time > newest)) return tracks;

  // When the scale is known, gate on a physical speed rather than a pixel
  // one — see MAX_SPEED_KMH for why the pixel gate is unsafe across zooms.
  const scaleKnown = typeof kmPerPixel === "function" || (typeof kmPerPixel === "number" && kmPerPixel > 0);
  const kmppAt = (x, y) => (scaleKnown && scaleAt(kmPerPixel, x, y)) || tuning.ASSUMED_KM_PER_PX;
  const speedGateAt = (kmpp) => (scaleKnown ? tuning.MAX_SPEED_KMH / 60 / kmpp : tuning.MAX_SPEED_PX_PER_MIN);
  const slackAt = (kmpp) => (scaleKnown ? tuning.MATCH_SLACK_KM / kmpp : tuning.MATCH_SLACK_PX);
  // Filter noise terms, converted from km to this grid's pixels.
  const accelVar = (kmpp) => (tuning.ACCEL_SIGMA_KMH_PER_10MIN / 60 / kmpp) ** 2 / 10; // px² / min³
  const speedVar = (kmh, kmpp) => (kmh / 60 / kmpp) ** 2; // (px/min)²
  const measVar = (sig, kmpp) => {
    const s =
      sig.areaPx > 0
        ? Math.max(tuning.MEAS_SIGMA_KM / kmpp, tuning.MEAS_SIGMA_RADIUS_FRAC * Math.sqrt(sig.areaPx / Math.PI))
        : tuning.MEAS_SIGMA_NO_AREA_KM / kmpp;
    return Math.max(tuning.MEAS_SIGMA_MIN_PX, s) ** 2;
  };
  // A cell cut by the edge of the grid: how far the centre of the part in
  // view may be from the storm's own (see EDGE_CLIP_SIGMA_RADIUS_FRAC).
  const clipVar = (sig) =>
    sig.edgeClipped && sig.areaPx > 0 ? (tuning.EDGE_CLIP_SIGMA_RADIUS_FRAC * Math.sqrt(sig.areaPx / Math.PI)) ** 2 : 0;
  const pointOf = (sig) => {
    const p = { time, x: sig.x, y: sig.y, tier: sig.tier, score: sig.score, maxDbz: sig.maxDbz };
    if (sig.areaPx > 0) p.areaPx = sig.areaPx;
    if (sig.edgeClipped) p.edgeClipped = true;
    if (sig.farSide) p.farSide = sig.farSide;
    if (sig.patch != null) p.patch = sig.patch;
    if (typeof sig.peakX === "number" && typeof sig.peakY === "number") {
      p.peakX = sig.peakX;
      p.peakY = sig.peakY;
    }
    return p;
  };

  const active = tracks.filter((t) => t.active);
  const usedTrack = new Set();
  const usedSig = new Set();

  // 1a. SHARED MOTION between the previous frame and this one, from the
  // cells themselves and before any pairing is decided.
  const fresh = active.filter((t) => t.missedFrames === 0);
  let flow = null;
  // How jumpy positions are in this scene, learnt from the vote (see
  // estimateBulkShift's `spread`); carried from frame to frame on the array.
  // Each frame's reading is rough (it may rest on five or six cells), so the
  // readings are averaged, as variances, over the frames seen so far.
  let sceneVarSum = typeof tracks.sceneVarSum === "number" ? tracks.sceneVarSum : 0;
  let sceneVarN = typeof tracks.sceneVarN === "number" ? tracks.sceneVarN : 0;
  if (fresh.length && signatures.length) {
    const prevTime = fresh[0].points[fresh[0].points.length - 1].time;
    const dtMin = (time - prevTime) / 60000;
    const before = fresh
      .filter((t) => t.points[t.points.length - 1].time === prevTime)
      .map((t) => t.points[t.points.length - 1]);
    let mx = 0;
    let my = 0;
    for (const s of signatures) {
      mx += s.x;
      my += s.y;
    }
    const kmpp = kmppAt(mx / signatures.length, my / signatures.length);
    // "Agree" = within position noise plus the few km/h by which cells in
    // one airstream genuinely differ.
    const differKm = (tuning.FLOW_DIFFER_KMH / 60) * dtMin;
    const tolPx = Math.max(1.5, (2 * tuning.MEAS_SIGMA_KM + differKm) / kmpp);
    const reachPx = speedGateAt(kmpp) * dtMin + slackAt(kmpp);
    const few = Math.min(before.length, signatures.length);
    let shift = estimateBulkShift(before, signatures, reachPx, tolPx);
    if (!shift) {
      // Nothing agrees that closely. Positions in this scene may simply be
      // jumpier than assumed, so look once more with twice the tolerance —
      // but a looser vote is easier to win by coincidence, so it is only
      // believed when most of the cells (and at least four) back it.
      const loose = estimateBulkShift(before, signatures, reachPx, 2 * tolPx);
      if (loose && loose.support >= Math.max(4, 0.6 * few)) shift = loose;
    }
    if (shift) {
      flow = { vx: shift.dx / dtMin, vy: shift.dy / dtMin };
      // The scatter of the cells' steps about the shared one is position
      // noise at both ends plus genuine differences in motion; take the
      // latter out and halve the variance to get one position's noise. Only
      // trusted when most cells (and at least five) lie near the shared
      // motion: where they do not, the scatter is storms going their own
      // ways, not noise.
      if (shift.spreadCells >= Math.max(5, 0.6 * few)) {
        sceneVarSum += Math.max(0, (shift.spread * kmpp) ** 2 - differKm ** 2) / 2;
        sceneVarN += 1;
      }
    }
  }
  if (!flow) {
    // Too few cells to vote: fall back to the median of the motions already
    // being tracked (a median, so one mis-tracked cell cannot drag it).
    const known = active.filter((t) => t.vx != null && t.points.length >= 3);
    if (known.length >= 3) flow = { vx: median(known.map((t) => t.kf.vx)), vy: median(known.map((t) => t.kf.vy)) };
  }

  // 1b. PREDICTION, and the list of pairs worth considering.
  const gate2 = tuning.GATE_SIGMAS * tuning.GATE_SIGMAS;
  const sceneSigmaKm = sceneVarN ? Math.sqrt(sceneVarSum / sceneVarN) : 0;
  // A scene measured to be jumpier than MEAS_SIGMA_KM assumes is believed
  // (up to three times it); a calmer one is not — the floor stays.
  const sceneVarAt = (kmpp) => (Math.min(sceneSigmaKm, 3 * tuning.MEAS_SIGMA_KM) / kmpp) ** 2;
  const sigVar = signatures.map((s) => {
    const kmpp = kmppAt(s.x, s.y);
    return Math.max(measVar(s, kmpp), sceneVarAt(kmpp));
  });
  // What the FILTER is told about each position's noise. Same as sigVar,
  // plus the allowance for a cell cut by the grid edge. The pairing step
  // keeps using sigVar: a detection must not look like a better match for
  // every track nearby merely because its position is vague.
  const updVar = signatures.map((s, i) => sigVar[i] + clipVar(s));
  /** Where the filter expects a track to be at this frame's time, and how surely. */
  const predict = (track, startCold) => {
    const k = track.kf;
    const kmpp = kmppAt(k.x, k.y);
    const dt = (time - k.t) / 60000;
    const q = accelVar(kmpp);
    const vx0 = startCold ? 0 : k.vx;
    const vy0 = startCold ? 0 : k.vy;
    const c0 = startCold ? speedVar(tuning.COLD_SPEED_SIGMA_KMH, kmpp) : k.c;
    return {
      dt,
      kmpp,
      vx0,
      vy0,
      x: k.x + vx0 * dt,
      y: k.y + vy0 * dt,
      a: k.a + 2 * k.b * dt + c0 * dt * dt + (q * dt * dt * dt) / 3,
      b: k.b + c0 * dt + (q * dt * dt) / 2,
      c: c0 + q * dt,
    };
  };
  const preds = active.map((track) => {
    const k = track.kf;
    // A track seen once has no motion of its own yet. If nothing better was
    // known when it started, give it the shared motion found just now.
    if (k.cold && flow) {
      k.vx = flow.vx;
      k.vy = flow.vy;
      k.c = speedVar(tuning.FLOW_SPEED_SIGMA_KMH, kmppAt(k.x, k.y));
      k.cold = false;
      k.primed = true;
    }
    return predict(track, false);
  });

  /** Every (track, detection) pair that passes the gates, with its mismatch. */
  const candidatePairs = (trackIdx, sigIdx) => {
    const pairs = [];
    for (const ti of trackIdx) {
      const track = active[ti];
      const pr = preds[ti];
      const last = track.points[track.points.length - 1];
      const hardGate = speedGateAt(pr.kmpp) * pr.dt + slackAt(pr.kmpp);
      const footprint = last.areaPx > 0 ? Math.sqrt(last.areaPx / Math.PI) : 0;
      const floorVar = (Math.max(slackAt(pr.kmpp), footprint) / tuning.GATE_SIGMAS) ** 2;
      for (const si of sigIdx) {
        const sig = signatures[si];
        if (dist(last.x, last.y, sig.x, sig.y) > hardGate) continue; // faster than any storm
        const d2 = (sig.x - pr.x) ** 2 + (sig.y - pr.y) ** 2;
        // A track whose positions have been landing wide of its predictions
        // gets a proportionally wider gate (see velocitySigma).
        const m2 = d2 / Math.max((pr.a + sigVar[si]) * missInflation(track.kf), floorVar);
        if (m2 > gate2) continue;
        pairs.push({ ti, si, cost: m2 + attributePenalty(last, sig) });
      }
    }
    return pairs;
  };

  // 1c. ASSIGNMENT. Tracks and detections that share no candidate pair
  // cannot affect each other, so the frame is split into such groups and
  // each is solved on its own — a crowded frame stays cheap.
  // Leaving a track unmatched costs more than any allowed pair, so a
  // detection inside a track's gate is always preferred to losing the track.
  const MISS = gate2 + ATTRIBUTE_PENALTY_MAX + 1;
  const FORBIDDEN = 1e9;
  const solve = (pairs) => {
    const parent = new Int32Array(active.length + signatures.length);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = (i) => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    for (const p of pairs) parent[find(p.ti)] = find(active.length + p.si);
    const groups = new Map();
    for (const p of pairs) {
      const g = find(p.ti);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(p);
    }
    /** @type {Array<{ti:number, si:number}>} */
    const found = [];
    for (const group of groups.values()) {
      const tIdx = [...new Set(group.map((p) => p.ti))];
      const sIdx = [...new Set(group.map((p) => p.si))];
      const rows = tIdx.length;
      const cols = sIdx.length + rows; // one "no match" column per track
      const cost = tIdx.map((_, r) => {
        const row = new Float64Array(cols).fill(FORBIDDEN);
        row[sIdx.length + r] = MISS;
        return row;
      });
      const tPos = new Map(tIdx.map((t, i) => [t, i]));
      const sPos = new Map(sIdx.map((s, i) => [s, i]));
      for (const p of group) cost[tPos.get(p.ti)][sPos.get(p.si)] = p.cost;
      const chosen = assignMinCost(cost, rows, cols);
      for (let r = 0; r < rows; r++) {
        const c = chosen[r];
        if (c >= 0 && c < sIdx.length && cost[r][c] < FORBIDDEN) found.push({ ti: tIdx[r], si: sIdx[c] });
      }
    }
    return found;
  };

  const allTracks = active.map((_, i) => i);
  const allSigs = signatures.map((_, i) => i);
  const firstPairs = candidatePairs(allTracks, allSigs);
  const matches = solve(firstPairs);
  // Second pass, for tracks seen only once that found NOTHING where the
  // borrowed motion put them: a storm moving quite unlike its neighbours
  // (crossing them, say) would otherwise never be picked up. They get the
  // "nothing known" prediction — where they were, with a wide tolerance —
  // and whatever detections the first pass left over. A track that did have
  // a candidate and lost it to another track is not retried: its storm has
  // been claimed, and a wide second look would only grab someone else's.
  {
    const takenT = new Set(matches.map((m) => m.ti));
    const takenS = new Set(matches.map((m) => m.si));
    const hadCandidate = new Set(firstPairs.map((p) => p.ti));
    const retry = allTracks.filter(
      (ti) => !takenT.has(ti) && !hadCandidate.has(ti) && active[ti].points.length === 1 && (preds[ti].vx0 !== 0 || preds[ti].vy0 !== 0)
    );
    if (retry.length) {
      for (const ti of retry) preds[ti] = predict(active[ti], true);
      matches.push(...solve(candidatePairs(retry, allSigs.filter((si) => !takenS.has(si)))));
    }
  }

  // 1d. FILTERING: fold each matched position into its track.
  for (const { ti, si } of matches) {
    const track = active[ti];
    const sig = signatures[si];
    const pr = preds[ti];
    const k = track.kf;
    usedTrack.add(track.id);
    usedSig.add(si);

    const ix = sig.x - pr.x; // "innovation": observed minus predicted
    const iy = sig.y - pr.y;
    let s = pr.a + updVar[si];
    const nis = (ix * ix + iy * iy) / s; // ~2 on average when the model is right
    // A position far outside what the filter expects is a jump (merge,
    // split, re-formed core), not motion: widen its noise so it moves the
    // estimate no more than an OUTLIER_SIGMAS step would have.
    const out2 = tuning.OUTLIER_SIGMAS * tuning.OUTLIER_SIGMAS;
    if (nis > out2) s *= nis / out2;
    const k1 = pr.a / s;
    const k2 = pr.b / s;
    k.x = pr.x + k1 * ix;
    k.y = pr.y + k1 * iy;
    k.vx = pr.vx0 + k2 * ix;
    k.vy = pr.vy0 + k2 * iy;
    k.a = (1 - k1) * pr.a;
    k.b = (1 - k1) * pr.b;
    k.c = pr.c - k2 * pr.b;
    k.t = time;
    k.cold = false;

    // A track is "primed" once it has a motion from something other than
    // edge-cut positions: a shared or neighbouring motion to start from, or
    // two whole-cell positions in a row. Until then, and while the cell is
    // cut by the same side of the grid in consecutive frames, the step of
    // its far side is folded in as a direct reading of velocity (see
    // FAR_SIDE_SIGMA_KM).
    const prev = track.points[track.points.length - 1];
    if (!sig.edgeClipped && !prev.edgeClipped) k.primed = true;
    if (!k.primed && sig.farSide && prev.farSide && sig.farSide.side === prev.farSide.side) {
      const acrossX = sig.farSide.side === "W" || sig.farSide.side === "E";
      const step = sig.farSide.at - prev.farSide.at;
      const zx = (acrossX ? step : sig.x - prev.x) / pr.dt;
      const zy = (acrossX ? sig.y - prev.y : step) / pr.dt;
      const se = Math.max(tuning.FAR_SIDE_SIGMA_MIN_PX, tuning.FAR_SIDE_SIGMA_KM / pr.kmpp);
      let rv = (2 * se * se) / (pr.dt * pr.dt); // two positions, each good to `se`
      const jx = zx - k.vx;
      const jy = zy - k.vy;
      // The same guard as for positions: a reading far outside what the
      // track expects (the outline jumped — a merge, a new core) is
      // down-weighted, not believed.
      const nv = (jx * jx + jy * jy) / (k.c + rv);
      if (nv > out2) rv = (k.c + rv) * (nv / out2) - k.c;
      const g = k.c / (k.c + rv);
      const h = k.b / (k.c + rv);
      k.vx += g * jx;
      k.vy += g * jy;
      k.x += h * jx;
      k.y += h * jy;
      k.a -= h * k.b;
      k.b *= 1 - g;
      k.c *= 1 - g;
    }
    // Once the track has a velocity of its own, keep score of how well the
    // filter's expectations are being met; the reported uncertainty is
    // widened when they are not (see velocitySigma). A position cut by the
    // grid edge is left out: it was given so much room that it "fits"
    // whatever happens, and would make the track look better behaved than
    // it has been shown to be.
    if (track.points.length >= 2 && !sig.edgeClipped) {
      k.nisSum += nis / 2;
      k.nisN += 1;
    }

    track.points.push(pointOf(sig));
    track.vx = k.vx;
    track.vy = k.vy;
    track.velSigma = velocitySigma(k);
    track.missedFrames = 0;
    track.consecutiveSignatureFrames += 1;
    track.persistent = track.consecutiveSignatureFrames >= tuning.PERSISTENT_MIN_FRAMES;
  }

  // 2. Tracks not matched this frame: age them, deactivate if stale.
  for (const track of active) {
    if (usedTrack.has(track.id)) continue;
    track.missedFrames += 1;
    track.consecutiveSignatureFrames = 0;
    track.persistent = false;
    if (track.missedFrames > tuning.MAX_MISSED_FRAMES) track.active = false;
  }

  // 3. Unmatched signatures start new tracks. Check whether each one is a
  // probable handoff from a track that failed to match THIS frame — either
  // because it just faded (still "active" by miss-count, but unmatched
  // right now) or because it went fully inactive on an earlier frame and
  // is still within the handoff time window. Either way, it's a candidate
  // "parent" mesocyclone for a nearby new signature.
  const newlyLost = tracks.filter(
    (t) =>
      !usedTrack.has(t.id) &&
      t.handoffTo == null &&
      time - t.points[t.points.length - 1].time <= tuning.HANDOFF_MAX_MINUTES * 60000
  );
  // Tracks with a motion of their own that were seen this frame: a new cell
  // appearing beside one most likely split from it and starts with its motion.
  const established = active.filter((t) => usedTrack.has(t.id) && t.points.length >= 3);
  for (let i = 0; i < signatures.length; i++) {
    if (usedSig.has(i)) continue;
    const sig = signatures[i];
    const kmpp = kmppAt(sig.x, sig.y);
    let v0x = 0;
    let v0y = 0;
    let cold = true;
    let splitFrom = null;
    let nearest = null;
    let nearestD = tuning.NEIGHBOUR_PRIOR_KM / kmpp;
    for (const t of established) {
      const d = dist(t.kf.x, t.kf.y, sig.x, sig.y);
      if (d < nearestD) {
        nearestD = d;
        nearest = t;
      }
    }
    if (nearest) {
      v0x = nearest.kf.vx;
      v0y = nearest.kf.vy;
      cold = false;
      const lastArea = nearest.points[nearest.points.length - 2].areaPx;
      if (lastArea > 0 && nearestD <= Math.sqrt(lastArea / Math.PI) + slackAt(kmpp)) splitFrom = nearest.id;
    } else if (flow) {
      v0x = flow.vx;
      v0y = flow.vy;
      cold = false;
    }
    const newTrack = {
      id: nextTrackId(),
      points: [pointOf(sig)],
      vx: null,
      vy: null,
      consecutiveSignatureFrames: 1,
      persistent: false,
      missedFrames: 0,
      active: true,
      handoffFrom: null,
      handoffTo: null,
      velSigma: null,
      splitFrom,
      kf: {
        t: time,
        x: sig.x,
        y: sig.y,
        vx: v0x,
        vy: v0y,
        a: updVar[i],
        b: 0,
        c: speedVar(cold ? tuning.COLD_SPEED_SIGMA_KMH : tuning.FLOW_SPEED_SIGMA_KMH, kmpp),
        cold,
        primed: !cold, // has a motion to start from (see step 1d)
        nisSum: 0,
        nisN: 0,
      },
    };
    let bestLost = null;
    let bestDist = Infinity;
    for (const lost of newlyLost) {
      if (lost.handoffTo != null) continue; // already claimed
      const k = lost.kf;
      const dtMin = (time - k.t) / 60000;
      const d = dist(k.x + k.vx * dtMin, k.y + k.vy * dtMin, sig.x, sig.y);
      if (d <= tuning.HANDOFF_MAX_DIST_PX && d < bestDist) {
        bestDist = d;
        bestLost = lost;
      }
    }
    if (bestLost) {
      newTrack.handoffFrom = bestLost.id;
      bestLost.handoffTo = newTrack.id;
    }
    tracks.push(newTrack);
  }

  // Prune tracks that are inactive, unlinked to a handoff, and old enough
  // that they can no longer be a handoff parent for a future frame.
  const out = tracks.filter(
    (t) => t.active || (t.handoffTo == null && time - t.points[t.points.length - 1].time <= tuning.HANDOFF_MAX_MINUTES * 60000) || t.handoffTo != null
  );
  out.lastFrameTime = time;
  out.sceneVarSum = sceneVarSum;
  out.sceneVarN = sceneVarN;
  out.sceneSigmaKm = sceneSigmaKm;
  return out;
}

/**
 * One-sigma uncertainty of each velocity component, px/min.
 *
 * The filter's own figure assumes positions are as noisy as MEAS_SIGMA_KM
 * says. Where a particular track's positions have been landing further from
 * the predictions than that (a ragged, shape-shifting cell), the figure is
 * widened in proportion — by the root of the average squared miss, counted
 * with two "as expected" phantom observations so that one unlucky frame on
 * a short track does not swing it.
 */
function velocitySigma(k) {
  return Math.sqrt(Math.max(0, k.c) * missInflation(k));
}

/** How much larger than expected this track's squared prediction misses have been (never below 1). */
function missInflation(k) {
  return Math.max(1, (k.nisSum + 2) / (k.nisN + 2));
}

/**
 * Run the tracker over a full, already-decoded sequence of frames (oldest
 * first). Convenience wrapper around stepStormTracks for offline/backtest
 * use (the live UI calls stepStormTracks per-frame as frames arrive).
 *
 * @param {Array<{time:number, dbz:Int16Array, width:number, height:number}>} frames
 * @param {Partial<import("./rotationDetect").ROTATION_TUNING>} [detectorOverrides]
 * @param {Partial<typeof TRACK_TUNING>} [trackOverrides]
 * @param {number | ((x:number, y:number) => number)} [kmPerPixel]
 * @returns {StormTrack[]}
 */
export function trackRotationSequence(frames, detectorOverrides, trackOverrides, kmPerPixel) {
  let tracks = [];
  for (const frame of frames) {
    const sigs = detectRotationSignatures(frame.dbz, frame.width, frame.height, detectorOverrides);
    tracks = stepStormTracks(tracks, frame.time, sigs, trackOverrides, kmPerPixel);
  }
  return tracks;
}

/**
 * Track EVERY storm cell across a sequence of frames, not just those showing
 * rotation cues.
 *
 * trackRotationSequence above answers "which rotating storms are there?".
 * This answers "which storms are there?", which is what you need to let
 * someone point at one and say follow that. Most cells worth following — a
 * heavy shower, a squall segment, a growing tower — never show a notch or a
 * bounded weak echo region, so the rotation-seeded tracker never sees them.
 *
 * The matching, motion and persistence logic is deliberately NOT duplicated:
 * detectStormCells returns the same {x, y, maxDbz} shape stepStormTracks
 * already consumes, so cells feed straight through the existing tracker.
 * `tier` is null on every point because a plain cell makes no rotation
 * claim — and summarizeTracks filters on a non-null tier, so use
 * summarizeCellTracks below for these.
 *
 * Frames are put in time order first, and a frame with the same timestamp
 * as one already taken is dropped (see stepStormTracks).
 *
 * @param {Array<{time:number, dbz:Int16Array, width:number, height:number}>} frames
 * @param {Partial<import("./rotationDetect").ROTATION_TUNING>} [detectorOverrides]
 * @param {Partial<typeof TRACK_TUNING>} [trackOverrides]
 * @param {number | ((x:number, y:number) => number)} [kmPerPixel] scale at
 *   the scan zoom — strongly recommended, see MAX_SPEED_KMH
 * @returns {StormTrack[]}
 */
export function trackCellSequence(frames, detectorOverrides, trackOverrides, kmPerPixel) {
  let tracks = [];
  const ordered = [...frames].sort((a, b) => a.time - b.time);
  for (const frame of ordered) {
    const cells = detectStormCells(frame.dbz, frame.width, frame.height, detectorOverrides);
    // The tracker scores by rotation confidence, which does not apply here.
    // Peak reflectivity stands in as "how notable is this cell".
    const asSignatures = cells.map((c) => ({
      // Track the cell's REFLECTIVITY-WEIGHTED CENTRE: every pixel counts in
      // proportion to how far it is above the cell threshold, so the point
      // is pulled towards the core and away from a long, weak precipitation
      // shield — but it is an average over the whole cell, so it does not
      // hop when the single strongest pixel moves from one side of the core
      // to the other. The peak pixel itself (what this used to follow) is
      // one of several equally strong pixels on integer dBZ data, and on
      // real frames it hopped a median of 2.1–2.9 px per frame against
      // 0.75–1.0 px for this centre (see MEAS_SIGMA_KM) — more than those
      // storms moved in that time (1.4–1.7 px), so the old speeds were
      // mostly noise.
      x: c.weightedX ?? c.peakX,
      y: c.weightedY ?? c.peakY,
      tier: null,
      score: c.maxDbz,
      maxDbz: c.maxDbz,
      areaPx: c.areaPx,
      meanDbz: c.meanDbz,
      // Carried along so a UI can still mark the strongest pixel.
      peakX: c.peakX,
      peakY: c.peakY,
      // Part of the cell may lie outside the scanned grid: what is tracked
      // is then the centre of the part in view (EDGE_CLIP_SIGMA_RADIUS_FRAC).
      edgeClipped: c.touchesEdge === true,
      farSide: farSideOf(c, frame.width, frame.height),
      patch: c.patch,
    }));
    tracks = stepStormTracks(tracks, frame.time, asSignatures, trackOverrides, kmPerPixel);
  }
  return tracks;
}

/**
 * Speed, heading and their uncertainties for one track, in real units.
 * Shared by both summaries so the two cannot drift apart.
 *
 * WHAT THE UNCERTAINTY MEANS
 *
 * `speedSigmaKmh` is one standard deviation of the filter's velocity
 * estimate, per component. It allows for the storm having changed course
 * during the track (ACCEL_SIGMA_KMH_PER_10MIN) and is widened when the
 * track's positions have fitted its predictions worse than expected — so it
 * never falls much below ~7 km/h however many frames there are: positions
 * a kilometre uncertain, ten minutes apart, cannot say more than that
 * about a storm that may be turning. `headingSigmaDeg` is the matching
 * figure for direction; it grows as the speed falls, because a slow
 * storm's displacement is small against the position noise — at 45° or
 * more the direction is not known.
 *
 * HOW WELL THAT HOLDS (scripts/validate-tracker.mjs): on synthetic storms,
 * most of which hold a steady course, it is cautious — the true speed lay
 * within one sigma 92% of the time, where 68% would be exact. On real
 * frames there is no true speed to compare with, but the matching position
 * figure (projectedRadiusKm, built from the same numbers) held the echo
 * 60–87% of the time 20–30 minutes on (four fetches on 3 Oct 2026, two
 * regions, 8–128 cells per figure) against a design of two in three.
 * Treat it as "about this much", not as a precise error bar.
 *
 * `motionConfidence` turns it into words:
 *   "none"    one position only — there is no motion estimate at all
 *   "low"     two positions, or sigma above 12 km/h — too early to say;
 *             do not draw an arrow on this
 *   "medium"  three or more positions and sigma within 12 km/h
 *   "high"    four or more positions and sigma within 8 km/h (the filter
 *             has settled and the track has behaved as expected)
 * Positions at which the cell was cut by the edge of the scanned grid do
 * NOT count towards "three" or "four": they show where the visible part
 * was, not where the storm was (see EDGE_CLIP_SIGMA_RADIUS_FRAC). A storm
 * that has been half out of view all along therefore stays "low" however
 * many frames it has been followed for.
 * `headingReliable` is true only when confidence is medium or high AND the
 * direction is good to 25°.
 *
 * These describe how well the PAST motion is pinned down. They are not a
 * forecast skill score.
 */
function motionOf(track, kmpp) {
  const none = { headingDeg: null, speedKmh: null, speedSigmaKmh: null, headingSigmaDeg: null, motionConfidence: "none", headingReliable: false };
  if (track.vx == null || track.vy == null) return none;
  const pxPerMin = Math.hypot(track.vx, track.vy);
  const sigmaKmh = (track.velSigma ?? 0) * kmpp * 60;
  const speedKmh = pxPerMin * kmpp * 60;
  // Whole-cell positions only — see the note on edge-cut positions above.
  let n = 0;
  for (const p of track.points) if (!p.edgeClipped) n++;
  const motionConfidence = n < 3 || sigmaKmh > 12 ? "low" : n >= 4 && sigmaKmh <= 8 ? "high" : "medium";
  if (pxPerMin === 0) {
    return { ...none, speedSigmaKmh: sigmaKmh, motionConfidence };
  }
  // Screen-space atan2 (y grows downward); 0deg = due north. Mercator is
  // conformal, so a bearing on the grid is a bearing on the ground.
  let headingDeg = (Math.atan2(track.vx, -track.vy) * 180) / Math.PI;
  if (headingDeg < 0) headingDeg += 360;
  const headingSigmaDeg = (Math.atan2(sigmaKmh, speedKmh) * 180) / Math.PI;
  return {
    headingDeg,
    speedKmh,
    speedSigmaKmh: sigmaKmh,
    headingSigmaDeg,
    motionConfidence,
    headingReliable: motionConfidence !== "low" && headingSigmaDeg <= 25,
  };
}

/**
 * UI-ready summary for cell tracks (the counterpart to summarizeTracks,
 * which filters to rotation-flagged points only).
 *
 * Only cells present in the NEWEST frame are returned. A track that went
 * unmatched in the latest frame is kept internally for a couple of frames
 * (it may reappear), but it is not reported: its last position is one or
 * two frames old, and drawing it over the current radar picture would put
 * a marker where there is no longer a storm.
 *
 * `projected` is where the cell's own motion puts it `projectMinutes` from
 * its last observation. That is a straight-line extrapolation of estimated
 * displacement — it assumes the storm keeps moving as it has been, and it
 * cannot know about growth, decay or turning. Presented as a projection,
 * never as a forecast. `projectedRadiusKm` is the radius around that point
 * inside which the cell's centre should fall about two times in three IF
 * it holds its course to within the usual drift (ACCEL_SIGMA_KMH_PER_10MIN)
 * — it is wide for a young track and narrows as frames accumulate.
 *
 * The scale is taken AT EACH CELL when `kmPerPixel` is a function: over a
 * UK-wide scan one Mercator pixel is 13% longer on the ground at 50°N, and
 * 15% shorter at 61°N, than at the middle of the view, and a single scale
 * for the whole grid mis-states every speed by that much.
 *
 * @param {StormTrack[]} tracks
 * @param {number | ((x:number, y:number) => number)} kmPerPixel
 * @param {number} [projectMinutes]
 */
export function summarizeCellTracks(tracks, kmPerPixel, projectMinutes = 30) {
  return tracks
    .filter((t) => t.active && t.points.length > 0 && t.missedFrames === 0)
    .map((t) => {
      const last = t.points[t.points.length - 1];
      const kmpp = scaleAt(kmPerPixel, last.x, last.y) ?? TRACK_TUNING.ASSUMED_KM_PER_PX;
      const motion = motionOf(t, kmpp);
      let projected = null;
      let projectedRadiusKm = null;
      if (motion.speedKmh != null) {
        const k = t.kf;
        // Start from the FILTERED position (the observed one carries this
        // frame's position noise) and hold the GROUND speed constant: a
        // storm heading north covers more pixels per km as it goes, so the
        // pixel step is rescaled by the scale half-way along.
        const midScale = scaleAt(kmPerPixel, k.x + (t.vx * projectMinutes) / 2, k.y + (t.vy * projectMinutes) / 2) ?? kmpp;
        const stretch = kmpp / midScale;
        projected = { x: k.x + t.vx * stretch * projectMinutes, y: k.y + t.vy * stretch * projectMinutes };
        const q = (TRACK_TUNING.ACCEL_SIGMA_KMH_PER_10MIN / 60 / kmpp) ** 2 / 10;
        const T = projectMinutes;
        const axisVar = (k.a + 2 * k.b * T + k.c * T * T) * missInflation(k) + (q * T * T * T) / 3;
        // 1.515 sigma holds two-thirds of a round two-dimensional spread.
        projectedRadiusKm = 1.515 * Math.sqrt(Math.max(0, axisVar)) * kmpp;
      }
      return {
        id: t.id,
        x: last.x,
        y: last.y,
        maxDbz: last.maxDbz,
        patch: last.patch ?? null,
        headingDeg: motion.headingDeg,
        speedKmh: motion.speedKmh,
        projected,
        projectMinutes,
        framesTracked: t.points.length,
        /** Full position history, for drawing the track behind the cell. */
        path: t.points.map((p) => ({ x: p.x, y: p.y, time: p.time, maxDbz: p.maxDbz })),
        /** Size of the cell (pixels at 34+ dBZ) in the newest frame, in km². */
        areaKm2: last.areaPx > 0 ? last.areaPx * kmpp * kmpp : null,
        // --- Added: how far to trust the motion (see motionOf) ---
        speedSigmaKmh: motion.speedSigmaKmh,
        headingSigmaDeg: motion.headingSigmaDeg,
        motionConfidence: motion.motionConfidence,
        headingReliable: motion.headingReliable,
        projectedRadiusKm,
        /** Minutes between the first and the latest observation. */
        trackedMinutes: (last.time - t.points[0].time) / 60000,
        /** Id of the track this cell appeared beside — a probable split. */
        splitFromId: t.splitFrom ?? null,
        /**
         * The strongest pixel in the newest frame, when known. x/y above are
         * the reflectivity-weighted centre, which is what is tracked; on
         * real cells the two sit a median of ~4 km apart.
         */
        peak: typeof last.peakX === "number" ? { x: last.peakX, y: last.peakY } : null,
        /**
         * True when the cell is cut by the edge of the scanned grid in the
         * newest frame: x/y is the centre of the part in view, and the
         * motion (if any) rests on earlier frames or on the cells around it.
         */
        edgeClipped: last.edgeClipped === true,
      };
    })
    // Strongest first, so the list a forecaster scans is ordered by what
    // most warrants attention.
    .sort((a, b) => b.maxDbz - a.maxDbz);
}

/**
 * Derive a UI-ready summary for each currently-active track: heading/speed
 * in real-world units (needs km per pixel at the scan zoom, since the
 * tracker works in tile pixels), persistence flag, and handoff chain.
 *
 * Unchanged from before, and worth knowing: a track that went unmatched in
 * the newest frame but has not yet aged out (MAX_MISSED_FRAMES) is still
 * summarised, at its LAST SEEN position and tier. summarizeCellTracks drops
 * such tracks; this one does not, because the rotation overlay's behaviour
 * is validated separately and was left alone.
 *
 * @param {StormTrack[]} tracks
 * @param {number | ((x:number, y:number) => number)} kmPerPixel   ~0.72 at
 *   z7 at 54°N, ~1.44 at z6, ~2.9 at z5 (1.22 at z7 only on the equator)
 * @returns {Array<{id:string, x:number, y:number, tier:string, score:number, maxDbz:number,
 *   headingDeg:number|null, speedKmh:number|null, persistent:boolean,
 *   framesTracked:number, cyclicHandoff:boolean, handoffFromId:string|null,
 *   speedSigmaKmh:number|null, headingSigmaDeg:number|null,
 *   motionConfidence:"none"|"low"|"medium"|"high", headingReliable:boolean}>}
 */
export function summarizeTracks(tracks, kmPerPixel) {
  return tracks
    .filter((t) => t.active && t.points[t.points.length - 1].tier != null)
    .map((t) => {
      const last = t.points[t.points.length - 1];
      const kmpp = scaleAt(kmPerPixel, last.x, last.y) ?? TRACK_TUNING.ASSUMED_KM_PER_PX;
      const motion = motionOf(t, kmpp);
      return {
        id: t.id,
        x: last.x,
        y: last.y,
        tier: last.tier,
        score: last.score,
        maxDbz: last.maxDbz,
        headingDeg: motion.headingDeg,
        speedKmh: motion.speedKmh,
        persistent: t.persistent,
        framesTracked: t.points.length,
        cyclicHandoff: t.handoffFrom != null,
        handoffFromId: t.handoffFrom,
        speedSigmaKmh: motion.speedSigmaKmh,
        headingSigmaDeg: motion.headingSigmaDeg,
        motionConfidence: motion.motionConfidence,
        headingReliable: motion.headingReliable,
      };
    });
}
