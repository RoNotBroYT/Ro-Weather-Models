/**
 * Rain from space, whole world: NOAA "Enterprise Rain Rate" global blend
 * (RRQPE-INST-GLB, NOAA/NESDIS, public on AWS, no login).
 *
 * WHAT IT IS
 *   Instantaneous rain rate (mm/h) estimated from the infrared channels of
 *   FIVE geostationary satellites (GOES-East, GOES-West, Meteosat ×2,
 *   Himawari), calibrated against microwave rain measurements, merged onto
 *   one 0.02° (~2 km) latitude/longitude grid covering 70°N–60°S, all
 *   longitudes.
 * TIMING
 *   One picture per 10-minute slot (scans taken between slot start and
 *   slot start + 10 min). NOAA first publishes a slot ~13 min after it
 *   starts with only the GOES satellites in it, then republishes it complete
 *   ~20-30 min after it starts. We only use the COMPLETE version of a slot
 *   (all five satellites), so the newest picture is ~20-30 min old, and
 *   Europe/Asia never flicker in and out of the loop.
 * WHAT IT IS NOT
 *   Not radar. A satellite estimate from cloud tops: it places heavy rain
 *   under deep storm cloud well, but misses some light rain and can smear
 *   rain across thick anvil cloud. Ground radar is drawn on top where it exists.
 */
import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { MIN_RAIN_MM, DVORAK_LUT as LUT, dvorakLutIndex } from "./rainColour";
import { cacheLimit } from "./localBoost";

const BUCKET = "https://noaa-enterprise-rainrate-pds.s3.amazonaws.com";
const PREFIX = "BLEND/RainRate-Blend-INST";
const ROWS = 6501; // 70°N (row 0) → 60°S, 0.02°
const COLS = 18000; // 180°W (col 0) → 179.98°E, 0.02°
const LAT0 = 70;
const RES = 0.02;
const SCALE = 0.1; // mm/h per count
const FILL = -9990;
const SLOT = 10 * 60_000;
const ALL_INPUTS = ["GOES-19", "GOES-18", "Himawari-9", "Meteosat-9", "Meteosat-10"];

export interface RainFrame {
  /** Slot start, UTC ms. Scans in the picture were taken from t to t + 10 min. */
  t: number;
  key: string;
  /** Satellites missing from this picture (empty = all five present). */
  missing: string[];
}

type H5File = import("h5wasm").File;
const g = globalThis as unknown as {
  __rwGRList?: { at: number; frames: RainFrame[] };
  __rwGRHour?: Map<string, [number, string, string][]>;
  __rwGRFiles?: Map<string, Promise<{ file: H5File; missing: string[] } | null>>;
  __rwGRTiles?: Map<string, Buffer>;
};
const files = (g.__rwGRFiles ??= new Map());
const tiles = (g.__rwGRTiles ??= new Map());

let h5Promise: Promise<typeof import("h5wasm/node")> | null = null;
async function h5() {
  h5Promise ??= (async () => {
    const mod = await import("h5wasm/node");
    await mod.ready;
    return mod;
  })();
  return h5Promise;
}

/** The file for a key, opened (kept on local disk; ~3 MB each; last 24 kept). */
function open(key: string): Promise<{ file: H5File; missing: string[] } | null> {
  let p = files.get(key);
  if (!p) {
    p = (async () => {
      const r = await fetch(`${BUCKET}/${key}`, { cache: "no-store" });
      if (!r.ok) return null;
      const tmp = path.join(os.tmpdir(), `rw-grain-${path.basename(key)}`);
      await fsp.writeFile(tmp, Buffer.from(await r.arrayBuffer()));
      const { File } = await h5();
      const file = new File(tmp, "r");
      let missing: string[] = [];
      try {
        const m = file.get("MonitoringMetaData") as unknown as { attrs: Record<string, { value: unknown }> };
        const v = m.attrs["Missing_Inputs"]?.value;
        if (typeof v === "string" && v.trim()) missing = v.trim().split(/\s+/).map(nameOf);
      } catch {
        /* metadata unreadable: treat as complete */
      }
      return { file, missing };
    })().catch(() => null);
    files.set(key, p);
    while (files.size > cacheLimit(24, files.size)) {
      const old = files.keys().next().value!;
      const op = files.get(old);
      files.delete(old);
      void op?.then((o: { file: H5File } | null) => {
        try {
          o?.file.close();
        } catch {
          /* already closed */
        }
        return fsp.rm(path.join(os.tmpdir(), `rw-grain-${path.basename(old)}`), { force: true });
      });
    }
  }
  return p;
}
const nameOf = (s: string) => s.replace(/-0?(\d+)$/, "-$1").replace(/^METEOSAT/i, "Meteosat");

/**
 * Newest complete frames, oldest first. A slot counts once NOAA has
 * republished it with all five satellites; if none is complete in the last
 * 40 min (an outage), the newest partial ones are used and say what's missing.
 */
export async function rainFrames(count = 7): Promise<RainFrame[]> {
  const hit = g.__rwGRList;
  if (hit && Date.now() - hit.at < 2 * 60_000) return hit.frames.slice(-count);
  const latest = new Map<number, { key: string; c: string }>();
  for (let h = 3; h >= 0; h--) {
    const d = new Date(Date.now() - h * 3600_000);
    const pre = `${PREFIX}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCHours()).padStart(2, "0")}/`;
    try {
      const xml = await (await fetch(`${BUCKET}/?list-type=2&prefix=${pre}`, { cache: "no-store" })).text();
      for (const m of xml.matchAll(/<Key>([^<]+_s(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\d*_e\d+_c(\d+)\.nc)<\/Key>/g)) {
        const t = Date.UTC(+m[2], +m[3] - 1, +m[4], +m[5], +m[6]);
        const slot = Math.floor(t / SLOT) * SLOT;
        const prev = latest.get(slot);
        if (!prev || m[7] > prev.c) latest.set(slot, { key: m[1], c: m[7] });
      }
    } catch {
      /* next hour */
    }
  }
  const slots = [...latest.entries()].sort((a, b) => a[0] - b[0]).slice(-(count + 4));
  const opened = await Promise.all(slots.map(async ([t, v]) => ({ t, key: v.key, missing: (await open(v.key))?.missing ?? ALL_INPUTS })));
  const complete = opened.filter((f) => f.missing.length === 0);
  const newestComplete = complete.at(-1)?.t ?? 0;
  const frames = Date.now() - newestComplete < 40 * 60_000 ? complete : opened.filter((f) => f.missing.length < ALL_INPUTS.length);
  g.__rwGRList = { at: Date.now(), frames };
  return frames.slice(-count);
}

// ---- drawing -------------------------------------------------------------------
// Colour scale (Dvorak "BD curve" style, mm/h) lives in rainColour.ts, shared
// with tomorrowRain.ts so both sources paint the exact same scale.
const TILE = 256;

/** One 256 px web-mercator tile (z/x/y) of a frame; transparent where dry. */
export async function rainTile(key: string, z: number, x: number, y: number): Promise<Buffer | null> {
  const id = `${key}|${z}/${x}/${y}`;
  const hit = tiles.get(id);
  if (hit) return hit;
  const o = await open(key);
  if (!o) return null;
  const n = 2 ** z;
  const lonW = (x / n) * 360 - 180;
  const lonE = ((x + 1) / n) * 360 - 180;
  const latOf = (my: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;
  const latN = latOf(y / n);
  const latS = latOf((y + 1) / n);
  const canvas = createCanvas(TILE, TILE);
  const ctx = canvas.getContext("2d");
  if (latS >= LAT0 || latN <= LAT0 - (ROWS - 1) * RES) return done(id, canvas);

  // Grid window this tile needs (+1 cell margin for blending), and a stride
  // at low zoom so we read ~1-2 grid cells per output pixel, not millions.
  const degPerPx = (lonE - lonW) / TILE;
  const step = Math.max(1, Math.floor(degPerPx / RES / 1.5));
  const r0 = clamp(Math.floor((LAT0 - latN) / RES) - step, 0, ROWS - 1);
  const r1 = clamp(Math.ceil((LAT0 - latS) / RES) + step, 0, ROWS - 1);
  const c0 = clamp(Math.floor((lonW + 180) / RES) - step, 0, COLS - 1);
  const c1 = clamp(Math.ceil((lonE + 180) / RES) + step, 0, COLS - 1);
  const ds = o.file.get("RRQPE") as unknown as { slice: (r: [number, number, number?][]) => Int16Array };
  const data = ds.slice([
    [r0, r1 + 1, step],
    [c0, c1 + 1, step],
  ]);
  const h = Math.floor((r1 - r0) / step) + 1;
  const w = Math.floor((c1 - c0) / step) + 1;
  const mmAt = (r: number, c: number) => {
    const v = data[r * w + c];
    return v === FILL || v <= 0 ? 0 : v * SCALE;
  };

  const img = ctx.createImageData(TILE, TILE);
  let any = false;
  for (let py = 0; py < TILE; py++) {
    const lat = latOf((y + (py + 0.5) / TILE) / n);
    const fr = ((LAT0 - lat) / RES - r0) / step;
    const ri = Math.floor(fr);
    if (ri < 0 || ri >= h - 1) continue;
    const ty = fr - ri;
    for (let px = 0; px < TILE; px++) {
      const lon = lonW + (px + 0.5) * degPerPx;
      const fc = ((lon + 180) / RES - c0) / step;
      const ci = Math.floor(fc);
      if (ci < 0 || ci >= w - 1) continue;
      const tx = fc - ci;
      // Bilinear blend of the 4 nearest cells: smooth close-ups, not 2 km blocks.
      const mm =
        (mmAt(ri, ci) * (1 - tx) + mmAt(ri, ci + 1) * tx) * (1 - ty) + (mmAt(ri + 1, ci) * (1 - tx) + mmAt(ri + 1, ci + 1) * tx) * ty;
      if (mm < MIN_RAIN_MM) continue;
      const k = dvorakLutIndex(mm);
      const q = (py * TILE + px) * 4;
      img.data[q] = LUT[k * 4];
      img.data[q + 1] = LUT[k * 4 + 1];
      img.data[q + 2] = LUT[k * 4 + 2];
      img.data[q + 3] = LUT[k * 4 + 3];
      any = true;
    }
  }
  if (any) ctx.putImageData(img, 0, 0);
  return done(id, canvas);
}

function done(id: string, canvas: Canvas): Buffer {
  const buf = canvas.toBuffer("image/png");
  tiles.set(id, buf);
  while (tiles.size > cacheLimit(4000, tiles.size)) tiles.delete(tiles.keys().next().value!);
  return buf;
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ---- as a rain field for the radar tiles ----------------------------------------
// The same picture read as dBZ (Marshall–Palmer, Z = 200 R^1.6) so the radar
// tiles can draw it with their own code and colours wherever no ground radar
// reaches. NaN outside the satellites' view (70°N–60°S), −32 where dry.

/** The newest picture whose slot started at or before t (within 45 min: NOAA publishes 20–30 min late). */
async function keyFor(t: number): Promise<string | null> {
  const slotT = Math.floor(t / SLOT) * SLOT;
  // Recent: the checked list (complete slots only). Older: that hour's own listing.
  if (Date.now() - t < 3 * 3600_000) {
    const fr = (await rainFrames(30)).filter((f) => f.t <= slotT && slotT - f.t <= 45 * 60_000).pop();
    return fr?.key ?? null;
  }
  const d = new Date(slotT);
  const pre = `${PREFIX}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCHours()).padStart(2, "0")}/`;
  const hit = g.__rwGRHour?.get(pre);
  let keys: [number, string, string][];
  if (hit) keys = hit;
  else {
    const xml = await (await fetch(`${BUCKET}/?list-type=2&prefix=${pre}`, { cache: "no-store" })).text().catch(() => "");
    keys = [...xml.matchAll(/<Key>([^<]+_s(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\d*_e\d+_c(\d+)\.nc)<\/Key>/g)].map((m) => [
      Math.floor(Date.UTC(+m[2], +m[3] - 1, +m[4], +m[5], +m[6]) / SLOT) * SLOT,
      m[7],
      m[1],
    ]);
    (g.__rwGRHour ??= new Map()).set(pre, keys);
    while (g.__rwGRHour.size > 30) g.__rwGRHour.delete(g.__rwGRHour.keys().next().value!);
  }
  // The slot itself, its latest republication (the complete one).
  const same = keys.filter(([s]) => s === slotT).sort((a, b) => (a[1] < b[1] ? -1 : 1));
  return same.at(-1)?.[2] ?? null;
}

export interface SatRainField {
  time: number;
  sample: (west: number, east: number, north: number, south: number, S: number) => Float32Array;
}

/** Satellite rain for one radar time, sampled like the radar sources (dBZ per pixel). */
export async function satRainField(t: number): Promise<SatRainField | null> {
  const key = await keyFor(t).catch(() => null);
  if (!key) return null;
  const o = await open(key);
  if (!o) return null;
  const ds = o.file.get("RRQPE") as unknown as { slice: (r: [number, number, number?][]) => Int16Array };
  const m = key.match(/_s(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/)!;
  const time = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return {
    time,
    sample: (west, east, north, south, S) => {
      const out = new Float32Array(S * S).fill(NaN);
      if (south >= LAT0 || north <= LAT0 - (ROWS - 1) * RES) return out;
      const degPerPx = (east - west) / S;
      const step = Math.max(1, Math.floor(degPerPx / RES / 1.5));
      const r0 = clamp(Math.floor((LAT0 - north) / RES) - step, 0, ROWS - 1);
      const r1 = clamp(Math.ceil((LAT0 - south) / RES) + step, 0, ROWS - 1);
      const c0 = clamp(Math.floor((west + 180) / RES) - step, 0, COLS - 1);
      const c1 = clamp(Math.ceil((east + 180) / RES) + step, 0, COLS - 1);
      const data = ds.slice([[r0, r1 + 1, step], [c0, c1 + 1, step]]);
      const h = Math.floor((r1 - r0) / step) + 1, w = Math.floor((c1 - c0) / step) + 1;
      const yN = Math.log(Math.tan(Math.PI / 4 + (north * Math.PI) / 360));
      const yS = Math.log(Math.tan(Math.PI / 4 + (south * Math.PI) / 360));
      const mm = (r: number, c: number) => {
        const v = data[r * w + c];
        return v === FILL ? NaN : v <= 0 ? 0 : v * SCALE;
      };
      for (let py = 0; py < S; py++) {
        const lat = (Math.atan(Math.sinh(yN + ((yS - yN) * (py + 0.5)) / S)) * 180) / Math.PI;
        const fr = ((LAT0 - lat) / RES - r0) / step;
        const ri = Math.floor(fr);
        if (ri < 0 || ri >= h - 1) continue;
        const ty = fr - ri;
        for (let px = 0; px < S; px++) {
          const fc = ((west + (px + 0.5) * degPerPx + 180) / RES - c0) / step;
          const ci = Math.floor(fc);
          if (ci < 0 || ci >= w - 1) continue;
          const tx = fc - ci;
          const a = mm(ri, ci), b = mm(ri, ci + 1), c = mm(ri + 1, ci), d = mm(ri + 1, ci + 1);
          if (Number.isNaN(a + b + c + d)) continue;
          const r = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
          out[py * S + px] = r < MIN_RAIN_MM ? -32 : 10 * Math.log10(200 * Math.pow(r, 1.6));
        }
      }
      return out;
    },
  };
}
