// Scans a map viewport across several radar frames and returns every storm
// cell it can follow, in map coordinates, ready to draw and click.
//
// This is the bridge between the analysis modules and the map UI:
//
//   rotationDetect.js  finds cells in ONE frame of reflectivity
//   stormTracker.js    links cells BETWEEN frames and derives motion
//   this file          fetches the frames, runs both, converts to lon/lat
//
// WHY THE GRID IS COMPUTED ONCE
//
// Every frame is decoded on the same tile grid. If the window moved between
// frames, a stationary storm would appear to shift, and the tracker would
// report that as motion — a completely fabricated velocity. Computing the
// grid once and reusing it is what makes the reported speeds mean anything.
//
// HONESTY NOTE, inherited from rotationDetect.js and stormTracker.js: a
// "cell" is a contiguous blob of reflectivity at or above 34 dBZ. Speed and
// heading are ESTIMATED from how that blob's reflectivity-weighted centre
// displaced between frames 5–10 minutes apart — the motion of the echo, not
// a measured wind and not Doppler. Each cell therefore carries how
// uncertain its speed and direction still are (speedSigmaKmh,
// headingSigmaDeg, motionConfidence): a cell seen in two frames has a
// number, but not one worth drawing an arrow on. The projection is a
// straight-line extrapolation that assumes the storm keeps doing what it
// has been doing — it knows nothing about growth, decay or turning, and
// must never be shown as a forecast.

import {
  viewportTileGrid,
  fetchDbzGrid,
  gridPixelToLonLat,
  kmPerPixelAt,
} from "./rotationDetect.js";
import { trackCellSequence, summarizeCellTracks } from "./stormTracker.js";

/** How many past frames to use. More frames = steadier motion, older start. */
export const SCAN_FRAME_COUNT = 5;

/**
 * @typedef {Object} TrackedCell
 * @property {string} id               stays the same from one scan to the next
 *   for as long as the cell is followed (see rememberIdentities)
 * @property {number} lon              current position: the cell's reflectivity-weighted
 *   centre. (Until this was changed it was the single strongest pixel, which
 *   hops about too much between frames to measure motion from.)
 * @property {number} lat
 * @property {number} maxDbz           peak reflectivity, dBZ
 * @property {number|null} headingDeg  estimated direction of travel, 0 = due north
 * @property {number|null} speedKmh    estimated speed over the ground
 * @property {number} framesTracked
 * @property {Array<{lon:number, lat:number, time:number, maxDbz:number}>} path  where it has been (observed, unsmoothed), and its peak then
 * @property {number|null} areaKm2          size at 34+ dBZ in the newest picture
 * @property {{lon:number, lat:number}|null} projected            straight-line extrapolation
 * @property {number} projectMinutes
 * @property {number|null} speedSigmaKmh    one-sigma uncertainty of speedKmh
 * @property {number|null} headingSigmaDeg  one-sigma uncertainty of headingDeg; 45+ means "direction not known"
 * @property {"none"|"low"|"medium"|"high"} motionConfidence  "low" = too early to say
 * @property {boolean} headingReliable      true when the direction is good to about 25°
 * @property {number|null} projectedRadiusKm  radius round `projected` that should
 *   hold the cell about two times in three IF it keeps a steady course
 * @property {number} trackedMinutes        minutes between first and latest observation
 * @property {string|null} splitFromId      id of the cell this one appeared beside (a probable split)
 * @property {number|null} peakLon          where the single strongest pixel is. lon/lat above are
 * @property {number|null} peakLat            the weighted centre (what is tracked); on real cells
 *   the two are a median of ~4 km apart, more on large blobs
 * @property {string} name                 "Cell 526", or "Cell 526B" for a second cell of the
 *   same storm: one split from it, one in the same patch of rain, or one right beside it
 * @property {"own"|"nearby"|"early"|null} trackSource  where the onward line comes from:
 *   "own" its own established motion; "nearby" too new to have one, so the
 *   motion of established storms around it (storms near each other mostly
 *   ride the same winds); "early" its own motion from only two pictures
 * @property {{lon:number, lat:number}|null} onward  end of the onward line for any
 *   trackSource (projected stays the tracker's own, set only when established)
 * @property {number|null} onwardRadiusKm
 * @property {boolean} edgeClipped          true when the cell is cut by the edge of the
 *   scanned area in the newest frame (the area is whole map tiles, usually a
 *   little larger than the view). lon/lat is then the centre of the part that
 *   was scanned, and the storm's motion cannot be measured from it — expect
 *   motionConfidence "low" unless the cell was wholly in the area earlier
 */

/**
 * Remembers where each reported cell was at each frame time, so that the
 * NEXT scan can give the same storm the same id.
 *
 * Every scan runs the tracker from scratch over the last few frames, and
 * the tracker numbers its tracks as it creates them — so without this, a
 * storm was "t12" in one scan and "t57" in the next, and anything keyed on
 * the id (the selected cell in the radar panel) was dropped every time a
 * new frame arrived. Two scans overlap in all but one frame; a cell that
 * was within IDENTITY_MATCH_KM of a remembered cell at the same frame time
 * is that cell.
 *
 * Kept per page load, in memory only, and capped.
 */
const IDENTITY_MATCH_KM = 6;
const IDENTITY_KEEP_MS = 2 * 60 * 60 * 1000;
const IDENTITY_MAX = 400;
/** @type {Array<{id:string, points: Map<number, {lon:number, lat:number}>, newest:number}>} */
let identities = [];

function approxKm(aLon, aLat, bLon, bLat) {
  const kx = 111.32 * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
  return Math.hypot((aLon - bLon) * kx, (aLat - bLat) * 110.57);
}

/** Maps this scan's ids onto remembered ones where the storm is the same, and remembers the result. */
function rememberIdentities(cells) {
  const claimed = new Set();
  const renamed = new Map();
  for (const cell of cells) {
    let best = null;
    let bestKm = IDENTITY_MATCH_KM;
    // Newest shared frame first: that is where the two scans agree best.
    for (let i = cell.path.length - 1; i >= 0 && !best; i--) {
      const p = cell.path[i];
      for (const known of identities) {
        if (claimed.has(known.id)) continue;
        const q = known.points.get(p.time);
        if (!q) continue;
        const km = approxKm(p.lon, p.lat, q.lon, q.lat);
        if (km <= bestKm) {
          bestKm = km;
          best = known;
        }
      }
    }
    // A new storm: an id from where and when it was first seen, never one in use.
    let id = best ? best.id : `c${numberFor({ path: [{ time: cell.path[0]?.time, lon: cell.lon, lat: cell.lat }] })}${Math.round((cell.path[0]?.time ?? 0) / 60000) % 10000}`;
    if (!best) { const base = id; for (let k = 2; claimed.has(id) || identities.some((x) => x.id === id); k++) id = `${base}-${k}`; }
    claimed.add(id);
    renamed.set(cell.id, id);
  }
  let newest = 0;
  for (const cell of cells) {
    const id = renamed.get(cell.id);
    const points = new Map(cell.path.map((p) => [p.time, { lon: p.lon, lat: p.lat }]));
    const at = cell.path.length ? cell.path[cell.path.length - 1].time : 0;
    newest = Math.max(newest, at);
    identities = identities.filter((k) => k.id !== id);
    identities.push({ id, points, newest: at });
  }
  identities = identities.filter((k) => newest - k.newest <= IDENTITY_KEEP_MS).slice(-IDENTITY_MAX);
  return renamed;
}

/**
 * Names. Every storm gets a number the first time it is seen, kept while it
 * is followed. A cell that belongs with one already named — split from it,
 * part of the same patch of rain within NAME_PATCH_KM, or within NAME_GROUP_KM
 * of it — takes that number and the next letter: Cell 526, 526B, 526C. A
 * family stops at F, so a long rain band is several storms, not 526Z.
 * Per page load, like the ids.
 */
const NAME_GROUP_KM = 15;
const NAME_PATCH_KM = 40;
const NAME_LAST_LETTER = "F";
const names = new Map();
// A new storm's number comes from where and when it was first seen (no randomness),
// so the radar job gives the same storm the same name on every run.
function numberFor(cell) {
  const p = cell.path[0] ?? cell;
  const key = `${p.time ?? 0}:${Math.round(p.lon * 100)}:${Math.round(p.lat * 100)}`;
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return 100 + ((h >>> 0) % 900);
}

function nameCells(cells) {
  const numberOf = (n) => n.match(/\d+/)[0];
  for (const cell of cells) {
    if (names.has(cell.id)) continue;
    const km = (c) => approxKm(c.lon, c.lat, cell.lon, cell.lat);
    const kin = (c) =>
      names.has(c.id) &&
      (c.id === cell.splitFromId ||
        (cell.patch != null && c.patch === cell.patch && km(c) <= NAME_PATCH_KM) ||
        km(c) <= NAME_GROUP_KM);
    let named = null;
    for (const family of cells.filter((c) => c !== cell && kin(c)).sort((a, b) => km(a) - km(b))) {
      const num = numberOf(names.get(family.id));
      const taken = new Set([...names.values()].filter((n) => numberOf(n) === num).map((n) => n.slice(-1)));
      let letter = "B";
      while (taken.has(letter) && letter <= NAME_LAST_LETTER) letter = String.fromCharCode(letter.charCodeAt(0) + 1);
      if (letter <= NAME_LAST_LETTER) { named = `Cell ${num}${letter}`; break; }
    }
    if (!named) {
      const used = new Set([...names.values()].map(numberOf));
      let n = numberFor(cell);
      for (let k = 0; k < 900 && used.has(String(n)); k++) n = n >= 999 ? 100 : n + 1;
      named = `Cell ${n}`;
    }
    names.set(cell.id, named);
  }
  for (const cell of cells) cell.name = names.get(cell.id);
}

/**
 * An onward line for every cell, not only those whose own motion is
 * established. A new cell (one or two pictures) borrows the motion of the
 * established storms within EARLY_NEIGHBOUR_KM, weighted by closeness —
 * storms near each other mostly travel with the same winds; failing that,
 * a two-picture cell uses its own early motion. Marked so the map can draw
 * these fainter and the panel can say what they are.
 */
const EARLY_NEIGHBOUR_KM = 150;

function onwardLines(cells) {
  const settled = cells.filter((c) => c.speedKmh != null && c.headingDeg != null &&
    (c.motionConfidence === "medium" || c.motionConfidence === "high"));
  const step = (c, speed, heading, minutes) => {
    const km = (speed * minutes) / 60, a = (heading * Math.PI) / 180;
    return {
      lon: c.lon + (km * Math.sin(a)) / (111.32 * Math.cos((c.lat * Math.PI) / 180)),
      lat: c.lat + (km * Math.cos(a)) / 110.57,
    };
  };
  for (const c of cells) {
    c.trackSource = null; c.onward = null; c.onwardRadiusKm = null;
    if (settled.includes(c)) {
      c.trackSource = "own"; c.onward = c.projected; c.onwardRadiusKm = c.projectedRadiusKm;
      continue;
    }
    let wx = 0, wy = 0, wsum = 0, n = 0;
    for (const o of settled) {
      const d = approxKm(c.lon, c.lat, o.lon, o.lat);
      if (d > EARLY_NEIGHBOUR_KM) continue;
      const w = 1 / (10 + d), a = (o.headingDeg * Math.PI) / 180;
      wx += w * o.speedKmh * Math.sin(a); wy += w * o.speedKmh * Math.cos(a); wsum += w; n++;
    }
    if (n > 0) {
      const vx = wx / wsum, vy = wy / wsum;
      const speed = Math.hypot(vx, vy), heading = ((Math.atan2(vx, vy) * 180) / Math.PI + 360) % 360;
      c.trackSource = "nearby";
      c.onward = step(c, speed, heading, c.projectMinutes);
      // Wider than an established cell's ring: it is someone else's motion.
      c.onwardRadiusKm = Math.max(8, speed * (c.projectMinutes / 60) * 0.35);
    } else if (c.speedKmh != null && c.headingDeg != null && !c.edgeClipped) {
      c.trackSource = "early";
      c.onward = step(c, c.speedKmh, c.headingDeg, c.projectMinutes);
      c.onwardRadiusKm = Math.max(10, (c.speedSigmaKmh ?? 15) * (c.projectMinutes / 60) * 1.5);
    }
  }
}

/** Compass point for a heading, for captions that read like a forecast. */
export function compassFromHeading(deg) {
  if (deg == null) return null;
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return points[Math.round(deg / 22.5) % 16];
}

/**
 * Plain-English intensity band for a peak reflectivity, so a caption can say
 * what 52 dBZ means without the reader needing the unit.
 *
 * Bands follow conventional radar practice: below 35 is light-moderate rain,
 * 35-45 heavy, 45-55 very heavy and often thundery, above 55 usually
 * indicates hail somewhere in the column. Stated here once so every caption
 * that cites intensity uses the same words for the same numbers.
 */
export function intensityLabel(maxDbz) {
  if (maxDbz >= 55) return "Intense — hail possible";
  if (maxDbz >= 45) return "Very heavy, possibly thundery";
  if (maxDbz >= 35) return "Heavy";
  return "Moderate";
}

/**
 * Scans the given viewport across recent frames and returns tracked cells.
 *
 * @param {Array<{time:number, scanBase:string}>} frames  oldest first; `scanBase`
 *   is the host+path base for the raw (unsmoothed) radar tiles of that frame.
 * @param {{west:number, south:number, east:number, north:number}} bounds
 * @param {number} viewZoom
 * @param {number} [projectMinutes]
 * @returns {Promise<TrackedCell[]>}
 */
export async function scanViewportForCells(frames, bounds, viewZoom, projectMinutes = 30) {
  // Oldest first, one frame per timestamp: a frame listed twice would be
  // fetched twice and adds nothing (the tracker ignores it anyway).
  const byTime = new Map();
  for (const f of frames) if (f.scanBase && Number.isFinite(f.time)) byTime.set(f.time, f);
  const usable = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (usable.length < 2) return []; // motion needs at least two frames

  const grid = viewportTileGrid(bounds, viewZoom);
  if (!grid) return [];

  const recent = usable.slice(-SCAN_FRAME_COUNT);
  const decoded = [];
  for (const frame of recent) {
    // Sequential rather than parallel: each frame is a grid of tile fetches
    // already, and firing every frame's tiles at once would burst dozens of
    // simultaneous requests at the tile server.
    const dbz = await fetchDbzGrid(frame.scanBase, "", grid);
    if (dbz) {
      decoded.push({
        // Frame times arrive in epoch SECONDS from the radar API; the
        // tracker works in milliseconds to derive px/min.
        time: frame.time * 1000,
        dbz,
        width: grid.width,
        height: grid.height,
      });
    }
  }
  if (decoded.length < 2) return [];
  return cellsFromGrids(decoded, grid, projectMinutes);
}

/**
 * Seeds the id and name memory from an earlier result (the radar job reads its
 * last cells file), so a storm keeps its id and name from one run to the next.
 */
export function rememberCells(cells) {
  identities = [];
  names.clear();
  for (const c of cells ?? []) {
    if (!c?.id || !Array.isArray(c.path)) continue;
    const points = new Map(c.path.map((p) => [p.time, { lon: p.lon, lat: p.lat }]));
    identities.push({ id: c.id, points, newest: c.path.length ? c.path[c.path.length - 1].time : 0 });
    if (c.name) names.set(c.id, c.name);
  }
}

/**
 * Tracks cells over frames already decoded on one grid (oldest first,
 * time in ms). Used by the browser scan above and by the radar job.
 */
export function cellsFromGrids(decoded, grid, projectMinutes = 30) {

  // Scale is computed AT EACH CELL, not once for the view. A Web-Mercator
  // pixel covers less ground the further north it is: across a UK-wide scan
  // (50°N to 61°N) the scale at the two edges differs from the middle by
  // +13% and −15%, and a single mid-view figure mis-stated every speed by
  // up to that much.
  const kmPerPx = (x, y) => kmPerPixelAt(grid, gridPixelToLonLat(grid, x, y).lat);
  // The scale MUST be passed to the tracker, not just used afterwards for
  // reporting speeds. Its matching gate is a distance, and without a scale
  // it falls back to a pixel constant tuned for zoom 7 — which at the zoom
  // this scan actually runs at can be four times too generous, linking
  // unrelated storms into one bogus track. See TRACK_TUNING.MAX_SPEED_KMH.
  const tracks = trackCellSequence(decoded, undefined, undefined, kmPerPx);
  const summary = summarizeCellTracks(tracks, kmPerPx, projectMinutes);

  const cells = summary.map((s) => {
    const here = gridPixelToLonLat(grid, s.x, s.y);
    return {
      id: s.id,
      lon: here.lon,
      lat: here.lat,
      maxDbz: s.maxDbz,
      headingDeg: s.headingDeg,
      speedKmh: s.speedKmh,
      framesTracked: s.framesTracked,
      path: s.path.map((p) => {
        const ll = gridPixelToLonLat(grid, p.x, p.y);
        return { lon: ll.lon, lat: ll.lat, time: p.time, maxDbz: p.maxDbz };
      }),
      projected: s.projected ? gridPixelToLonLat(grid, s.projected.x, s.projected.y) : null,
      projectMinutes: s.projectMinutes,
      speedSigmaKmh: s.speedSigmaKmh,
      headingSigmaDeg: s.headingSigmaDeg,
      motionConfidence: s.motionConfidence,
      headingReliable: s.headingReliable,
      projectedRadiusKm: s.projectedRadiusKm,
      trackedMinutes: s.trackedMinutes,
      splitFromId: s.splitFromId,
      peakLon: s.peak ? gridPixelToLonLat(grid, s.peak.x, s.peak.y).lon : null,
      peakLat: s.peak ? gridPixelToLonLat(grid, s.peak.x, s.peak.y).lat : null,
      edgeClipped: s.edgeClipped,
      areaKm2: s.areaKm2,
      patch: s.patch,
    };
  });

  // Same storm, same id as last time (see rememberIdentities).
  const renamed = rememberIdentities(cells);
  for (const cell of cells) {
    cell.id = renamed.get(cell.id);
    if (cell.splitFromId != null) cell.splitFromId = renamed.get(cell.splitFromId) ?? null;
  }
  nameCells(cells);
  onwardLines(cells);
  for (const cell of cells) delete cell.patch;
  return cells;
}
