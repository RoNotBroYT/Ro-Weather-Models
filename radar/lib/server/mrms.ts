// NOAA MRMS radar mosaic for the USA — the replacement for the Iowa NEXRAD
// picture tiles.
//
//   product   MergedReflectivityQCComposite (max reflectivity in the column,
//             quality-controlled, all US radars merged) — the same quantity
//             OPERA's composite is, so the two are drawn by the same code
//   grid      0.01° lat/lon (~1 km), 7000 × 3500, 20–55 °N, 130–60 °W
//   cadence   every 2 minutes, published ~40 s after the scan
//   source    noaa-mrms-pds on AWS (NOAA open data, public domain)
//
// The file is GRIB2 with PNG packing (data template 5.41), which the general
// reader in grib2.ts does not do (and its Float64 working copy would be 200 MB
// here). So this file reads it directly: the 16-bit grey PNG is inflated and
// unfiltered by hand, and each cell kept as ONE byte —
//   0     no echo (dry, inside radar range)
//   255   no data (outside every radar's range: leave what is underneath)
//   1–254 dBZ = code / 2 − 32
// 24.5 MB per picture instead of ~100 MB as floats.

import { inflateSync, gunzipSync } from "zlib";

const BUCKET = "https://noaa-mrms-pds.s3.amazonaws.com";
const PRODUCT = "CONUS/MergedReflectivityQCComposite_00.50";
const NODATA = 255;

export interface MrmsField {
  time: number;
  /** dBZ per output pixel of a Web-Mercator tile (NaN = no data), as OPERA's sampler gives. */
  sample: (west: number, east: number, north: number, south: number, S: number) => Float32Array;
}

interface Grid { lat0: number; lon0: number; d: number; ni: number; nj: number; cells: Uint8Array }

// ---- Which files exist (one S3 listing per day, refreshed each minute) ----
type G = { __mrmsList?: Map<string, { at: number; times: number[] }>; __mrmsFiles?: Map<number, Promise<Grid | null>> };
const g = globalThis as unknown as G;
const lists = (g.__mrmsList ??= new Map());
const files = (g.__mrmsFiles ??= new Map());

async function dayTimes(day: string): Promise<number[]> {
  const hit = lists.get(day);
  if (hit && Date.now() - hit.at < 60_000) return hit.times;
  const times: number[] = [];
  let after = "";
  for (let page = 0; page < 3; page++) {
    const url = `${BUCKET}/?list-type=2&prefix=${PRODUCT}/${day}/${after ? `&start-after=${encodeURIComponent(after)}` : ""}`;
    const xml = await fetch(url, { signal: AbortSignal.timeout(15_000) }).then((r) => r.text());
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    for (const k of keys) {
      const m = k.match(/_(\d{8})-(\d{2})(\d{2})(\d{2})\.grib2\.gz$/);
      if (m) times.push(Date.UTC(+m[1].slice(0, 4), +m[1].slice(4, 6) - 1, +m[1].slice(6, 8), +m[2], +m[3], +m[4]));
    }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !keys.length) break;
    after = keys[keys.length - 1];
  }
  times.sort((a, b) => a - b);
  lists.set(day, { at: Date.now(), times });
  return times;
}

const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");

/** The newest MRMS picture at or before t (within 6 minutes), or null. */
async function fileFor(t: number): Promise<number | null> {
  const times = [...(await dayTimes(dayOf(t - 6 * 60_000)).catch(() => [])), ...(dayOf(t) !== dayOf(t - 6 * 60_000) ? await dayTimes(dayOf(t)).catch(() => []) : [])];
  let best: number | null = null;
  for (const ft of times) if (ft <= t + 30_000 && ft >= t - 6 * 60_000) best = ft;
  return best;
}

// ---- Reading one file ----
function readGrid(gz: Buffer): Grid {
  const buf = gunzipSync(gz);
  let o = 16, lat0 = 0, lon0 = 0, d = 0.01, ni = 0, nj = 0, R = 0, E = 0, D = 0;
  let png: Buffer | null = null;
  while (o < buf.length - 4 && buf.toString("latin1", o, o + 4) !== "7777") {
    const len = buf.readUInt32BE(o), num = buf[o + 4];
    const sec = buf.subarray(o, o + len);
    if (num === 3) {
      ni = sec.readUInt32BE(30);
      nj = sec.readUInt32BE(34);
      lat0 = sec.readInt32BE(46) / 1e6;
      lon0 = sec.readUInt32BE(50) / 1e6;
      if (lon0 > 180) lon0 -= 360;
      d = sec.readUInt32BE(63) / 1e6;
    } else if (num === 5) {
      if (sec.readUInt16BE(9) !== 41) throw new Error(`MRMS: data template 5.${sec.readUInt16BE(9)}, expected PNG (5.41)`);
      R = sec.readFloatBE(11);
      E = sec.readInt16BE(15);
      D = sec.readInt16BE(17);
    } else if (num === 7) png = sec.subarray(5);
    o += len;
  }
  if (!png || !ni) throw new Error("MRMS: incomplete GRIB2");
  // PNG: IHDR, IDAT chunks; 16-bit grey, filtered scanlines.
  let p = 8, w = 0, h = 0, depth = 0;
  const idat: Buffer[] = [];
  while (p < png.length) {
    const len = png.readUInt32BE(p), type = png.toString("latin1", p + 4, p + 8);
    const body = png.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; }
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (depth !== 16 || w !== ni || h !== nj) throw new Error(`MRMS: unexpected PNG ${w}×${h}×${depth}`);
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 2, stride = w * bpp;
  const cells = new Uint8Array(w * h);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  const k2 = 2 ** E, k10 = 10 ** D;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const dbz = (R + ((cur[x * 2] << 8) | cur[x * 2 + 1]) * k2) / k10;
      // −999 = outside radar range; −99 (and anything this low) = no echo.
      cells[y * w + x] = dbz <= -500 ? NODATA : dbz < -31.5 ? 0 : Math.min(254, Math.max(1, Math.round((dbz + 32) * 2)));
    }
    const t = prev; prev = cur; cur = t;
  }
  return { lat0, lon0, d, ni, nj, cells };
}

async function loadGrid(ft: number): Promise<Grid | null> {
  let pr = files.get(ft);
  if (!pr) {
    const s = new Date(ft).toISOString();
    const name = `MRMS_MergedReflectivityQCComposite_00.50_${s.slice(0, 10).replace(/-/g, "")}-${s.slice(11, 19).replace(/:/g, "")}.grib2.gz`;
    pr = fetch(`${BUCKET}/${PRODUCT}/${dayOf(ft)}/${name}`, { signal: AbortSignal.timeout(30_000) })
      .then(async (r) => (r.ok ? readGrid(Buffer.from(await r.arrayBuffer())) : null))
      .catch((e) => (console.warn("[mrms]", e), null));
    files.set(ft, pr);
    // Keep the newest few (each ~25 MB).
    while (files.size > 4) files.delete(files.keys().next().value!);
  }
  return pr;
}

/** MRMS rain at radar time t (the newest picture at or before it), or null if none. */
export async function mrms(t: number): Promise<MrmsField | null> {
  const ft = await fileFor(t);
  if (ft == null) return null;
  const grid = await loadGrid(ft);
  if (!grid) return null;
  return { time: ft, sample: (w, e, n, s, S) => sampleGrid(grid, w, e, n, s, S) };
}

/** dBZ per pixel of a Mercator tile; zoomed out, each pixel is the power average of the cells it covers. */
function sampleGrid(gr: Grid, west: number, east: number, north: number, south: number, S: number): Float32Array {
  const out = new Float32Array(S * S).fill(NaN);
  const yN = Math.log(Math.tan(Math.PI / 4 + (north * Math.PI) / 360));
  const yS = Math.log(Math.tan(Math.PI / 4 + (south * Math.PI) / 360));
  const cellsPerPx = (east - west) / S / gr.d;
  const k = Math.max(1, Math.min(8, Math.round(cellsPerPx)));
  const step = Math.max(1, Math.round(cellsPerPx / k)); // stride inside the block when very zoomed out
  for (let py = 0; py < S; py++) {
    const lat = (Math.atan(Math.sinh(yN + ((yS - yN) * (py + 0.5)) / S)) * 180) / Math.PI;
    const j0 = Math.floor((gr.lat0 - lat) / gr.d - (k * step) / 2);
    if (j0 + k * step < 0 || j0 >= gr.nj) continue;
    for (let px = 0; px < S; px++) {
      const lon = west + ((east - west) * (px + 0.5)) / S;
      const i0 = Math.floor((lon - gr.lon0) / gr.d - (k * step) / 2);
      if (i0 + k * step < 0 || i0 >= gr.ni) continue;
      let z = 0, n = 0, dry = 0;
      for (let a = 0; a < k; a++) {
        const j = j0 + a * step;
        if (j < 0 || j >= gr.nj) continue;
        for (let b = 0; b < k; b++) {
          const i = i0 + b * step;
          if (i < 0 || i >= gr.ni) continue;
          const c = gr.cells[j * gr.ni + i];
          if (c === NODATA) continue;
          if (c === 0) dry++;
          else z += Math.pow(10, (c / 2 - 32) / 10);
          n++;
        }
      }
      if (!n) continue;
      // Rain power averaged over the block (dry cells count as nothing), as OPERA's zoomed-out tiles do.
      out[py * S + px] = z > 0 ? (10 * Math.log10(z / n)) : (dry ? -32 : NaN);
    }
  }
  return out;
}
