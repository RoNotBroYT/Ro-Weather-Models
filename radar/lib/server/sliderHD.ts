// HD geostationary satellite tiles, reprojected from CIRA/NOAA SLIDER.
//
// WHY: NASA GIBS (our previous source) serves GOES/Himawari only up to its
// "level 7" pyramid (~1.2 km per pixel at the equator, resampled from
// coarser data), so zooming in on a hurricane just enlarged blur. CIRA's
// SLIDER publishes the same satellites at their FULL detail — GeoColor at
// 1 km (zoom 4 of a 10 848-px full disk) — but in the satellite's own
// fixed-grid view, not a web map. This module turns that into standard
// Web-Mercator map tiles: for every output pixel it works out, with the
// geostationary viewing geometry, which pixel of the satellite image it is,
// reads it (bilinear), and writes it out. Tiles SLIDER uses are cached.
//
// Also colour for Asia: SLIDER has Himawari GeoColor, where GIBS only had a
// grey visible channel.
//
// Imagery: CIRA/RAMMB SLIDER, NOAA GOES-19/18 and JMA Himawari-9 — credited
// on screen.

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { cacheLimit } from "./localBoost";

export type HdSat = "goes-east" | "goes-west" | "himawari" | "meteosat";

export interface SatGeom {
  slider: string; // SLIDER satellite id
  lon0: number;
  tile: number; // SLIDER tile size, px
  maxZ: number; // highest SLIDER zoom for geocolor
  rx: number; // max scan angle x (rad) at the disk edge
  ry: number;
  Rx: number; // disk radius x at zoom 0 (px)
  Ry: number;
}

// From SLIDER's own product definitions (lat_lon_query block).
export const GEOM: Record<HdSat, SatGeom> = {
  "goes-east": { slider: "goes-19", lon0: -75.0, tile: 678, maxZ: 4, rx: 0.151337, ry: 0.150988, Rx: 338, Ry: 337 },
  "goes-west": { slider: "goes-18", lon0: -137.0, tile: 678, maxZ: 4, rx: 0.151337, ry: 0.150988, Rx: 338, Ry: 337 },
  himawari: { slider: "himawari", lon0: 140.69, tile: 688, maxZ: 4, rx: 0.150618, ry: 0.150485, Rx: 337, Ry: 336 },
  // Meteosat-10 at 0° (Europe, Africa): the back-up for EUMETSAT's own map server.
  // 3 km pixels at its finest SLIDER zoom (3), i.e. a 3,712-px disc whose pixels are
  // 83.83 µrad of scan angle; the Earth's edge (same angles as GOES) is then ~1,805 px
  // from the centre at zoom 3, ~226 at zoom 0.
  meteosat: { slider: "meteosat-0deg", lon0: 0.0, tile: 464, maxZ: 3, rx: 0.151337, ry: 0.150988, Rx: 226, Ry: 225 },
};

const BASE = "https://slider.cira.colostate.edu";
const R_EQ = 6378137;
const R_POL = 6356752.31414;
const H = 42171.7e3; // SLIDER's satellite distance from Earth's centre
const E2 = 1 - (R_POL * R_POL) / (R_EQ * R_EQ);
const DEG = Math.PI / 180;

/** Scan angles (x east, y north, radians) for a lon/lat, or null if the satellite cannot see it. */
export function scanAngles(lon: number, lat: number, lon0: number): [number, number] | null {
  const phi = lat * DEG;
  const lam = (((lon - lon0 + 540) % 360) - 180) * DEG;
  const phiC = Math.atan(((R_POL * R_POL) / (R_EQ * R_EQ)) * Math.tan(phi));
  const cosC = Math.cos(phiC);
  const rc = R_POL / Math.sqrt(1 - E2 * cosC * cosC);
  const sx = H - rc * cosC * Math.cos(lam);
  const sy = -rc * cosC * Math.sin(lam);
  const sz = rc * Math.sin(phiC);
  if (H * (H - sx) < sy * sy + ((R_EQ * R_EQ) / (R_POL * R_POL)) * sz * sz) return null; // behind the limb
  const n = Math.sqrt(sx * sx + sy * sy + sz * sz);
  return [Math.asin(-sy / n), Math.atan(sz / sx)];
}

// ---------------------------------------------------------------------------
// SLIDER frame times and tiles (cached)
// ---------------------------------------------------------------------------

const g = globalThis as unknown as {
  __hdTimes?: Map<string, { at: number; list: number[] }>;
  __hdTiles?: Map<string, Promise<Uint8ClampedArray | null>>;
  __hdOut?: Map<string, Buffer>;
};
const timesCache = (g.__hdTimes ??= new Map());
const tileCache = (g.__hdTiles ??= new Map());
const outCache = (g.__hdOut ??= new Map());

/** SLIDER timestamps (YYYYMMDDhhmmss) as epoch ms, newest first. ~16 h are listed. */
async function sliderTimes(sat: HdSat): Promise<{ ms: number; stamp: string }[]> {
  const key = sat;
  const hit = timesCache.get(key);
  let list: number[];
  if (hit && Date.now() - hit.at < 60_000) list = hit.list;
  else {
    try {
      const r = await fetch(`${BASE}/data/json/${GEOM[sat].slider}/full_disk/geocolor/latest_times.json`, { cache: "no-store" });
      list = ((await r.json()) as { timestamps_int: number[] }).timestamps_int ?? [];
      timesCache.set(key, { at: Date.now(), list });
    } catch {
      list = hit?.list ?? [];
    }
  }
  return list.map((n) => {
    const s = String(n);
    const ms = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14));
    return { ms, stamp: s };
  });
}

/** The SLIDER scan matching a time (same 10-minute slot), or null if not listed. */
export async function matchStamp(sat: HdSat, t: number, toleranceMin = 5): Promise<string | null> {
  const list = await sliderTimes(sat);
  let best: { ms: number; stamp: string } | null = null;
  for (const f of list) {
    const d = Math.abs(f.ms - t);
    if (d <= toleranceMin * 60_000 && (!best || d < Math.abs(best.ms - t))) best = f;
  }
  return best?.stamp ?? null;
}

// At most this many SLIDER downloads at once (each ~0.3–1 MB, ~1 s from the UK).
let active = 0;
const waiting: (() => void)[] = [];
export async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 24) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export function sliderTile(sat: HdSat, stamp: string, z: number, row: number, col: number): Promise<Uint8ClampedArray | null> {
  const key = `${sat}/${stamp}/${z}/${row}/${col}`;
  let p = tileCache.get(key);
  if (!p) {
    const geo = GEOM[sat];
    const date = `${stamp.slice(0, 4)}/${stamp.slice(4, 6)}/${stamp.slice(6, 8)}`;
    const url = `${BASE}/data/imagery/${date}/${geo.slider}---full_disk/geocolor/${stamp}/${String(z).padStart(2, "0")}/${String(row).padStart(3, "0")}_${String(col).padStart(3, "0")}.png`;
    p = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const got = await slot(async () => {
            const r = await fetch(url);
            return { status: r.status, ok: r.ok, body: r.ok ? Buffer.from(await r.arrayBuffer()) : null };
          });
          if (got.status === 404) return null;
          if (got.ok && got.body) {
            const img = await loadImage(got.body);
            const c = createCanvas(geo.tile, geo.tile);
            const ctx = c.getContext("2d");
            ctx.drawImage(img, 0, 0);
            return ctx.getImageData(0, 0, geo.tile, geo.tile).data;
          }
        } catch {
          /* retry */
        }
        await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
      }
      return null;
    })();
    tileCache.set(key, p);
    // Each decoded tile is ~1.8 MB; keep ~200 (~370 MB). Finished map tiles
    // are cached separately (small WebP), so these are only working space.
    while (tileCache.size > cacheLimit(200, tileCache.size)) tileCache.delete(tileCache.keys().next().value!);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Output tile
// ---------------------------------------------------------------------------

const tile2lon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;

interface Proj {
  zs: number;
  n: number; // full-disk size at zs, px
  gx: Float32Array; // source pixel x per output pixel (-1 = off the disc)
  gy: Float32Array;
  need: [number, number][]; // satellite tiles [row, col]
  r0: number;
  c0: number;
  gw: number;
  gh: number;
}

// The map-pixel → satellite-pixel mapping depends only on the satellite and
// the map tile, never on the time — so it is worked out once and reused for
// every frame of the loop (the costly trig, ~40 ms per 512-px tile).
const projCache: Map<string, Proj> = ((g as unknown as { __hdProj?: Map<string, Proj> }).__hdProj ??= new Map());

function projection(sat: HdSat, z: number, x: number, y: number, S: number): Proj {
  const key = `${sat}/${z}/${x}/${y}/${S}`;
  const hit = projCache.get(key);
  if (hit) {
    projCache.delete(key);
    projCache.set(key, hit);
    return hit;
  }
  const geo = GEOM[sat];
  // SLIDER zoom whose pixels are at least as fine as the output's.
  const outKm = 40075 / (S * 2 ** z);
  const zs = Math.max(0, Math.min(geo.maxZ, Math.ceil(Math.log2(16 / outKm))));
  const scale = 2 ** zs;
  const center = geo.tile / 2;
  const n = geo.tile * scale;
  const T = geo.tile;
  const west = tile2lon(x, z);
  const east = tile2lon(x + 1, z);
  const mercN = Math.PI - (2 * Math.PI * y) / 2 ** z;
  const mercS = Math.PI - (2 * Math.PI * (y + 1)) / 2 ** z;
  const gx = new Float32Array(S * S);
  const gy = new Float32Array(S * S);
  let rMin = Infinity, rMax = -Infinity, cMin = Infinity, cMax = -Infinity;
  for (let py = 0; py < S; py++) {
    const m = mercN + ((mercS - mercN) * (py + 0.5)) / S;
    const lat = (Math.atan(Math.sinh(m)) * 180) / Math.PI;
    for (let px = 0; px < S; px++) {
      const i = py * S + px;
      const a = scanAngles(west + ((east - west) * (px + 0.5)) / S, lat, geo.lon0);
      const sx = a ? (center + (a[0] / geo.rx) * geo.Rx) * scale - 0.5 : -1;
      const sy = a ? (center - (a[1] / geo.ry) * geo.Ry) * scale - 0.5 : -1;
      if (!a || sx < 0 || sy < 0 || sx + 1 >= n || sy + 1 >= n) {
        gx[i] = -1;
        continue;
      }
      gx[i] = sx;
      gy[i] = sy;
      const c0 = (sx / T) | 0, c1 = ((sx + 1) / T) | 0;
      const r0 = (sy / T) | 0, r1 = ((sy + 1) / T) | 0;
      if (c0 < cMin) cMin = c0;
      if (c1 > cMax) cMax = c1;
      if (r0 < rMin) rMin = r0;
      if (r1 > rMax) rMax = r1;
    }
  }
  const need: [number, number][] = [];
  if (rMin <= rMax) for (let r = rMin; r <= rMax; r++) for (let c = cMin; c <= cMax; c++) need.push([r, c]);
  const p: Proj = {
    zs, n, gx, gy, need,
    r0: rMin <= rMax ? rMin : 0,
    c0: cMin <= cMax ? cMin : 0,
    gw: Math.max(1, cMax - cMin + 1),
    gh: Math.max(1, rMax - rMin + 1),
  };
  projCache.set(key, p);
  // 512-px entry ≈ 2 MB; 160 entries covers a full screen at two zooms.
  while (projCache.size > cacheLimit(160, projCache.size)) projCache.delete(projCache.keys().next().value!);
  return p;
}

/**
 * One Web-Mercator tile (S×S px) of a satellite at time t. Returns null if
 * SLIDER has no scan for that time (the caller falls back to GIBS).
 */
export async function renderHdTile(
  sat: HdSat,
  t: number,
  z: number,
  x: number,
  y: number,
  S: number,
  timing?: Record<string, number>
): Promise<Buffer | null> {
  const T0 = performance.now();
  const mark = (k: string) => timing && (timing[k] = Math.round(performance.now() - T0));
  const stamp = await matchStamp(sat, t);
  mark("stamp");
  if (!stamp) return null;
  const okey = `${sat}/${stamp}/${z}/${x}/${y}/${S}`;
  const hit = outCache.get(okey);
  if (hit) return hit;
  // The same tile asked for twice at once (the warm-up and the map) is made once.
  let job = inflight.get(okey);
  if (!job) {
    job = render(sat, stamp, okey, z, x, y, S, mark).finally(() => inflight.delete(okey));
    inflight.set(okey, job);
  }
  return job;
}

const inflight = new Map<string, Promise<Buffer>>();

/**
 * Warm-up: make one map tile for EVERY frame of a loop, several at a time,
 * so by the time the map asks for frame N it is already made. Without this
 * the browser's 6-connections-per-site limit trickles a 37-frame loop
 * through ~6 tiles at a time.
 */
export async function warmHd(sat: HdSat, times: number[], z: number, x: number, y: number, S: number): Promise<void> {
  const queue = [...times].sort((a, b) => b - a); // newest first — that is what shows first
  const worker = async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
      try {
        await renderHdTile(sat, t, z, x, y, S);
      } catch {
        /* one bad frame does not stop the rest */
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}

async function render(
  sat: HdSat,
  stamp: string,
  okey: string,
  z: number,
  x: number,
  y: number,
  S: number,
  mark: (k: string) => unknown
): Promise<Buffer> {

  const geo = GEOM[sat];
  const pr = projection(sat, z, x, y, S);
  mark("project");
  mark(`src${pr.need.length}`);

  // Satellite tiles this map tile needs, laid out in a small grid for O(1) lookup.
  const grid: (Uint8ClampedArray | null)[] = new Array(pr.gw * pr.gh).fill(null);
  await Promise.all(
    pr.need.map(async ([r, c]) => {
      grid[(r - pr.r0) * pr.gw + (c - pr.c0)] = await sliderTile(sat, stamp, pr.zs, r, c);
    })
  );
  mark("fetch");

  const out = createCanvas(S, S);
  const octx = out.getContext("2d");
  const img = octx.createImageData(S, S);
  const D = img.data;
  const T = geo.tile;
  const { gx: GX, gy: GY, n, r0: R0, c0: C0, gw: GW } = pr;
  // Pixel lookup: returns the RGBA base index in its tile, via two out-params.
  let px: Uint8ClampedArray | null = null;
  let pi = 0;
  const at = (sx: number, sy: number) => {
    const tr = (sy / T) | 0;
    const tc = (sx / T) | 0;
    px = grid[(tr - R0) * GW + (tc - C0)] ?? null;
    pi = ((sy - tr * T) * T + (sx - tc * T)) * 4;
  };
  for (let i = 0, N = S * S; i < N; i++) {
    const gx = GX[i];
    if (gx < 0) continue;
    const gy = GY[i];
    const x0 = gx | 0;
    const y0 = gy | 0;
    if (x0 + 1 >= n || y0 + 1 >= n) continue;
    const tx = gx - x0;
    const ty = gy - y0;
    const w00 = (1 - tx) * (1 - ty);
    const w10 = tx * (1 - ty);
    const w01 = (1 - tx) * ty;
    const w11 = tx * ty;
    const o = i * 4;
    const lx = x0 % T;
    const ly = y0 % T;
    if (lx < T - 1 && ly < T - 1) {
      // Fast path: all four neighbours in one satellite tile.
      at(x0, y0);
      const t = px as Uint8ClampedArray | null;
      if (!t) continue;
      const a = pi;
      const b = a + 4;
      const c = a + T * 4;
      const d = c + 4;
      D[o] = t[a] * w00 + t[b] * w10 + t[c] * w01 + t[d] * w11;
      D[o + 1] = t[a + 1] * w00 + t[b + 1] * w10 + t[c + 1] * w01 + t[d + 1] * w11;
      D[o + 2] = t[a + 2] * w00 + t[b + 2] * w10 + t[c + 2] * w01 + t[d + 2] * w11;
      D[o + 3] = t[a + 3] * w00 + t[b + 3] * w10 + t[c + 3] * w01 + t[d + 3] * w11;
    } else {
      // Tile seam: gather each neighbour separately.
      at(x0, y0);
      const ta = px as Uint8ClampedArray | null, ia = pi;
      at(x0 + 1, y0);
      const tb = px as Uint8ClampedArray | null, ib = pi;
      at(x0, y0 + 1);
      const tc = px as Uint8ClampedArray | null, ic = pi;
      at(x0 + 1, y0 + 1);
      const td = px as Uint8ClampedArray | null, id = pi;
      if (!ta || !tb || !tc || !td) continue;
      for (let ch = 0; ch < 4; ch++) {
        D[o + ch] = ta[ia + ch] * w00 + tb[ib + ch] * w10 + tc[ic + ch] * w01 + td[id + ch] * w11;
      }
    }
  }
  octx.putImageData(img, 0, 0);
  mark("sample");
  const buf = out.toBuffer("image/webp", 88);
  mark("encode");
  outCache.set(okey, buf);
  while (outCache.size > cacheLimit(4000, outCache.size)) outCache.delete(outCache.keys().next().value!);
  return buf;
}
