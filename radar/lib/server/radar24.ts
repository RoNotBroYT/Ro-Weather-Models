// 24-hour radar history, as map tiles.
//
// No free radar network covers the whole world with a day of history, so
// this combines the best that exist, per place, on one timeline:
//
//   Europe (incl. UK)  EUMETNET OPERA composite — 5-min, ~1 km, 24 h kept
//                      (public S3, CC BY 4.0). Decoded from HDF5 here.
//   USA                NOAA NEXRAD national mosaic via Iowa Environmental
//                      Mesonet — 5-min, archived (tiles by timestamp).
//   Everywhere else    RainViewer global — ONLY its last 2 hours exist.
//
// So a frame older than 2 hours shows rain over Europe and the USA only;
// the rest of the world is blank because there is no data, not because it
// is dry. The radar page says so on screen.
//
// Each tile is rendered once per (time, z, x, y) and kept in memory; the
// response is immutable for past times, so the browser caches it too.

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { dbzToRgba, lonLatToGrid, lonLatToLaea, type LaeaGrid } from "./operaRadar";
import { n0qDbz } from "./n0qPalette";
import { mrms, type MrmsField } from "./mrms";
import { canadaTile } from "./canadaRadar";
import { satRainField, type SatRainField } from "./globalRain";
import { precipFieldNow, precipFieldWait, tileTypes, typedRgba, TYPE_BLOCK, type PrecipField } from "./precipType";
import { decodeDbzGrid } from "../rotationDetect";
import { cacheLimit, parallelism } from "./localBoost";
import {
  BSPLINE_VARIANCE,
  bsplineWeights,
  coverageShare,
  coveredHeight,
  demPoolFactor,
  demSigmaKm,
  encodeTerrainRgb,
  gaussianBlur,
  gaussianKernel,
  heightOfDbz,
  pixelSurfaceMargin,
  surfaceFromPixelDbz,
} from "../radarHeight";

const OPERA_S3 = "https://s3.waw3-1.cloudferro.com/openradar-24h";
const pad = (n: number) => String(n).padStart(2, "0");
export function operaUrl(t: number): string {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const mo = pad(d.getUTCMonth() + 1);
  const da = pad(d.getUTCDate());
  const stamp = `${y}${mo}${da}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  return `${OPERA_S3}/${y}/${mo}/${da}/OPERA/COMP/OPERA@${stamp}@0@DBZH.h5`;
}

/** NEXRAD n0q mosaic tile for a time (IEM archive, 5-minute stamps, UTC). */
export function nexradUrl(t: number, z: number, x: number, y: number): string {
  const d = new Date(t);
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  return `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/ridge::USCOMP-N0Q-${stamp}/${z}/${x}/${y}.png`;
}

// ---------------------------------------------------------------------------
// OPERA at FULL resolution (1 km), read window-by-window
// ---------------------------------------------------------------------------
//
// The file is downloaded once per frame and kept open; each map tile then
// reads only the small rectangle of the 1 km grid it covers (HDF5 supports
// that directly), so zooming in shows the radar's real 1 km detail instead
// of a 2 km thumbnail blown up. Values are interpolated in dBZ — not in
// colour — before colouring, which is how professional radar displays get
// smooth, sharp storm edges at any zoom without inventing detail.

export interface OperaFile {
  grid: LaeaGrid;
  nodata: number;
  undetect: number;
  gain: number;
  offset: number;
  read: (r0: number, r1: number, c0: number, c1: number) => ArrayLike<number>;
  /**
   * Optional: the window already thinned to one value per k × k block
   * (wc × wr values; how a block is summed up is the file's own business —
   * the radar forecast averages rain power). Used by the radar forecast,
   * whose cells are computed rather than read, so it can skip the cells it
   * would throw away. The height tiles ask with r0 and c0 on multiples of k
   * and take value (i, j) to be the block of rows r0 + j·k… and columns
   * c0 + i·k….
   */
  readPooled?: (r0: number, r1: number, c0: number, c1: number, k: number) => ArrayLike<number>;
  close: () => void;
}

let h5Promise: Promise<typeof import("h5wasm/node")> | null = null;
async function h5() {
  if (!h5Promise) {
    h5Promise = (async () => {
      const mod = await import("h5wasm/node");
      await mod.ready;
      return mod;
    })();
  }
  return h5Promise;
}
const num = (a: Record<string, { value: unknown }>, k: string) => {
  const v = a[k]?.value;
  const n = typeof v === "number" ? v : Number(Array.isArray(v) ? v[0] : v);
  return Number.isFinite(n) ? n : NaN;
};

async function openOpera(t: number): Promise<OperaFile | null> {
  const res = await fetch(operaUrl(t), { cache: "no-store" }).catch(() => null);
  if (!res || !res.ok) return null;
  const { File: H5File } = await h5();
  const tmp = path.join(os.tmpdir(), `opera24-${t}.h5`);
  await fsp.writeFile(tmp, new Uint8Array(await res.arrayBuffer()));
  try {
    const f = new H5File(tmp, "r");
    const a = (f.get("where") as unknown as { attrs: Record<string, { value: unknown }> }).attrs;
    const projdef = String(a["projdef"]?.value ?? "");
    const pj = (k: string) => Number(projdef.match(new RegExp(`\\+${k}=(-?[\\d.]+)`))?.[1]);
    const grid: LaeaGrid = {
      lat0: pj("lat_0"),
      lon0: pj("lon_0"),
      falseEasting: pj("x_0"),
      falseNorthing: pj("y_0"),
      xscale: num(a, "xscale"),
      yscale: num(a, "yscale"),
      cols: num(a, "xsize"),
      rows: num(a, "ysize"),
      originX: 0,
      originY: 0,
    };
    if (![grid.lat0, grid.lon0, grid.cols, grid.rows].every(Number.isFinite)) {
      f.close();
      return null;
    }
    const ul = lonLatToLaea(num(a, "UL_lon"), num(a, "UL_lat"), grid);
    grid.originX = ul.x;
    grid.originY = ul.y;
    // Safety check: the lower-right corner must land where the file says.
    const lr = lonLatToGrid(num(a, "LR_lon"), num(a, "LR_lat"), grid);
    if (Math.hypot(lr.col - grid.cols, lr.row - grid.rows) * (grid.xscale / 1000) > 5) {
      f.close();
      return null;
    }
    const what = (f.get("dataset1/data1/what") as unknown as { attrs: Record<string, { value: unknown }> }).attrs;
    const ds = f.get("dataset1/data1/data") as unknown as { slice: (s: number[][]) => ArrayLike<number> };
    return {
      grid,
      nodata: num(what, "nodata"),
      undetect: num(what, "undetect"),
      gain: Number.isFinite(num(what, "gain")) ? num(what, "gain") : 1,
      offset: Number.isFinite(num(what, "offset")) ? num(what, "offset") : 0,
      read: (r0, r1, c0, c1) =>
        ds.slice([
          [r0, r1],
          [c0, c1],
        ]),
      close: () => {
        try {
          f.close();
        } catch {
          /* closed */
        }
        fsp.unlink(tmp).catch(() => {});
      },
    };
  } catch (e) {
    console.warn("[radar24] opera open failed", e);
    return null;
  }
}

const g = globalThis as unknown as {
  __r24files?: Map<number, Promise<OperaFile | null>>;
  __r24failed?: Map<number, number>;
  __r24tiles?: Map<string, Buffer>;
  __r24rv?: { at: number; host: string; past: { time: number; path: string }[] };
};
const fileCache = (g.__r24files ??= new Map());
/** When each composite that could NOT be opened was last tried (ms). */
const failedAt = (g.__r24failed ??= new Map());
const tileCache = (g.__r24tiles ??= new Map());

/**
 * How long a failed download is remembered before it is tried again.
 *
 * A composite that could not be opened used to stay in the cache as "no
 * file" until 90 newer ones had pushed it out. On a server that runs for
 * days (the Mac mini) one dropped connection therefore left that radar time
 * without its European data for hours, and the forecast's own retry got the
 * same remembered failure back. Remembering it for half a minute still
 * stops a burst of tiles for one missing composite (not yet published, or
 * older than the bucket's 24 hours) from each starting its own download.
 */
const OPERA_RETRY_MS = 30_000;

/** Downloads run two at a time so a 24 h loop cannot swamp the server. */
let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= parallelism(3)) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

export function opera(t: number): Promise<OperaFile | null> {
  let p = fileCache.get(t);
  // A remembered failure that is old enough is forgotten, so this call
  // downloads again (see OPERA_RETRY_MS).
  const failed = failedAt.get(t);
  if (p && failed !== undefined && Date.now() - failed >= OPERA_RETRY_MS) {
    fileCache.delete(t);
    failedAt.delete(t);
    p = undefined;
  }
  if (!p) {
    // A download that throws (connection dropped half-way, disk full) counts
    // as "no file" like any other failure, instead of staying in the cache
    // as an error that every later tile for this time would be handed.
    const made: Promise<OperaFile | null> = limited(() => openOpera(t)).catch((e) => {
      console.warn("[radar24] opera download failed", e);
      return null;
    });
    p = made;
    fileCache.set(t, made);
    void made.then((f) => {
      if (!f && fileCache.get(t) === made) failedAt.set(t, Date.now());
    });
    // ~2 MB on disk each; a day at 30-min steps plus the last 2 h at 5-min.
    while (fileCache.size > cacheLimit(90, fileCache.size)) {
      const k = fileCache.keys().next().value!;
      fileCache.get(k)?.then((f: OperaFile | null) => f?.close());
      fileCache.delete(k);
      failedAt.delete(k);
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// RainViewer (global, last 2 h only)
// ---------------------------------------------------------------------------

async function rainviewer(): Promise<{ host: string; past: { time: number; path: string }[] } | null> {
  if (g.__r24rv && Date.now() - g.__r24rv.at < 60_000) return g.__r24rv;
  try {
    const d = await (await fetch("https://api.rainviewer.com/public/weather-maps.json", { cache: "no-store" })).json();
    g.__r24rv = { at: Date.now(), host: d.host, past: d.radar?.past ?? [] };
    return g.__r24rv;
  } catch {
    return null;
  }
}

async function fetchImage(url: string) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await loadImage(Buffer.from(await r.arrayBuffer()));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tile
// ---------------------------------------------------------------------------

export const tile2lon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
export const tile2lat = (y: number, z: number) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
};

/**
 * `final` = this tile can never change: its OPERA composite was published
 * and read, and no source that is still filling in (NEXRAD's recent tiles,
 * RainViewer's last-2-hour frames) was drawn into it. Final tiles are cached
 * for a day by the CDN even when they are only minutes old — before, every
 * tile younger than 20 minutes was re-drawn from scratch every 2 minutes,
 * and the newest frames are exactly the ones everybody loads first.
 */
export async function renderTile(
  t: number,
  z: number,
  x: number,
  y: number,
  scale = 1,
  /** 0 = off; 1–3 = smooth the RAIN FIELD itself (dBZ) before colouring. */
  smooth = 0
): Promise<{ buf: Buffer; final: boolean }> {
  const key = `${scale}/${smooth}/${t}/${z}/${x}/${y}`;
  const hit = tileCache.get(key);
  if (hit) return { buf: hit, final: true };

  // scale 2 = 512-px tiles for high-density (Retina) screens.
  const S = 256 * scale;
  const RV = scale > 1 ? 512 : 256;
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext("2d");
  const west = tile2lon(x, z);
  const east = tile2lon(x + 1, z);
  const north = tile2lat(y, z);
  const south = tile2lat(y + 1, z);

  // 1) Where no ground radar of ours reaches: RainViewer for now, NOAA's
  // satellite rain estimate once RainViewer is switched off (RO_NO_RAINVIEWER=1,
  // the plan after the next App Store update). The satellite picture is drawn by
  // the same code and colours as the radars, only softer: it is an estimate.
  const noRv = process.env.RO_NO_RAINVIEWER === "1";
  let sat: SatRainField | null = null;
  const satTask = noRv ? satRainField(t).then((f) => void (sat = f)).catch(() => {}) : null;
  const rv = noRv ? null : await rainviewer();
  // RainViewer frames are every 10 min; a 5-min frame uses the one just before.
  const rvf = rv?.past.filter((f) => f.time * 1000 <= t + 60_000 && t - f.time * 1000 < 10 * 60_000).pop();
  const intersects = (w: number, s: number, e: number, n: number) => east > w && west < e && north > s && south < n;
  const tasks: Promise<void>[] = [];
  let rvImg: Awaited<ReturnType<typeof fetchImage>> = null;
  let rvCrop: [number, number, number] | null = null;
  // Inside OPERA's dense core (Britain, Ireland and most of Europe) OPERA
  // alone is drawn: RainViewer would be painted underneath and then fully
  // covered by the 1 km data, so fetching it only cost ~0.1–0.3 s a tile.
  const inOperaCore = west > -10.5 && east < 20 && south > 40 && north < 70;
  if (rv && rvf && !inOperaCore) {
    // RainViewer tiles stop at z7; deeper tiles crop the parent.
    const zz = Math.min(z, 7);
    const k = 2 ** (z - zz);
    if (k > 1) rvCrop = [(x % k) * (RV / k), (y % k) * (RV / k), RV / k];
    tasks.push(
      fetchImage(`${rv.host}${rvf.path}/${RV}/${zz}/${Math.floor(x / k)}/${Math.floor(y / k)}/2/1_1.png`).then((img) => {
        rvImg = img;
      })
    );
  }
  // 2) NEXRAD over the USA.
  let nx: Awaited<ReturnType<typeof fetchImage>> = null;
  // Canada (ECCC composite pictures, decoded back to dBZ; see canadaRadar.ts).
  let ca: MrmsField | null = null;
  if (intersects(-141, 41.5, -52, 70) && z <= 10) tasks.push(canadaTile(t, west, east, north, south, S).then((f) => void (ca = f)));
  let mr: MrmsField | null = null;
  if (intersects(-130, 20, -60, 52) && z <= 10) {
    // MRMS (measured dBZ, every 2 min) drawn by the same code as OPERA; the Iowa
    // NEXRAD picture tiles only if no MRMS picture is to be had for this time.
    const tt = Math.floor(t / 300_000) * 300_000;
    tasks.push(
      mrms(t)
        .catch(() => null)
        .then((f) => (f ? void (mr = f) : fetchImage(nexradUrl(tt, z, x, y)).then((img) => void (nx = img))))
    );
  }
  // 3) OPERA over Europe.
  let op: OperaFile | null = null;
  if (intersects(-32, 30, 50, 75)) tasks.push(opera(Math.floor(t / 300_000) * 300_000).then((o) => void (op = o)));
  if (satTask) tasks.push(satTask);
  await Promise.all(tasks);
  // OPERA file unavailable inside its core: fall back to RainViewer after all.
  if (!op && inOperaCore && rv && rvf) {
    const zz = Math.min(z, 7);
    const k = 2 ** (z - zz);
    if (k > 1) rvCrop = [(x % k) * (RV / k), (y % k) * (RV / k), RV / k];
    rvImg = await fetchImage(`${rv.host}${rvf.path}/${RV}/${zz}/${Math.floor(x / k)}/${Math.floor(y / k)}/2/1_1.png`);
  }

  const rvI = rvImg as Awaited<ReturnType<typeof fetchImage>>;
  if (rvI) {
    if (rvCrop) ctx.drawImage(rvI, rvCrop[0], rvCrop[1], rvCrop[2], rvCrop[2], 0, 0, S, S);
    else ctx.drawImage(rvI, 0, 0, S, S);
  }
  // Rain / mix / snow from GFS temperatures (null until loaded: drawn as rain, not cached).
  const pf = await precipFieldWait(t);
  const nxI = nx as Awaited<ReturnType<typeof fetchImage>>;
  if (nxI) {
    const types = pf ? tileTypes(pf, west, east, north, south, 256) : null;
    if (types) {
      // n0q tiles are pre-coloured: colour → dBZ (IEM's exact table), recoloured where cold.
      const c = createCanvas(256, 256);
      const cx = c.getContext("2d");
      cx.drawImage(nxI, 0, 0, 256, 256);
      const im = cx.getImageData(0, 0, 256, 256);
      const d = im.data;
      for (let i = 0; i < 256 * 256; i++) {
        if (!d[i * 4 + 3]) continue;
        const ty = types[((i >> 8) >> 2) * 64 + ((i & 255) >> 2)];
        if (!ty) continue;
        const v = n0qDbz(d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]);
        if (v <= -32) continue;
        const [R, G, B, A] = typedRgba(ty, v);
        d[i * 4] = R;
        d[i * 4 + 1] = G;
        d[i * 4 + 2] = B;
        d[i * 4 + 3] = A;
      }
      cx.putImageData(im, 0, 0);
      ctx.drawImage(c, 0, 0, S, S);
    } else ctx.drawImage(nxI, 0, 0, S, S);
  }
  const st = sat as SatRainField | null;
  if (st) {
    // Fainter, as befits an estimate: the radars drawn after it replace it wherever they reach.
    drawOpera(ctx, st, west, east, north, south, S, smooth, { x, y, z }, pf, 0.75);
  }
  const cn = ca as MrmsField | null;
  if (cn) drawOpera(ctx, cn, west, east, north, south, S, smooth, { x, y, z }, pf);
  const m = mr as MrmsField | null;
  if (m) drawOpera(ctx, m, west, east, north, south, S, smooth, { x, y, z }, pf);
  const o = op as OperaFile | null;
  if (o) drawOpera(ctx, o, west, east, north, south, S, smooth, { x, y, z }, pf);
  // Quality 80: about a fifth less work to save each tile, with no difference you can see on rain.
  const buf = canvas.toBuffer("image/webp", 80);
  const old = Date.now() - t > 20 * 60_000;
  // Final: old enough that every source has settled, OR drawn from a
  // published OPERA file with nothing still-changing mixed in.
  // (MRMS: settled once its picture is the one for this time, not an older stand-in.)
  const usSettled = (!intersects(-130, 20, -60, 52) || (!!m && m.time >= t - 150_000)) && (!intersects(-141, 41.5, -52, 70) || (!!cn && cn.time > t - 6 * 60_000));
  const satSettled = !st || Date.now() - t > 45 * 60_000;
  const final = !!pf && satSettled && (old || (!rvI && usSettled && (!!o || !intersects(-32, 30, 50, 75))));
  if (final) {
    tileCache.set(key, buf);
    while (tileCache.size > cacheLimit(3000, tileCache.size)) tileCache.delete(tileCache.keys().next().value!);
  }
  return { buf, final };
}

/**
 * The OPERA reflectivity (dBZ) for every pixel of one map tile: the grid
 * window the tile covers is read once, then each output pixel is
 * interpolated bilinearly between the four surrounding 1 km cells (no-data
 * counts as −32, "no echo"). NaN = outside the OPERA grid, or out of every
 * radar's range.
 * Used by the colour tiles (drawOpera). The 3D height tiles read the same
 * cells of the same file but not through this function: straight-line
 * interpolation leaves a crease at every cell boundary, which a picture
 * hides and a lit 3D surface shows (see operaSurface).
 */
function sampleOperaDbz(o: OperaFile | MrmsField | SatRainField, west: number, east: number, north: number, south: number, S: number): Float32Array {
  // Sources on their own grids (MRMS) sample themselves; everything after this is shared.
  if ("sample" in o) return o.sample(west, east, north, south, S);
  const out = new Float32Array(S * S).fill(NaN);
  // Grid window covering the tile (+2 cells for interpolation).
  const corners = [
    lonLatToGrid(west, north, o.grid),
    lonLatToGrid(east, north, o.grid),
    lonLatToGrid(west, south, o.grid),
    lonLatToGrid(east, south, o.grid),
    lonLatToGrid((west + east) / 2, north, o.grid),
    lonLatToGrid((west + east) / 2, south, o.grid),
  ];
  const c0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.col))) - 2);
  const c1 = Math.min(o.grid.cols, Math.ceil(Math.max(...corners.map((c) => c.col))) + 2);
  const r0 = Math.max(0, Math.floor(Math.min(...corners.map((c) => c.row))) - 2);
  const r1 = Math.min(o.grid.rows, Math.ceil(Math.max(...corners.map((c) => c.row))) + 2);
  if (c1 <= c0 || r1 <= r0) return out;
  // Very zoomed-out tiles would read a huge window; sample every k-th cell.
  const k = Math.max(1, Math.floor(Math.max(c1 - c0, r1 - r0) / (S * 1.5)));
  let raw: ArrayLike<number>;
  let wc: number;
  let wr: number;
  if (k === 1) {
    raw = o.read(r0, r1, c0, c1);
    wc = c1 - c0;
    wr = r1 - r0;
  } else if (o.readPooled) {
    raw = o.readPooled(r0, r1, c0, c1, k);
    wc = Math.ceil((c1 - c0) / k);
    wr = Math.ceil((r1 - r0) / k);
  } else {
    const full = o.read(r0, r1, c0, c1);
    const fc = c1 - c0;
    wc = Math.ceil(fc / k);
    wr = Math.ceil((r1 - r0) / k);
    const sub = new Float64Array(wc * wr);
    for (let rr = 0; rr < wr; rr++) for (let cc = 0; cc < wc; cc++) {
      // Average of the block as rain POWER (Z = 10^(dBZ/10)), not the max.
      // Taking the max made every zoomed-out tile swell: a single wet 1 km
      // cell painted its whole k×k block, so rain areas grew into blobs the
      // further out you zoomed. A power average keeps the true footprint,
      // and strong cores still dominate it (Z is linear in rain power).
      let zSum = 0;
      let n = 0;
      let wet = 0;
      let cov = 0;
      for (let a = 0; a < k; a++) for (let b = 0; b < k; b++) {
        const R = rr * k + a;
        const C = cc * k + b;
        if (R < r1 - r0 && C < fc) {
          const v = full[R * fc + C];
          if (v === o.nodata || !Number.isFinite(v)) continue;
          n++;
          cov++;
          if (v === o.undetect) continue;
          const d = v * o.gain + o.offset;
          if (d > -32) {
            zSum += Math.pow(10, d / 10);
            wet++;
          }
        }
      }
      // Dry cells count as zero power, so a lone shower in a big block is
      // shown fainter rather than spread over the whole block.
      sub[rr * wc + cc] = !cov ? o.nodata : wet && zSum > 0 ? (10 * Math.log10(zSum / n) - o.offset) / o.gain : o.undetect;
    }
    raw = sub;
  }
  // dBZ grid with no-data → very low
  const dbz = new Float32Array(wc * wr);
  for (let i = 0; i < dbz.length; i++) {
    const v = raw[i];
    // nodata = outside every radar's range (NaN: "no information", so other
    // sources may fill it); undetect = scanned, no rain (−32).
    dbz[i] = v === o.nodata || !Number.isFinite(v) ? NaN : v === o.undetect ? -32 : v * o.gain + o.offset;
  }
  const mercN = Math.log(Math.tan(Math.PI / 4 + (north * Math.PI) / 360));
  const mercS = Math.log(Math.tan(Math.PI / 4 + (south * Math.PI) / 360));
  for (let py = 0; py < S; py++) {
    const my = mercN + ((mercS - mercN) * (py + 0.5)) / S;
    const lat = (Math.atan(Math.sinh(my)) * 180) / Math.PI;
    for (let px = 0; px < S; px++) {
      const lon = west + ((east - west) * (px + 0.5)) / S;
      const { col, row } = lonLatToGrid(lon, lat, o.grid);
      // cell-centre coordinates in the window
      const fx = (col - c0) / k - 0.5;
      const fy = (row - r0) / k - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= wc || y0 + 1 >= wr) continue;
      const tx = fx - x0;
      const ty = fy - y0;
      const i00 = y0 * wc + x0;
      const v =
        dbz[i00] * (1 - tx) * (1 - ty) + dbz[i00 + 1] * tx * (1 - ty) + dbz[i00 + wc] * (1 - tx) * ty + dbz[i00 + wc + 1] * tx * ty;
      out[py * S + px] = v;
    }
  }
  return out;
}

/**
 * Draws the 1 km OPERA grid into a tile (see sampleOperaDbz), coloured.
 * Sharp at every zoom, and never brighter than the data.
 */
export function drawOpera(
  ctx: ReturnType<ReturnType<typeof createCanvas>["getContext"]>,
  o: OperaFile | MrmsField,
  west: number,
  east: number,
  north: number,
  south: number,
  S: number,
  smooth = 0,
  tile?: { x: number; y: number; z: number },
  /** GFS temperatures for snow / mix colouring; null = all rain. */
  pf: PrecipField | null = null,
  /** Opacity on top of the colour scale's own (the satellite estimate is drawn fainter). */
  alpha = 1
) {
  const types = pf ? tileTypes(pf, west, east, north, south, S) : null;
  const TB = Math.ceil(S / TYPE_BLOCK);
  let dbzPx: Float32Array;
  // Zoomed out, the smoothing eases off gently (half as wide every two zoom levels below 7) and
  // never below a pixel: the same picture quality at every zoom, only a touch lighter right out,
  // without spreading each shower into a blob hundreds of km wide.
  const reach = tile ? Math.max(1, [0, 2, 4, 7][Math.min(3, smooth)] * (S / 256) * Math.min(1, 2 ** ((tile.z - 7) / 2))) : 0;
  if (smooth > 0 && tile) {
    // Smoothing done on the rain field, not the picture: the old option
    // blurred the finished colour tile, which just made it fuzzy. Here the
    // dBZ values are averaged (box blur, radius 2 / 4 / 7 cells scaled to
    // the tile, read with a margin so tiles join seamlessly) and THEN
    // coloured — shapes get rounder but colour edges stay crisp. No-echo
    // counts as 5 dBZ.
    // Light / Medium / Strong = averaging radius 2 / 4 / 7 km-scale cells.
    const R = Math.max(1, Math.round(reach));
    const P = R * 2, W = S + 2 * P;
    const d = sampleOperaDbz(
      o,
      tile2lon(tile.x - P / S, tile.z),
      tile2lon(tile.x + 1 + P / S, tile.z),
      tile2lat(tile.y - P / S, tile.z),
      tile2lat(tile.y + 1 + P / S, tile.z),
      W
    );
    const v = new Float32Array(W * W);
    // Averaged as rain POWER (Z = 10^(dBZ/10)), not as dBZ: strong cores
    // dominate the average the way they dominate the rain itself, so they
    // keep their strength while ragged edges and specks smooth out.
    for (let i = 0; i < W * W; i++) v[i] = Number.isNaN(d[i]) ? NaN : Math.pow(10, Math.max(5, d[i]) / 10);
    const r = Math.max(1, Math.round(R / 1.7));
    const pass = (src: Float32Array, horiz: boolean) => {
      const out = new Float32Array(W * W);
      for (let yy = 0; yy < W; yy++)
        for (let xx = 0; xx < W; xx++) {
          let sum = 0, n = 0;
          for (let k = -r; k <= r; k++) {
            const qx = horiz ? xx + k : xx, qy = horiz ? yy : yy + k;
            if (qx < 0 || qy < 0 || qx >= W || qy >= W) continue;
            const q = src[qy * W + qx];
            if (Number.isNaN(q)) continue;
            sum += q;
            n++;
          }
          out[yy * W + xx] = n ? sum / n : NaN;
        }
      return out;
    };
    // Three box passes each way ≈ a Gaussian: round shapes, no square blocks.
    let sm = v;
    for (let k = 0; k < 3; k++) sm = pass(pass(sm, true), false);
    dbzPx = new Float32Array(S * S);
    for (let yy = 0; yy < S; yy++)
      for (let xx = 0; xx < S; xx++) {
        const z = sm[(yy + P) * W + xx + P];
        dbzPx[yy * S + xx] = Number.isNaN(z) ? NaN : 10 * Math.log10(Math.max(z, 1e-3));
      }
  } else {
    dbzPx = sampleOperaDbz(o, west, east, north, south, S);
  }
  const img = ctx.getImageData(0, 0, S, S);
  for (let i = 0; i < S * S; i++) {
    const v = dbzPx[i];
    // Outside every OPERA radar's range: leave whatever is underneath.
    if (Number.isNaN(v)) continue;
    // Below 10 dBZ (~0.1 mm/h) OPERA shows a wide haze of very light
    // returns, most of it not reaching the ground; RainViewer hides it too.
    // Where OPERA covers the pixel, ITS answer wins — so RainViewer's
    // smoothed, coarser picture drawn underneath is cleared here instead of
    // showing through as a grey, blobby halo round every shower (what made
    // zoomed-out views look blobby: tiles reaching past OPERA's core get the
    // RainViewer underlay, zoomed-in ones don't).
    if (!(v >= 10)) {
      img.data[i * 4 + 3] = 0;
      continue;
    }
    const ty = types ? types[Math.floor(i / S / TYPE_BLOCK) * TB + Math.floor((i % S) / TYPE_BLOCK)] : 0;
    const [R, G, B, A] = ty ? typedRgba(ty, v) : dbzToRgba(v);
    if (!A) continue;
    img.data[i * 4] = R;
    img.data[i * 4 + 1] = G;
    img.data[i * 4 + 2] = B;
    img.data[i * 4 + 3] = alpha === 1 ? A : Math.round(A * alpha);
  }
  ctx.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------------------
// 3D HEIGHT tiles
// ---------------------------------------------------------------------------
//
// The radar page's 3D view is a MapLibre terrain whose "elevation" is rain
// INTENSITY — not cloud height, not echo tops; the radar measures neither.
// These are its tiles: Mapbox terrain-RGB PNG, 256 px.
//
// The method is set out once in src/lib/radarHeight.ts — the height law, why
// HEIGHTS are smoothed rather than dBZ, how wide the smoothing is (in km),
// and where MapLibre takes a tile pixel to be (its corner). This file does
// the part that needs the radar data:
//
//   Europe     OPERA's own 1 km grid (operaSurface). Every cell's dBZ becomes
//              a height; the heights are smoothed on the grid itself, where a
//              cell is 1 km everywhere; the result is read at each tile pixel
//              with a cubic B-spline. Built from dBZ itself, never from tile
//              colours.
//   elsewhere  NEXRAD (USA) and RainViewer (the rest, last 2 h only) exist
//              only as pictures. Their colours are decoded exactly back to
//              dBZ (otherSourcesDbz) and the same steps run in pixel space
//              (surfaceFromPixelDbz).
//
// Where OPERA has scanned, its answer is the surface; the other sources fill
// only where it has no data, blended across the edge of its range rather than
// switched at it (demHeights).
//
// What this replaced, and why (figures from scripts/validate-dem.ts, old code
// against new on the same input). The old tile read OPERA by straight-line
// interpolation between cell centres, turned that into heights, and box-
// blurred the pixels by "about 1.5 km" — but the radius was capped at 2
// pixels, so from zoom 9 in (a pixel under 200 m) the blur shrank to a few
// hundred metres and every 1 km cell stood as its own facet, with a crease
// along each cell boundary; one isolated 55 dBZ cell was 0 m high at zoom 7,
// 4.6 km at zoom 10 and 8.3 km at zoom 11. Zoomed out (zoom 5 and wider) the
// cells were thinned in blocks counted from each tile's own corner, so
// neighbouring tiles disagreed along their shared edge by up to several
// kilometres. And "outside every radar's range" was drawn as height 0: a
// cliff wherever rain ran off the edge of the network.
//
// What holds now, each checked by the validator:
//   - the surface is one function of place and a tile is a window onto it:
//     neighbouring tiles agree to the last bit, at every zoom;
//   - from zoom 7 in it is the SAME surface at every zoom (a parent's pixel
//     equals its child's); further out it is that surface averaged over a
//     pixel, with the volume under it kept to within 0.3%;
//   - it is smooth at the radar's own resolution at any zoom;
//   - no data is not no rain: unscanned cells are left out of the average.
// One exception to the second: the radar FORECAST at zoom 5 and wider, whose
// cells arrive already thinned by its own module, holds 3–9% more volume
// than its children (see operaSurface).
// What it costs: narrow cores stand lower than the bare height law says (a
// single 1 km cell keeps 16% of it — at every zoom, where before it was
// anything from nothing to 63%). See radarHeight.ts.

/**
 * One 3D height tile for a radar time. `final` = it can never change (see
 * renderTile). Heights show rain intensity, not cloud height.
 */
export async function renderDem(t: number, z: number, x: number, y: number): Promise<{ buf: Buffer; final: boolean }> {
  const inEurope = tile2lon(x + 1, z) > -32 && tile2lon(x, z) < 50 && tile2lat(y, z) > 30 && tile2lat(y + 1, z) < 75;
  const [o, other] = await Promise.all([
    inEurope ? opera(Math.floor(t / 300_000) * 300_000) : Promise.resolve(null),
    otherSourcesDbz(t, z, x, y),
  ]);
  const old = Date.now() - t > 20 * 60_000;
  return { buf: renderDemFrom(o, z, x, y, other), final: old || (!!o && !other) };
}

// ---------------------------------------------------------------------------
// 3D outside Europe: the same height surface, from the same pictures the
// colour tiles use — NEXRAD over the USA (IEM n0q tiles, exact colour → dBZ
// table) and RainViewer everywhere else (raw "Universal Blue" tiles, exact
// table; only its last 2 hours exist). So the 3D view is built the same way
// over the whole world, not only over Europe.
// ---------------------------------------------------------------------------

/**
 * dBZ per pixel for a height tile, from NEXRAD and RainViewer, or null when
 * neither covers this tile/time. NaN = no data.
 *
 * The window is the 256 px tile plus a margin on every side, cut from the
 * tile and its 8 neighbours. The margin is as wide as the smoothing reaches
 * at this zoom and latitude (pixelSurfaceMargin — it was a fixed 8 px, which
 * is less than the kernel from zoom 8 in), so a tile and its neighbour
 * smooth the same pixels and meet exactly. The window's size tells
 * renderDemFrom the margin: (256 + 2 × margin)² values.
 */
async function otherSourcesDbz(t: number, z: number, x: number, y: number): Promise<Float32Array | null> {
  const n = 2 ** z;
  const P = pixelSurfaceMargin(256, z, y);
  const W = 256 + 2 * P;
  const tileBox = (tx: number, ty: number) => ({ w: tile2lon(tx, z), e: tile2lon(tx + 1, z), n: tile2lat(ty, z), s: tile2lat(ty + 1, z) });
  const box = tileBox(x, y);
  const inUS = box.e > -130 && box.w < -60 && box.n > 20 && box.s < 52 && z <= 10;
  const inOperaCore = box.w > -10.5 && box.e < 20 && box.s > 40 && box.n < 70;
  const rv = inOperaCore ? null : await rainviewer();
  const rvf = rv?.past.filter((f) => f.time * 1000 <= t + 60_000 && t - f.time * 1000 < 10 * 60_000).pop();
  if (!inUS && !rvf) return null;

  const imgCache = new Map<string, Promise<Awaited<ReturnType<typeof fetchImage>>>>();
  const img = (url: string) => {
    let p = imgCache.get(url);
    if (!p) imgCache.set(url, (p = fetchImage(url)));
    return p;
  };
  // Draw a 3×3 block of tiles (768 px) for one source, exact colours.
  const mosaic = async (urlFor: (tx: number, ty: number) => { url: string; crop?: [number, number, number] } | null) => {
    const c = createCanvas(768, 768);
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    let any = false;
    await Promise.all(
      [-1, 0, 1].flatMap((dy) =>
        [-1, 0, 1].map(async (dx) => {
          const ty = y + dy;
          if (ty < 0 || ty >= n) return;
          const tx = (((x + dx) % n) + n) % n;
          const u = urlFor(tx, ty);
          if (!u) return;
          const im = await img(u.url);
          if (!im) return;
          any = true;
          const ox = (dx + 1) * 256;
          const oy = (dy + 1) * 256;
          if (u.crop) ctx.drawImage(im, u.crop[0], u.crop[1], u.crop[2], u.crop[2], ox, oy, 256, 256);
          else ctx.drawImage(im, ox, oy, 256, 256);
        })
      )
    );
    if (!any) return null;
    return ctx.getImageData(256 - P, 256 - P, W, W).data;
  };

  const out = new Float32Array(W * W).fill(NaN);
  const [nx, rvd] = await Promise.all([
    inUS
      ? mosaic((tx, ty) => {
          const b = tileBox(tx, ty);
          if (!(b.e > -130 && b.w < -60 && b.n > 20 && b.s < 52)) return null;
          return { url: nexradUrl(Math.floor(t / 300_000) * 300_000, z, tx, ty) };
        })
      : Promise.resolve(null),
    rv && rvf
      ? mosaic((tx, ty) => {
          // RainViewer tiles stop at z7; deeper tiles crop the parent.
          const zz = Math.min(z, 7);
          const k = 2 ** (z - zz);
          return {
            url: `${rv.host}${rvf.path}/256/${zz}/${Math.floor(tx / k)}/${Math.floor(ty / k)}/2/0_1.png`,
            crop: k > 1 ? [(tx % k) * (256 / k), (ty % k) * (256 / k), 256 / k] : undefined,
          };
        })
      : Promise.resolve(null),
  ]);
  if (rvd) {
    const d = decodeDbzGrid(rvd, W, W);
    for (let i = 0; i < W * W; i++) out[i] = d[i];
  }
  if (nx) {
    for (let i = 0; i < W * W; i++) {
      const v = n0qDbz(nx[i * 4], nx[i * 4 + 1], nx[i * 4 + 2], nx[i * 4 + 3]);
      if (v > -32 && !(out[i] >= v)) out[i] = v;
      else if (Number.isNaN(out[i])) out[i] = -32;
    }
  }
  return nx || rvd ? out : null;
}

// WGS84, the ellipsoid OPERA's projection names — the same constants as
// operaRadar.ts, whose lonLatToGrid the function below reproduces.
const WGS84_A = 6378137;
const WGS84_E2 = (2 - 1 / 298.257223563) / 298.257223563;
const WGS84_E = Math.sqrt(WGS84_E2);
/** Snyder's q (the equal-area measure of a latitude), from sin(latitude). */
const authalicQ = (s: number) => (1 - WGS84_E2) * (s / (1 - WGS84_E2 * s * s) - Math.log((1 - WGS84_E * s) / (1 + WGS84_E * s)) / (2 * WGS84_E));
const AUTHALIC_QP = authalicQ(1);
const AUTHALIC_R = WGS84_A * Math.sqrt(AUTHALIC_QP / 2);
const DEG = Math.PI / 180;

/**
 * Where each of a tile's M × M pixel corners falls on the OPERA grid, in
 * block units (u = col / k − ½, v = row / k − ½; NaN = not on the map).
 *
 * The same projection as lonLatToGrid (operaRadar.ts: Snyder's ellipsoidal
 * Lambert azimuthal equal-area), rearranged for a map tile, where every
 * pixel in a row shares a latitude and every pixel in a column a longitude:
 * the logarithm and arcsine are done once per row, the sine and cosine once
 * per column, and a pixel costs one square root. Measured by the validator at
 * about 0.15 ms a tile against 5.5 ms for 65,536 calls of lonLatToGrid — which
 * was the largest single cost of a height tile after reading the file.
 *
 * lonLatToGrid stays the authority. The tile's four corners are computed
 * both ways on every call; if they ever differ by more than a millionth of
 * a cell (that projection was changed and this copy was not), the whole
 * tile is done with lonLatToGrid instead. The validator checks the two
 * agree over whole tiles.
 */
export function tileGridPositions(g: LaeaGrid, z: number, x: number, y: number, S: number, M: number, k: number, U: Float64Array, V: Float64Array): void {
  const slow = (i: number, j: number) => {
    const p = lonLatToGrid(tile2lon(x + i / S, z), tile2lat(y + j / S, z), g);
    return { u: p.col / k - 0.5, v: p.row / k - 0.5 };
  };
  const s1 = Math.sin(g.lat0 * DEG);
  const sb1 = authalicQ(s1) / AUTHALIC_QP;
  const cb1 = Math.sqrt(1 - sb1 * sb1);
  const D = (WGS84_A * (Math.cos(g.lat0 * DEG) / Math.sqrt(1 - WGS84_E2 * s1 * s1))) / (AUTHALIC_R * cb1);
  const sl = new Float64Array(M);
  const cl = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    const lam = (tile2lon(x + i / S, z) - g.lon0) * DEG;
    sl[i] = Math.sin(lam);
    cl[i] = Math.cos(lam);
  }
  const kx = 1 / (g.xscale * k);
  const ky = 1 / (g.yscale * k);
  for (let j = 0; j < M; j++) {
    const sb = authalicQ(Math.sin(tile2lat(y + j / S, z) * DEG)) / AUTHALIC_QP;
    const cb = Math.sqrt(Math.max(0, 1 - sb * sb));
    const P = 1 + sb1 * sb;
    const Q = cb1 * cb;
    const ya = cb1 * sb;
    const yb = sb1 * cb;
    for (let i = 0; i < M; i++) {
      const denom = P + Q * cl[i];
      const o = j * M + i;
      // Zero only at the point opposite the projection centre (see lonLatToLaea).
      if (denom <= 1e-9) {
        U[o] = V[o] = NaN;
        continue;
      }
      const B = AUTHALIC_R * Math.sqrt(2 / denom);
      U[o] = (B * D * cb * sl[i] + g.falseEasting - g.originX) * kx - 0.5;
      V[o] = (g.originY - ((B / D) * (ya - yb * cl[i]) + g.falseNorthing)) * ky - 0.5;
    }
  }
  for (const [i, j] of [[0, 0], [M - 1, 0], [0, M - 1], [M - 1, M - 1]]) {
    const t = slow(i, j);
    const o = j * M + i;
    const same = (a: number, b: number) => (Number.isFinite(a) ? Math.abs(a - b) * k <= 1e-6 : !Number.isFinite(b));
    if (same(t.u, U[o]) && same(t.v, V[o])) continue;
    for (let jj = 0; jj < M; jj++)
      for (let ii = 0; ii < M; ii++) {
        const q = slow(ii, jj);
        U[jj * M + ii] = q.u;
        V[jj * M + ii] = q.v;
      }
    return;
  }
}

/**
 * OPERA's part of the surface for one tile: the smoothed heights, read at
 * the tile's M × M pixel corners (M = S, or S + 1 with the far edge).
 *
 * Works on the radar's own grid, not on tile pixels:
 *   1. the cells within reach of the tile are read — pooled into k × k blocks
 *      when zoomed out (demPoolFactor), blocks counted from the grid's corner;
 *   2. each cell becomes a height (heightOfDbz), and a coverage of 1 if any
 *      radar scanned it, 0 if none did; a block holds the mean of each;
 *   3. both are smoothed with the Gaussian for this zoom (demSigmaKm), in
 *      grid cells — OPERA's grid is equal-area, so a cell is the same 1 km
 *      everywhere and the width needs no latitude correction;
 *   4. both are read at each pixel's exact position on the grid
 *      (tileGridPositions) with a cubic B-spline (bsplineWeights). The
 *      Gaussian is narrowed by the blur the spline adds, so the total is the
 *      stated width.
 * Every step is a fixed sum over fixed cells, so the value at a place does
 * not depend on which tile asked for it.
 *
 * @returns null when the tile is nowhere near the grid. Otherwise
 *   num — smoothed height × coverage per pixel (null: no rain in reach);
 *   cov — smoothed coverage per pixel (null: fully scanned, 1 everywhere).
 * `needCover` = another source has rain here, so the coverage matters even
 * where OPERA itself is dry (its "scanned, no rain" outranks their rain).
 */
function operaSurface(
  o: OperaFile,
  z: number,
  x: number,
  y: number,
  S: number,
  M: number,
  needCover: boolean
): { num: Float32Array | null; cov: Float32Array | null } | null {
  const g = o.grid;
  const cellKm = g.xscale / 1000;
  const k = demPoolFactor(z, cellKm);
  const sigma = demSigmaKm(z) / (k * cellKm);
  const kern = gaussianKernel(Math.sqrt(Math.max(0, sigma * sigma - BSPLINE_VARIANCE)));
  const R = (kern.length - 1) >> 1;
  const nbx = Math.ceil(g.cols / k);
  const nby = Math.ceil(g.rows / k);

  // Which blocks the tile reaches. Positions are in block units with block b
  // centred on b: u = col / k − ½. The extremes of a tile lie on its outline
  // (33 points an edge); the lattice inside is for the whole-world tiles,
  // whose outline is degenerate.
  const far = (M - 1) / S;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  const LAT = 32;
  for (let j = 0; j <= LAT; j++)
    for (let i = 0; i <= LAT; i++) {
      if (z > 2 && i > 0 && i < LAT && j > 0 && j < LAT) continue;
      const p = lonLatToGrid(tile2lon(x + (i / LAT) * far, z), tile2lat(y + (j / LAT) * far, z), g);
      const u = p.col / k - 0.5;
      const v = p.row / k - 0.5;
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
  if (!(u0 <= u1)) return null;
  // The window: the spline's 4 blocks, the kernel's reach, and a block or
  // more to spare for the bulge of the outline between the points sampled.
  // Past the grid everything is "no data", so it stops a kernel beyond it.
  const pad = 1 + Math.ceil(0.01 * Math.max(u1 - u0, v1 - v0));
  const halo = R + 3;
  const C0 = Math.max(-halo, Math.floor(u0) - 1 - R - pad);
  const C1 = Math.min(nbx + halo, Math.floor(u1) + 3 + R + pad);
  const R0 = Math.max(-halo, Math.floor(v0) - 1 - R - pad);
  const R1 = Math.min(nby + halo, Math.floor(v1) + 3 + R + pad);
  const bc0 = Math.max(0, C0), bc1 = Math.min(nbx, C1);
  const br0 = Math.max(0, R0), br1 = Math.min(nby, R1);
  if (bc1 <= bc0 || br1 <= br0) return null;
  const wc = C1 - C0;
  const wr = R1 - R0;

  const num = new Float32Array(wc * wr);
  const cov = new Float32Array(wc * wr);
  let wet = false;
  const { nodata, undetect, gain, offset } = o;
  const c0 = bc0 * k, c1 = Math.min(g.cols, bc1 * k);
  const r0 = br0 * k, r1 = Math.min(g.rows, br1 * k);
  if (k === 1 || o.readPooled) {
    // One value per block: the cell itself, or (the radar forecast, whose
    // cells are computed) the file's own thinning to every k-th cell.
    //
    // That thinning is the forecast's, not this file's, and it differs from
    // the branch below in one way that shows: it averages rain POWER over a
    // block where the branch below averages HEIGHT. So forecast tiles at
    // zoom 5 and wider (only those — from zoom 6 in k is 1) stand a little
    // high: measured on the forecast from 3 October 2026 19:45Z, +30 min, a
    // tile holds 3% more volume than its four children at zoom 5, 5% at
    // zoom 4, 9% at zoom 3, where observed tiles are within 0.3%. Reading
    // the forecast cell by cell instead brings that to within 0.4%, but
    // took 3× as long at zoom 5, 9× at zoom 4 and 18× at zoom 3 (1.8 s a
    // tile), so it is not done.
    // Neighbouring forecast tiles agree exactly (measured: 0.0 m at zoom
    // 3, 4 and 5) only because the forecast, too, counts its blocks from
    // the grid's corner (forecastWindow in nowcastAdvect.ts); this file
    // does its half by asking for windows that start on a multiple of k.
    const raw = k === 1 ? o.read(r0, r1, c0, c1) : o.readPooled!(r0, r1, c0, c1, k);
    const pc = bc1 - bc0;
    for (let br = br0; br < br1; br++) {
      const src = (br - br0) * pc - bc0;
      const dst = (br - R0) * wc - C0;
      for (let bc = bc0; bc < bc1; bc++) {
        const q = raw[src + bc];
        // nodata (or anything not a finite number) = outside every radar's
        // range; undetect = scanned, no rain.
        if (q === nodata || q - q !== 0) continue;
        cov[dst + bc] = 1;
        if (q === undetect) continue;
        const hgt = heightOfDbz(q * gain + offset);
        if (hgt > 0) {
          num[dst + bc] = hgt;
          wet = true;
        }
      }
    }
  } else {
    // Mean HEIGHT of each block's cells, and the share of them scanned.
    // One read for the whole window: the file is stored compressed in
    // chunks, and reading it in strips unpacked the same chunks again for
    // every strip (measured: 15 strips took 3× as long as one read).
    const fc = c1 - c0;
    const raw = o.read(r0, r1, c0, c1);
    const inv = 1 / (k * k);
    for (let br = br0; br < br1; br++) {
      const ra = br * k;
      const rb = Math.min(r1, ra + k);
      const dst = (br - R0) * wc - C0;
      for (let bc = bc0; bc < bc1; bc++) {
        const ca = bc * k;
        const cb = Math.min(c1, ca + k);
        let sum = 0;
        let seen = 0;
        for (let r = ra; r < rb; r++) {
          const src = (r - r0) * fc - c0;
          for (let c = ca; c < cb; c++) {
            const q = raw[src + c];
            if (q === nodata || q - q !== 0) continue;
            seen++;
            if (q !== undetect) sum += heightOfDbz(q * gain + offset);
          }
        }
        // Cells past the grid's own edge count as unscanned (÷ k², not ÷ seen).
        cov[dst + bc] = seen * inv;
        if (sum > 0) {
          num[dst + bc] = sum * inv;
          wet = true;
        }
      }
    }
  }
  // Scanned everywhere in reach: the coverage is 1 and need not be carried.
  let full = C0 >= 0 && R0 >= 0 && C1 <= nbx && R1 <= nby;
  if (full) for (let i = 0; i < cov.length; i++) if (cov[i] !== 1) { full = false; break; }
  if (!wet && (full || !needCover)) return { num: null, cov: null };

  const numS = wet ? gaussianBlur(num, wc, wr, kern) : null;
  const covS = full ? null : gaussianBlur(cov, wc, wr, kern);
  const outN = numS ? new Float32Array(M * M) : null;
  const outC = covS ? new Float32Array(M * M) : null;
  const wx = new Float64Array(4);
  const wy = new Float64Array(4);
  const U = new Float64Array(M * M);
  const V = new Float64Array(M * M);
  tileGridPositions(g, z, x, y, S, M, k, U, V);
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < M; i++) {
      const u = U[j * M + i];
      const v = V[j * M + i];
      // Whole-number part and remainder taken on the GRID, before the
      // window's origin comes into it — the same bits from any tile.
      const iu = Math.floor(u);
      const iv = Math.floor(v);
      const bx = iu - 1 - C0;
      const by = iv - 1 - R0;
      // Beyond the window = beyond the grid's reach: no data, left at 0.
      if (!(bx >= 0 && by >= 0 && bx + 3 < wc && by + 3 < wr)) continue;
      bsplineWeights(u - iu, wx);
      bsplineWeights(v - iv, wy);
      let sn = 0;
      let sc = 0;
      for (let a = 0; a < 4; a++) {
        const q = (by + a) * wc + bx;
        if (numS) sn += wy[a] * (wx[0] * numS[q] + wx[1] * numS[q + 1] + wx[2] * numS[q + 2] + wx[3] * numS[q + 3]);
        if (covS) sc += wy[a] * (wx[0] * covS[q] + wx[1] * covS[q + 1] + wx[2] * covS[q + 2] + wx[3] * covS[q + 3]);
      }
      if (outN) outN[j * M + i] = sn;
      if (outC) outC[j * M + i] = sc;
    }
  }
  return { num: outN, cov: outC };
}

/**
 * The heights for one tile, in metres, BEFORE the 3D view's exaggeration:
 * S × S values on the tile's pixel corners (see radarHeight.ts), or null for
 * a flat tile with no rain. Rain intensity, not cloud height.
 *
 * OPERA where it has scanned; `other` (NEXRAD / RainViewer, from
 * otherSourcesDbz) where it has not. Across the edge of OPERA's range the
 * two are mixed by OPERA's smoothed coverage (coverageShare): 85% OPERA at
 * its last scanned cell, half and half one smoothing width beyond, all the
 * other source — or the ground, if there is none — by about three. Inside
 * OPERA's range the other sources are ignored even where they show rain and
 * OPERA shows none: it scanned there, and its answer wins, as it does in the
 * colour tiles.
 *
 * `S` and `edge` exist for scripts/validate-dem.ts; the tiles served are
 * always 256 px without the far edge (MapLibre fills that in from the
 * neighbour, and its mesh takes one height per pixel of a 256 px tile — a
 * bigger tile would add no geometry).
 */
export function demHeights(
  o: OperaFile | null,
  z: number,
  x: number,
  y: number,
  other: Float32Array | null = null,
  S = 256,
  edge = false
): Float32Array | null {
  const M = S + (edge ? 1 : 0);
  // `other` is (256 + 2 × margin)² values; the margin is read off its size.
  const W = other ? Math.round(Math.sqrt(other.length)) : 0;
  const pix = other && W * W === other.length && W >= 256 && (W - 256) % 2 === 0 ? surfaceFromPixelDbz(other, 256, (W - 256) / 2, S, z, y, edge) : null;
  const op = o ? operaSurface(o, z, x, y, S, M, !!pix?.num) : null;
  if (op && !op.num && !op.cov) return null;
  if (!op?.num && !pix?.num) return null;
  const out = new Float32Array(M * M);
  for (let i = 0; i < M * M; i++) {
    // OPERA's height, already scaled by how far it is trusted here…
    const cA = op ? (op.cov ? op.cov[i] : 1) : 0;
    let h = op?.num ? coveredHeight(op.num[i], cA) : 0;
    // …and the other source's for the rest.
    if (cA < 1 && pix?.num) h += (1 - coverageShare(cA)) * coveredHeight(pix.num[i], pix.cov ? pix.cov[i] : 1);
    out[i] = h;
  }
  return out;
}

/** A tile with no rain is the same PNG every time; it is encoded once. */
let flatDemPng: Buffer | null = null;

/**
 * The height tile (terrain-RGB PNG, 256 px) from any dBZ source — a real
 * composite, or the radar forecast — see demHeights.
 */
export function renderDemFrom(o: OperaFile | null, z: number, x: number, y: number, other: Float32Array | null = null): Buffer {
  const S = 256;
  const h = demHeights(o, z, x, y, other, S);
  if (!h && flatDemPng) return flatDemPng;
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(S, S);
  encodeTerrainRgb(h ?? new Float32Array(S * S), img.data);
  ctx.putImageData(img, 0, 0);
  const buf = canvas.toBuffer("image/png");
  if (!h) flatDemPng = buf;
  return buf;
}

/** Start downloading every frame's file now, so tiles are ready sooner. */
export function warmOpera(times: number[]) {
  // The newest file ALONE first — it is the picture on screen while the page
  // loads — then the rest. Started together, three downloads shared the
  // bandwidth and the live frame took ~3× as long to appear.
  const ts = [...times].reverse().map((t) => Math.floor(t / 300_000) * 300_000);
  if (!ts.length) return Promise.resolve();
  return opera(ts[0])
    .catch(() => null)
    .then(() => Promise.all(ts.slice(1).map((t) => opera(t).catch(() => null))))
    .then(() => undefined);
}

/**
 * The newest OPERA composite that has actually been published — checked,
 * not assumed. Publication lag varies (7 to 20+ minutes), and a timeline
 * ending on a frame that does not exist yet shows an empty map as "now".
 */
let latestCache: { at: number; t: number } | null = null;
export async function latestOperaTime(now = Date.now()): Promise<number> {
  if (latestCache && now - latestCache.at < 60_000) return latestCache.t;
  // All 12 candidates checked AT ONCE, newest wins. One after another this
  // took up to ~2.3 s — and every page load waited on it before the first
  // radar tile was even requested.
  const first = Math.floor((now - 5 * 60_000) / 300_000) * 300_000;
  const cands = Array.from({ length: 12 }, (_, i) => first - i * 300_000);
  const ok = await Promise.all(
    cands.map((t) =>
      fetch(operaUrl(t), { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(8000) })
        .then((r) => r.ok)
        .catch(() => false)
    )
  );
  const i = ok.indexOf(true);
  if (i >= 0) {
    latestCache = { at: now, t: cands[i] };
    return cands[i];
  }
  return Math.floor((now - 20 * 60_000) / 300_000) * 300_000;
}

/** Frame times for an N-hour history, newest last, ending on the newest published composite. */
export function historyTimes(hours: number, stepMin: number, latest: number): number[] {
  // On fixed clock steps (:00/:30 for 30-min steps, …), not counted back from the
  // newest picture: counted back, every new picture (each 5 min) shifted the WHOLE
  // list to times nobody had asked for, so the 24 h loop was drawn afresh for
  // nearly every visitor. Fixed, only the newest frame is ever new.
  const step = stepMin * 60_000;
  const last = Math.floor(latest / step) * step;
  const out: number[] = [];
  for (let t = last - hours * 3_600_000; t <= last; t += step) out.push(t);
  if (out[out.length - 1] !== latest) out.push(latest);
  return out;
}
