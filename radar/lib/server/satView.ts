// ONE stitched satellite picture per frame, for exactly the area on screen.
//
// WHY: the old way built the picture from hundreds of small map tiles per
// loop (a 2 h loop over the UK = 390 tiles, 11 s). Here the browser asks for
// ONE image per frame covering the view (plus a margin), and this server
// makes it: each satellite's picture of that area is fetched in one go —
//   Meteosat-12 (MTG):  one EUMETSAT WMS image for the whole area
//   GOES-East/West, Himawari: full-detail CIRA/NOAA SLIDER (1 km), reprojected
//     here; for scans older than SLIDER keeps (~16 h), NASA GIBS tiles stitched
//     here, each missing tile filled from the nearest scan within ±60 min
// — and blended into one picture.
//
// HOW THE SATELLITES ARE JOINED
//   Each spot is drawn from the satellite looking most directly down on it,
//   cross-faded over a narrow ±3° band at the half-way line (a wide blend
//   overlays two views of the same cloud from different angles — a ghosted,
//   blurred storm). Where that satellite has NO picture for a spot (edge of
//   its view, a missing tile, an outage), the neighbouring satellite that
//   also sees the spot fills it in: the overlap is used to fill, not to
//   draw a line.

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { GEOM, matchStamp, scanAngles, sliderTile, type HdSat } from "./sliderHD";
import { cacheLimit } from "./localBoost";

// (Meteosat via CIRA is not a satellite of its own here: it stands in for "mtg".)
export type ViewSat = "mtg" | Exclude<HdSat, "meteosat">;
export const VIEW_SATS: ViewSat[] = ["mtg", "goes-east", "goes-west", "himawari"];

const R = 6378137;
const PI_R = Math.PI * R;
const DEG = 180 / Math.PI;

/** Longitude each satellite looks straight down on. */
const SUBLON: Record<ViewSat, number> = { mtg: 0, "goes-east": -75.2, "goes-west": -137.2, himawari: 140.7 };
const LON0: Record<ViewSat, number> = { mtg: 0, "goes-east": GEOM["goes-east"].lon0, "goes-west": GEOM["goes-west"].lon0, himawari: GEOM.himawari.lon0 };

const GIBS: Record<HdSat, { layer: string; matrix: string; maxz: number }> = {
  "goes-east": { layer: "GOES-East_ABI_GeoColor", matrix: "GoogleMapsCompatible_Level7", maxz: 7 },
  "goes-west": { layer: "GOES-West_ABI_GeoColor", matrix: "GoogleMapsCompatible_Level7", maxz: 7 },
  himawari: { layer: "Himawari_AHI_Band3_Red_Visible_1km", matrix: "GoogleMapsCompatible_Level7", maxz: 7 },
  meteosat: { layer: "", matrix: "", maxz: 0 }, // never asked of GIBS (see hdLayer)
};

export interface ViewReq {
  /** Web-Mercator metres: west, south, east, north */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  w: number;
  h: number;
  /** scan time (ISO) used for each satellite in this frame */
  parts: Partial<Record<ViewSat, string>>;
}

type Layer = Uint8ClampedArray | null; // RGBA w*h; alpha 0 = no picture
/** Only these output columns are needed from a satellite (its own side of the hand-over line). */
type Cols = [number, number];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const colLon = (q: ViewReq, px: number) => ((q.x0 + ((px + 0.5) * (q.x1 - q.x0)) / q.w) / R) * DEG;
const rowLat = (q: ViewReq, py: number) => {
  const y = q.y1 - ((py + 0.5) * (q.y1 - q.y0)) / q.h;
  return (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * DEG;
};

function limiter(max: number) {
  let active = 0;
  const q: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => q.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      q.shift()?.();
    }
  };
}
const eumetsat = limiter(4); // EUMETSAT's map server refuses bursts
// Each source (EUMETSAT, NASA GIBS, …) has its own breaker: after it fails (errors or
// time-outs, not "no picture here"), it is skipped for 2 minutes, so one source having
// a bad spell never holds up the others. EUMETSAT, one big picture per frame, trips on
// its first failure; GIBS, many small tiles, on its third in a row.
const sourceDown = new Map<string, { fails: number; until: number }>();
const TRIP_AFTER: Record<string, number> = { "view.eumetsat.int": 1 };
const isDown = (host: string) => (sourceDown.get(host)?.until ?? 0) > Date.now();
function noteResult(host: string, ok: boolean) {
  const st = sourceDown.get(host) ?? { fails: 0, until: 0 };
  if (ok) st.fails = 0;
  else if (++st.fails >= (TRIP_AFTER[host] ?? 3)) {
    st.until = Date.now() + 120_000;
    st.fails = 0;
  }
  sourceDown.set(host, st);
}
/** EUMETSAT is being skipped right now (pictures drawn meanwhile lack Meteosat). */
export const eumetsatSkipped = () => isDown("view.eumetsat.int");
const gibs = limiter(24);

async function fetchImage(url: string, tries = 2): Promise<Awaited<ReturnType<typeof loadImage>> | null> {
  const host = new URL(url).host;
  if (isDown(host)) return null;
  const img = await fetchImageTries(url, tries);
  noteResult(host, img !== undefined);
  return img ?? null;
}

/** undefined = the source failed (error / time-out); null = it answered "no picture". */
async function fetchImageTries(url: string, tries: number): Promise<Awaited<ReturnType<typeof loadImage>> | null | undefined> {
  for (let a = 0; a < tries; a++) {
    try {
      // A time limit: EUMETSAT's server sometimes takes 25 s and then fails, and with
      // no limit (and three tries) one slow satellite held the whole picture past 90 s.
      // Now it gives up after 12 s and the picture goes out with the other satellites.
      const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (r.ok) {
        const b = Buffer.from(await r.arrayBuffer());
        if (b.length < 100) return null;
        return await loadImage(b);
      }
      if (r.status < 500) return null;
    } catch {
      /* retry */
    }
    await new Promise((res) => setTimeout(res, 300 * (a + 1)));
  }
  return undefined; // every try failed: the source is having a bad spell
}

/** Visibility mask from the viewing geometry on a coarse grid (1 = the satellite sees this pixel). */
function visibleMask(q: ViewReq, sat: ViewSat): Uint8Array {
  const G = 8;
  const nx = Math.floor((q.w - 1) / G) + 2;
  const ny = Math.floor((q.h - 1) / G) + 2;
  const node = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const lat = rowLat(q, Math.min(q.h - 1, j * G));
    for (let i = 0; i < nx; i++) node[j * nx + i] = scanAngles(colLon(q, Math.min(q.w - 1, i * G)), lat, LON0[sat]) ? 1 : 0;
  }
  const m = new Uint8Array(q.w * q.h);
  for (let py = 0; py < q.h; py++) {
    const j = Math.round(py / G);
    for (let px = 0; px < q.w; px++) m[py * q.w + px] = node[j * nx + Math.round(px / G)];
  }
  return m;
}

// ---------------------------------------------------------------------------
// Meteosat-12: one WMS image for the whole area
// ---------------------------------------------------------------------------

async function mtgLayer(q: ViewReq, iso: string, cols: Cols): Promise<Layer> {
  const pxX = (q.x1 - q.x0) / q.w;
  // Only the columns MTG is needed for, clamped to the world's width (views
  // over the date line reach past it; MTG can't see there anyway).
  const cx0 = Math.max(q.x0 + cols[0] * pxX, -PI_R);
  const cx1 = Math.min(q.x0 + (cols[1] + 1) * pxX, PI_R);
  if (cx1 <= cx0) return null;
  const c0 = Math.round((cx0 - q.x0) / pxX);
  const c1 = Math.round((cx1 - q.x0) / pxX);
  const width = c1 - c0;
  if (width < 2) return null;
  const p = new URLSearchParams({
    service: "WMS",
    version: "1.3.0",
    request: "GetMap",
    layers: "mtg_fd:rgb_geocolour",
    styles: "",
    format: "image/jpeg",
    crs: "EPSG:3857",
    width: String(width),
    height: String(q.h),
    time: iso,
    bbox: `${cx0},${q.y0},${cx1},${q.y1}`,
  });
  const img = await eumetsat(() => fetchImage(`https://view.eumetsat.int/geoserver/wms?${p.toString()}`));
  if (!img) return null;
  const c = createCanvas(q.w, q.h);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, c0, 0, width, q.h);
  const d = ctx.getImageData(0, 0, q.w, q.h).data;
  // JPEG has no transparency: take "can MTG see this spot" from the geometry,
  // and treat pure black (EUMETSAT's no-data) as no picture.
  const vis = visibleMask(q, "mtg");
  for (let i = 0, k = 0; k < vis.length; i += 4, k++) {
    if (!vis[k] || (d[i] < 3 && d[i + 1] < 3 && d[i + 2] < 3)) d[i + 3] = 0;
  }
  return d;
}

// ---------------------------------------------------------------------------
// GOES / Himawari at full detail (SLIDER), reprojected for the area
// ---------------------------------------------------------------------------

interface ViewProj {
  zs: number;
  n: number;
  gx: Float32Array;
  gy: Float32Array;
  r0: number;
  c0: number;
  gw: number;
  gh: number;
}
const g = globalThis as unknown as { __viewProj?: Map<string, ViewProj>; __viewOut?: Map<string, Buffer> };
const projCache = (g.__viewProj ??= new Map());

/**
 * Satellite-pixel position for every output pixel. Depends only on the area
 * and satellite (not the time), so it is made once per view and reused for
 * every frame. Worked out exactly on an 8-px grid and interpolated between
 * (the mapping is smooth); cells touching the edge of the disc are exact.
 */
function hdProjection(q: ViewReq, sat: HdSat, cols: Cols): ViewProj {
  const geo = GEOM[sat];
  const latC = rowLat(q, q.h / 2);
  const pxKm = (((q.x1 - q.x0) / q.w) * Math.cos((latC * Math.PI) / 180)) / 1000;
  // SLIDER level: satellite pixels no coarser than 1.5 output pixels
  // (18.8 km per pixel at level 0, halving each level; level 4 = ~1.2 km).
  // Finer than that only multiplies the download for no visible gain.
  const zs = Math.max(0, Math.min(geo.maxZ, Math.ceil(Math.log2(18.8 / (pxKm * 1.5)))));
  const key = `${sat}|${zs}|${q.x0}|${q.y0}|${q.x1}|${q.y1}|${q.w}|${q.h}|${cols[0]}|${cols[1]}`;
  const hit = projCache.get(key);
  if (hit) return hit;
  const scale = 2 ** zs;
  const center = geo.tile / 2;
  const n = geo.tile * scale;
  const exact = (lon: number, lat: number): [number, number] | null => {
    const a = scanAngles(lon, lat, geo.lon0);
    if (!a) return null;
    const sx = (center + (a[0] / geo.rx) * geo.Rx) * scale - 0.5;
    const sy = (center - (a[1] / geo.ry) * geo.Ry) * scale - 0.5;
    return sx < 0 || sy < 0 || sx + 1 >= n || sy + 1 >= n ? null : [sx, sy];
  };
  const lons = new Float64Array(q.w);
  for (let px = 0; px < q.w; px++) lons[px] = colLon(q, px);
  const lats = new Float64Array(q.h);
  for (let py = 0; py < q.h; py++) lats[py] = rowLat(q, py);

  const G = 8;
  const nx = Math.floor((q.w - 1) / G) + 2;
  const ny = Math.floor((q.h - 1) / G) + 2;
  const NX = new Float64Array(nx * ny).fill(NaN);
  const NY = new Float64Array(nx * ny).fill(NaN);
  for (let j = 0; j < ny; j++) {
    const py = j * G;
    const lat = py < q.h ? lats[py] : rowLat(q, py);
    for (let i = Math.floor(cols[0] / G); i <= Math.min(nx - 1, Math.floor(cols[1] / G) + 1); i++) {
      const px = i * G;
      const e = exact(px < q.w ? lons[px] : colLon(q, px), lat);
      NX[j * nx + i] = e ? e[0] : NaN;
      NY[j * nx + i] = e ? e[1] : NaN;
    }
  }
  const gx = new Float32Array(q.w * q.h).fill(-1);
  const gy = new Float32Array(q.w * q.h);
  let rMin = Infinity, rMax = -Infinity, cMin = Infinity, cMax = -Infinity;
  const T = geo.tile;
  for (let py = 0; py < q.h; py++) {
    const j = Math.floor(py / G);
    const fy = (py - j * G) / G;
    for (let px = cols[0]; px <= cols[1]; px++) {
      const i = Math.floor(px / G);
      const fx = (px - i * G) / G;
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      let sx: number, sy: number;
      if (NX[a] === NX[a] && NX[b] === NX[b] && NX[c] === NX[c] && NX[d] === NX[d]) {
        sx = (NX[a] * (1 - fx) + NX[b] * fx) * (1 - fy) + (NX[c] * (1 - fx) + NX[d] * fx) * fy;
        sy = (NY[a] * (1 - fx) + NY[b] * fx) * (1 - fy) + (NY[c] * (1 - fx) + NY[d] * fx) * fy;
      } else {
        const e = exact(lons[px], lats[py]);
        if (!e) {
          gx[py * q.w + px] = -1;
          continue;
        }
        [sx, sy] = e;
      }
      const k = py * q.w + px;
      gx[k] = sx;
      gy[k] = sy;
      const cc0 = (sx / T) | 0, cc1 = ((sx + 1) / T) | 0, rr0 = (sy / T) | 0, rr1 = ((sy + 1) / T) | 0;
      if (cc0 < cMin) cMin = cc0;
      if (cc1 > cMax) cMax = cc1;
      if (rr0 < rMin) rMin = rr0;
      if (rr1 > rMax) rMax = rr1;
    }
  }
  const p: ViewProj = {
    zs, n, gx, gy,
    r0: rMin <= rMax ? rMin : 0,
    c0: cMin <= cMax ? cMin : 0,
    gw: cMin <= cMax ? cMax - cMin + 1 : 0,
    gh: rMin <= rMax ? rMax - rMin + 1 : 0,
  };
  projCache.set(key, p);
  while (projCache.size > cacheLimit(8, projCache.size)) projCache.delete(projCache.keys().next().value!);
  return p;
}

async function hdLayer(q: ViewReq, sat: HdSat, iso: string, cols: Cols): Promise<Layer> {
  // Zoomed out, NASA GIBS map tiles (~1.2 km, ~80 KB each) show everything
  // the screen can; the full-detail SLIDER images (~0.8 MB each) only pay off
  // once the view is finer than ~1.3 km per pixel. GOES only: GIBS Himawari is
  // a grey daylight-only channel, so Himawari always comes from SLIDER (colour).
  //
  // Zoomed far out (coarser than ~3 km per pixel) SLIDER is cheap again —
  // its whole disc is a few small images — and it reaches the satellite's
  // real edge of view, where NASA's map service clips GOES short.
  const latC = rowLat(q, q.h / 2);
  const pxKm = (((q.x1 - q.x0) / q.w) * Math.cos((latC * Math.PI) / 180)) / 1000;
  if (sat !== "himawari" && sat !== "meteosat" && pxKm > 1.3 && pxKm < 3.1) return gibsLayer(q, sat, iso, cols);
  // Himawari: NASA's copy is a grey daylight-only channel — black at night —
  // so the nearest full-colour SLIDER scan within 30 min is used rather than
  // falling back to it (SLIDER sometimes lists the newest scan a little late).
  const stamp =
    (await matchStamp(sat, Date.parse(iso), sat === "meteosat" ? 45 : 5)) /* (CIRA lists Meteosat ~30–40 min late: an older Europe beats a blank one) */ ?? (sat === "himawari" ? await matchStamp(sat, Date.parse(iso), 30) : null);
  if (!stamp) return sat === "meteosat" ? null : gibsLayer(q, sat, iso, cols); // older than SLIDER keeps
  const pr = hdProjection(q, sat, cols);
  if (!pr.gw || !pr.gh) return null;
  const grid: (Uint8ClampedArray | null)[] = new Array(pr.gw * pr.gh).fill(null);
  const jobs: Promise<void>[] = [];
  for (let r = 0; r < pr.gh; r++)
    for (let c = 0; c < pr.gw; c++)
      jobs.push(sliderTile(sat, stamp, pr.zs, pr.r0 + r, pr.c0 + c).then((t) => void (grid[r * pr.gw + c] = t)));
  await Promise.all(jobs);
  if (grid.every((t) => !t)) return gibsLayer(q, sat, iso, cols);
  const T = GEOM[sat].tile;
  const out = new Uint8ClampedArray(q.w * q.h * 4);
  const { gx: GX, gy: GY, n, r0: R0, c0: C0, gw: GW } = pr;
  const tileAt = (sx: number, sy: number) => grid[(((sy / T) | 0) - R0) * GW + (((sx / T) | 0) - C0)] ?? null;
  const idx = (sx: number, sy: number) => ((sy % T) * T + (sx % T)) * 4;
  for (let i = 0, N = q.w * q.h; i < N; i++) {
    const fx = GX[i];
    if (fx < 0) continue;
    const fy = GY[i];
    const x0 = fx | 0;
    const y0 = fy | 0;
    if (x0 + 1 >= n || y0 + 1 >= n) continue;
    const tx = fx - x0, ty = fy - y0;
    const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
    const o = i * 4;
    if (x0 % T < T - 1 && y0 % T < T - 1) {
      const t = tileAt(x0, y0);
      if (!t) continue;
      const a = idx(x0, y0), b = a + 4, c = a + T * 4, d = c + 4;
      out[o] = t[a] * w00 + t[b] * w10 + t[c] * w01 + t[d] * w11;
      out[o + 1] = t[a + 1] * w00 + t[b + 1] * w10 + t[c + 1] * w01 + t[d + 1] * w11;
      out[o + 2] = t[a + 2] * w00 + t[b + 2] * w10 + t[c + 2] * w01 + t[d + 2] * w11;
      out[o + 3] = t[a + 3] * w00 + t[b + 3] * w10 + t[c + 3] * w01 + t[d + 3] * w11;
    } else {
      const ta = tileAt(x0, y0), tb = tileAt(x0 + 1, y0), tc = tileAt(x0, y0 + 1), td = tileAt(x0 + 1, y0 + 1);
      if (!ta || !tb || !tc || !td) continue;
      const ia = idx(x0, y0), ib = idx(x0 + 1, y0), ic = idx(x0, y0 + 1), id = idx(x0 + 1, y0 + 1);
      for (let ch = 0; ch < 4; ch++) out[o + ch] = ta[ia + ch] * w00 + tb[ib + ch] * w10 + tc[ic + ch] * w01 + td[id + ch] * w11;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// NASA GIBS (older scans): map tiles stitched here, holes filled ±60 min
// ---------------------------------------------------------------------------

// Downloaded GIBS tiles, kept for re-use when the view moves (256-px each).
const gibsCache: Map<string, Promise<Awaited<ReturnType<typeof loadImage>> | null>> =
  ((g as unknown as { __viewGibs?: Map<string, Promise<Awaited<ReturnType<typeof loadImage>> | null>> }).__viewGibs ??= new Map());
function gibsTile(url: string) {
  let p = gibsCache.get(url);
  if (!p) {
    p = gibs(() => fetchImage(url, 2));
    gibsCache.set(url, p);
    while (gibsCache.size > cacheLimit(1500, gibsCache.size)) gibsCache.delete(gibsCache.keys().next().value!);
  }
  return p;
}

/**
 * One satellite from NASA GIBS for the area: ONE WMS image (JPEG, ~200–350 KB)
 * instead of dozens of map tiles. JPEG cannot say "no data", so:
 *   - outside the satellite's view (from the geometry) → no picture;
 *   - a whole map-tile-sized block that came back pure black is checked
 *     against GIBS's own tile (which does mark missing data); if GIBS has no
 *     tile there for this scan, the nearest scan within ±60 min fills it.
 */
async function gibsLayer(q: ViewReq, sat: HdSat, iso: string, cols: Cols): Promise<Layer> {
  const L = GIBS[sat];
  const pxX = (q.x1 - q.x0) / q.w;
  const pxY = (q.y1 - q.y0) / q.h;
  const cx0 = Math.max(q.x0 + cols[0] * pxX, -PI_R * 1.5);
  const cx1 = q.x0 + (cols[1] + 1) * pxX;
  const c0 = Math.round((cx0 - q.x0) / pxX);
  const width = Math.round((cx1 - cx0) / pxX);
  if (width < 2) return null;
  const p = new URLSearchParams({
    SERVICE: "WMS",
    VERSION: "1.3.0",
    REQUEST: "GetMap",
    LAYERS: L.layer,
    STYLES: "",
    FORMAT: "image/jpeg",
    CRS: "EPSG:3857",
    WIDTH: String(width),
    HEIGHT: String(q.h),
    TIME: iso,
    BBOX: `${cx0},${q.y0},${cx1},${q.y1}`,
  });
  const img = await gibs(() => fetchImage(`https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi?${p.toString()}`));
  const c = createCanvas(q.w, q.h);
  const ctx = c.getContext("2d");
  if (img) ctx.drawImage(img, c0, 0, width, q.h);
  let d = ctx.getImageData(0, 0, q.w, q.h).data;

  // Blocks that are entirely black: possible missing data — check them.
  const z = Math.max(0, Math.min(L.maxz, Math.ceil(Math.log2((2 * PI_R) / (256 * pxX * 1.5)))));
  const n = 2 ** z;
  const tm = (2 * PI_R) / n;
  const tx0 = Math.floor((cx0 + PI_R) / tm);
  const tx1 = Math.floor((cx1 + PI_R - 1) / tm);
  const ty0 = Math.max(0, Math.floor((PI_R - q.y1) / tm));
  const ty1 = Math.min(n - 1, Math.floor((PI_R - q.y0 - 1) / tm));
  const suspect: [number, number][] = [];
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      const px0 = Math.max(c0, Math.floor((tx * tm - PI_R - q.x0) / pxX));
      const px1 = Math.min(c0 + width, Math.ceil(((tx + 1) * tm - PI_R - q.x0) / pxX));
      const py0 = Math.max(0, Math.floor((q.y1 - (PI_R - ty * tm)) / pxY));
      const py1 = Math.min(q.h, Math.ceil((q.y1 - (PI_R - (ty + 1) * tm)) / pxY));
      if (px1 - px0 < 8 || py1 - py0 < 8) continue;
      let lit = 0;
      for (let y = py0; y < py1 && lit < 20; y += 2)
        for (let x = px0; x < px1; x += 2) {
          const i = (y * q.w + x) * 4;
          if (d[i] + d[i + 1] + d[i + 2] > 12 && ++lit >= 20) break;
        }
      if (lit < 20) suspect.push([tx, ty]);
    }
  }
  if (!img || suspect.length) {
    const cells: [number, number][] = img ? suspect.slice(0, 60) : [];
    if (!img) for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) cells.push([tx, ty]);
    const t0 = Date.parse(iso);
    const times = [0, -10, 10, -20, 20, -30, 30, -40, 40, -50, 50, -60, 60]
      .map((m) => t0 + m * 60_000)
      .filter((t) => t <= Date.now())
      .map((t) => new Date(t).toISOString().replace(".000Z", "Z"));
    const unresolved: [number, number][] = [];
    await Promise.all(
      cells.map(async ([tx, ty]) => {
        const wx = ((tx % n) + n) % n;
        for (const t of times) {
          const tile = await gibsTile(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${L.layer}/default/${t}/${L.matrix}/${z}/${ty}/${wx}.png`);
          if (tile) {
            const dx = (tx * tm - PI_R - q.x0) / pxX;
            const dy = (q.y1 - (PI_R - ty * tm)) / pxY;
            ctx.drawImage(tile, dx, dy, tm / pxX, tm / pxY);
            return;
          }
        }
        unresolved.push([tx, ty]);
      })
    );
    d = ctx.getImageData(0, 0, q.w, q.h).data;
    // No scan within an hour has this block: mark it empty so the
    // neighbouring satellite fills it rather than leaving a black square.
    for (const [tx, ty] of unresolved) {
      const px0 = Math.max(0, Math.floor((tx * tm - PI_R - q.x0) / pxX));
      const px1 = Math.min(q.w, Math.ceil(((tx + 1) * tm - PI_R - q.x0) / pxX));
      const py0 = Math.max(0, Math.floor((q.y1 - (PI_R - ty * tm)) / pxY));
      const py1 = Math.min(q.h, Math.ceil((q.y1 - (PI_R - (ty + 1) * tm)) / pxY));
      for (let y = py0; y < py1; y++) for (let x = px0; x < px1; x++) d[(y * q.w + x) * 4 + 3] = 0;
    }
  }
  // Outside the satellite's view: no picture (so a neighbour can fill it).
  const vis = visibleMask(q, sat as ViewSat); // (never "meteosat": that one is not asked of GIBS)
  for (let i = 0, k = 0; k < vis.length; i += 4, k++) if (!vis[k]) d[i + 3] = 0;
  return d;
}

// ---------------------------------------------------------------------------
// Joining the satellites
// ---------------------------------------------------------------------------

/** 1 within 25° of the point a satellite looks down on, easing to 0 by 80° (its view's edge). */
function reach(sat: ViewSat, lon: number): number {
  let d = Math.abs(((lon - SUBLON[sat] + 540) % 360) - 180);
  d = Math.max(0, d - 25);
  if (d >= 55) return 0;
  const x = d / 55;
  return (1 - x * x) ** 2;
}

const BAND = 3;
/** Primary weights: nearest satellite, cross-fade only within ±3° of the half-way line. */
function primary(lon: number, sats: ViewSat[]): number[] {
  const d = sats.map((s) => (reach(s, lon) > 0 ? Math.abs(((lon - SUBLON[s] + 540) % 360) - 180) : Infinity));
  const order = sats.map((_, k) => k).filter((k) => d[k] < Infinity).sort((a, b) => d[a] - d[b]);
  const w = sats.map(() => 0);
  if (!order.length) return w;
  const [a, b] = order;
  if (b === undefined || (d[b] - d[a]) / 2 >= BAND) {
    w[a] = 1;
    return w;
  }
  const s = (d[b] - d[a]) / 2 / BAND;
  w[a] = 0.5 + 0.5 * s * s * (3 - 2 * s);
  w[b] = 1 - w[a];
  return w;
}

/**
 * How far from the point a satellite looks straight down on its picture is
 * worth using. Beyond ~70° (great-circle) the Earth is seen so edge-on that
 * the picture smears into streaks; such spots are faded out between 70° and
 * 80° so a neighbouring satellite fills them, or — near the poles, which no
 * geostationary satellite sees well — the map shows through instead of a
 * smeared or black band.
 */
const LIMB_IN = Math.cos((70 * Math.PI) / 180);
const LIMB_OUT = Math.cos((80 * Math.PI) / 180);
function limbFade(q: ViewReq, sat: ViewSat, L: Uint8ClampedArray) {
  const cosLat = new Float32Array(q.h);
  for (let py = 0; py < q.h; py++) cosLat[py] = Math.cos((rowLat(q, py) * Math.PI) / 180);
  const cosDlon = new Float32Array(q.w);
  for (let px = 0; px < q.w; px++) cosDlon[px] = Math.cos(((colLon(q, px) - SUBLON[sat]) * Math.PI) / 180);
  for (let py = 0; py < q.h; py++) {
    for (let px = 0; px < q.w; px++) {
      const c = cosLat[py] * cosDlon[px];
      if (c >= LIMB_IN) continue;
      const o = (py * q.w + px) * 4 + 3;
      if (c <= LIMB_OUT) L[o] = 0;
      else {
        const t = (c - LIMB_OUT) / (LIMB_IN - LIMB_OUT);
        L[o] = L[o] * t * t * (3 - 2 * t);
      }
    }
  }
}

async function layerFor(q: ViewReq, sat: ViewSat, cols: Cols): Promise<Layer> {
  const iso = q.parts[sat];
  if (!iso) return null;
  try {
    let L = sat === "mtg" ? await mtgLayer(q, iso, cols) : await hdLayer(q, sat, iso, cols);
    // Europe's back-up: EUMETSAT's server failing or skipped → the same Meteosat
    // view (Meteosat-10, every 15 min) from CIRA SLIDER instead.
    if (sat === "mtg" && !L) L = await hdLayer(q, "meteosat", iso, cols);
    if (L) limbFade(q, sat, L);
    return L;
  } catch {
    return null;
  }
}

const outCache = (g.__viewOut ??= new Map());
const inflight = new Map<string, Promise<Buffer>>();

export function viewKey(q: ViewReq) {
  return `v3|${q.x0}|${q.y0}|${q.x1}|${q.y1}|${q.w}|${q.h}|${VIEW_SATS.map((s) => q.parts[s] ?? "-").join(",")}`;
}

export async function renderView(q: ViewReq, timing?: Record<string, number>): Promise<Buffer> {
  const key = viewKey(q);
  const hit = outCache.get(key);
  if (hit) return hit;
  let job = inflight.get(key);
  if (!job) {
    job = make(q, timing).then((b) => {
      // Not kept while EUMETSAT is being skipped: Europe in it may be missing or an
      // older stand-in, and it should be drawn again whole once EUMETSAT answers.
      if (q.parts.mtg && eumetsatSkipped()) return b;
      outCache.set(key, b);
      while (outCache.size > cacheLimit(400, outCache.size)) outCache.delete(outCache.keys().next().value!);
      return b;
    });
    job.finally(() => inflight.delete(key)).catch(() => {});
    inflight.set(key, job);
  }
  return job;
}

async function make(q: ViewReq, timing?: Record<string, number>): Promise<Buffer> {
  const T0 = performance.now();
  const mark = (k: string) => timing && (timing[k] = Math.round(performance.now() - T0));
  const sats = VIEW_SATS.filter((s) => q.parts[s]);
  // Per-column weights (in Web Mercator a column is one longitude).
  const P = sats.map(() => new Float32Array(q.w));
  const B = sats.map(() => new Float32Array(q.w));
  for (let px = 0; px < q.w; px++) {
    const lon = colLon(q, px);
    const w = primary(lon, sats);
    sats.forEach((s, k) => {
      P[k][px] = w[k];
      B[k][px] = reach(s, lon);
    });
  }
  const layers: Layer[] = sats.map(() => null);
  const fetched = sats.map(() => false);
  const need = (k: number, arr: Float32Array[]) => arr[k].some((v) => v > 0);
  /** First..last column where a satellite has weight (its part of the picture). */
  const span = (a: Float32Array): Cols => {
    let lo = -1, hi = -1;
    for (let i = 0; i < a.length; i++) if (a[i] > 0) { if (lo < 0) lo = i; hi = i; }
    return [Math.max(0, lo), Math.max(0, hi)];
  };
  // 1) The satellites that are "primary" somewhere in view.
  await Promise.all(
    sats.map(async (s, k) => {
      if (!need(k, P)) return;
      fetched[k] = true;
      layers[k] = await layerFor(q, s, span(P[k]));
    })
  );
  mark("primary");
  const N = q.w * q.h;
  const out = new Uint8ClampedArray(N * 4);
  let holes = 0;
  const fill = (useBackup: boolean) => {
    holes = 0;
    for (let py = 0; py < q.h; py++) {
      for (let px = 0; px < q.w; px++) {
        const i = py * q.w + px;
        const o = i * 4;
        if (useBackup && out[o + 3] >= 250) continue;
        let Rs = 0, Gs = 0, Bs = 0, W = 0, A = 0;
        for (let k = 0; k < sats.length; k++) {
          const L = layers[k];
          if (!L) continue;
          const a = L[o + 3];
          if (a === 0) continue;
          const w = (useBackup ? B[k][px] : P[k][px]) * a;
          if (w <= 0) continue;
          Rs += L[o] * w;
          Gs += L[o + 1] * w;
          Bs += L[o + 2] * w;
          W += w;
          if (a > A) A = a;
        }
        if (W > 0) {
          out[o] = Rs / W;
          out[o + 1] = Gs / W;
          out[o + 2] = Bs / W;
          // Fully opaque unless every contributor was fading out at its edge of
          // view, so coverage ends in a soft edge onto the map, not a hard line.
          out[o + 3] = Math.max(A, useBackup ? 0 : A);
          if (A < 250) holes++;
        } else holes++;
      }
    }
  };
  fill(false);
  mark("blend");
  // 2) Holes? Bring in the neighbouring satellites that also see the area.
  if (holes > N * 0.002) {
    // Only the columns that have holes, from satellites that can see them.
    const holeCol = new Float32Array(q.w);
    for (let py = 0; py < q.h; py++) for (let px = 0; px < q.w; px++) if (out[(py * q.w + px) * 4 + 3] === 0) holeCol[px] = 1;
    const hs = span(holeCol);
    const extra = sats.map((_, k) => !fetched[k] && B[k].subarray(hs[0], hs[1] + 1).some((v) => v > 0));
    if (extra.some(Boolean)) {
      await Promise.all(
        sats.map(async (s, k) => {
          if (!extra[k]) return;
          fetched[k] = true;
          layers[k] = await layerFor(q, s, hs);
        })
      );
    }
    fill(true);
    mark("filled");
  }
  if (timing) timing.holesPct = Math.round((1000 * holes) / N) / 10;
  const c = createCanvas(q.w, q.h);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(q.w, q.h);
  img.data.set(out);
  ctx.putImageData(img, 0, 0);
  // Fully covered: JPEG (smallest, fastest). Any gap — beyond every
  // satellite's useful view, near the poles — needs transparency so the map
  // shows through instead of black: WebP with alpha.
  const buf = holes > 0 ? c.toBuffer("image/webp", 85) : c.toBuffer("image/jpeg", 85);
  mark("encode");
  return buf;
}
