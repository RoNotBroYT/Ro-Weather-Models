// Rain, sleet or snow for the radar, done properly (17 Nov): the WET-BULB temperature near the
// ground (how cold falling rain or snow ends up: air temperature and humidity together), from
// DWD's ICON-EU model (free open data, ~7 km, hourly), corrected for the real height of the ground
// (free height maps, ~350 m over Great Britain and Ireland, ~1.5 km for Europe: snow sits on the fells,
// the valleys get rain), and against the model's own snow line, then nudged towards what the airports report right now (METAR, every 30 min: their own
// temperature and dew point, and whether they see snow, sleet or rain).
//   wet-bulb ≤ 0.5 °C → snow;  ≤ 1.5 °C → sleet (mix);  above → rain.
// Needs ecCodes' grib_get_data (installed by the GitHub job). Anything missing → null, and the
// older GFS temperature rule is used instead.
import { execFileSync } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { loadImage, createCanvas } from "@napi-rs/canvas";

const LAT0 = 29.5, LON0 = -23.5, D = 0.0625, NY = 657, NX = 1377;   // ICON-EU's regular grid
export interface WetBulbField {
  tw: Float32Array;          // model wet-bulb at the model's own ground height, °C
  hs: Float32Array;          // the model's ground height, m
  sl?: Float32Array;         // ICON-EU's snowfall limit, m above sea level (25 Nov), smoothed (27 Nov)
  slw?: Float32Array;        // how much of the area around has a snow line at all, 0..1 (27 Nov)
  fix: { lat: number; lon: number; d: number; snow?: boolean; rain?: boolean }[];   // airport corrections
}

const GRIB = process.env.GRIB_GET_DATA || "grib_get_data";
async function grib(url: string): Promise<Float32Array | null> {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) }).catch(() => null);
  if (!r?.ok) return null;
  const base = path.join(os.tmpdir(), `icon-${Math.random().toString(36).slice(2)}.grib2`);
  await fs.writeFile(base + ".bz2", Buffer.from(await r.arrayBuffer()));
  try {
    execFileSync("bunzip2", ["-f", base + ".bz2"]);
    const txt = execFileSync(GRIB, ["-w", "count=1", base], { maxBuffer: 400 * 1024 * 1024 }).toString();
    const out = new Float32Array(NY * NX).fill(NaN);
    for (const line of txt.split("\n")) {
      const p = line.trim().split(/\s+/);
      if (p.length < 3) continue;
      const la = +p[0], lo = +p[1], v = +p[2];
      const y = Math.round((la - LAT0) / D), x = Math.round((lo - LON0) / D);
      if (y >= 0 && y < NY && x >= 0 && x < NX && Number.isFinite(v)) out[y * NX + x] = v;
    }
    return out;
  } catch (e) {
    console.warn("[wetbulb] grib", String(e).slice(0, 160));
    return null;
  } finally {
    await fs.unlink(base).catch(() => {});
  }
}

/** Wet-bulb °C from air temperature and dew point (°C), Stull 2011 via relative humidity. */
export function wetBulb(t: number, td: number): number {
  const es = (x: number) => 6.112 * Math.exp((17.62 * x) / (243.12 + x));
  const rh = Math.max(1, Math.min(100, (100 * es(td)) / es(t)));
  return t * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) + Math.atan(t + rh) - Math.atan(rh - 1.676331)
    + 0.00391838 * rh ** 1.5 * Math.atan(0.023101 * rh) - 4.686035;
}

// --- The ground (25 Nov: was one 2.4 km map of GB+Ireland read square by square, so snow came out in blocks).
// AWS's free Terrarium heights, read smoothly (blended between points): Great Britain and Ireland at zoom 8
// (~350 m), the rest of Europe at zoom 6 (~1.5 km). Kept on disk between runs (the GitHub job caches the folder).
type Dem = { z: number; x0: number; y0: number; nx: number; ny: number; h: Float32Array };
const dems: Dem[] = [];
let demLoading: Promise<void> | null = null;
const DEM_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "../../dem-cache");
const tileX = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const tileY = (lat: number, z: number) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
async function loadArea(name: string, z: number, w: number, e: number, s: number, n: number): Promise<Dem> {
  const x0 = tileX(w, z), x1 = tileX(e, z), y0 = tileY(n, z), y1 = tileY(s, z);
  const nx = (x1 - x0 + 1) * 256, ny = (y1 - y0 + 1) * 256, file = path.join(DEM_DIR, `${name}-z${z}.bin`);
  const saved = await fs.readFile(file).catch(() => null);
  if (saved && saved.byteLength === nx * ny * 4) return { z, x0, y0, nx, ny, h: new Float32Array(saved.buffer, saved.byteOffset, nx * ny) };
  const h = new Float32Array(nx * ny).fill(NaN);
  const tiles = Array.from({ length: (x1 - x0 + 1) * (y1 - y0 + 1) }, (_, i) => [x0 + (i % (x1 - x0 + 1)), y0 + Math.floor(i / (x1 - x0 + 1))]);
  let next = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (next < tiles.length) {
      const [tx, ty] = tiles[next++];
      const r = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${tx}/${ty}.png`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
      if (!r?.ok) continue;
      const img = await loadImage(Buffer.from(await r.arrayBuffer()));
      const c = createCanvas(256, 256), cx = c.getContext("2d");
      cx.drawImage(img, 0, 0);
      const data = cx.getImageData(0, 0, 256, 256).data;
      for (let py = 0; py < 256; py++) for (let px = 0; px < 256; px++) {
        const o = (py * 256 + px) * 4, v = data[o] * 256 + data[o + 1] + data[o + 2] / 256 - 32768;
        h[((ty - y0) * 256 + py) * nx + (tx - x0) * 256 + px] = v < 0 ? 0 : v;   // sea and below: 0
      }
    }
  }));
  await fs.mkdir(DEM_DIR, { recursive: true }).catch(() => {});
  await fs.writeFile(file, Buffer.from(h.buffer)).catch(() => {});
  return { z, x0, y0, nx, ny, h };
}
async function loadDem() {
  const t0 = Date.now();
  dems.push(await loadArea("gbie", 8, -11, 2, 49.5, 61));
  dems.push(await loadArea("europe", 6, -25, 45, 34, 72));
  console.log(`[wetbulb] ground heights ready in ${Math.round((Date.now() - t0) / 1000)} s`);
}
function groundAt(lat: number, lon: number): number {
  for (const d of dems) {
    const n = 2 ** d.z * 256, r = (lat * Math.PI) / 180;
    const px = ((lon + 180) / 360) * n - d.x0 * 256 - 0.5;
    const py = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n - d.y0 * 256 - 0.5;
    const ix = Math.floor(px), iy = Math.floor(py);
    if (ix < 0 || iy < 0 || ix >= d.nx - 1 || iy >= d.ny - 1) continue;
    const tx = px - ix, ty = py - iy, v = (j: number, i: number) => d.h[(iy + j) * d.nx + ix + i];
    const g = (v(0, 0) * (1 - tx) + v(0, 1) * tx) * (1 - ty) + (v(1, 0) * (1 - tx) + v(1, 1) * tx) * ty;
    if (Number.isFinite(g)) return g;
  }
  return NaN;
}

function sample(a: Float32Array, lat: number, lon: number): number {
  // 27 Nov (owner: blocky snow edges): bilinear over the corners that have a value, so one missing corner
  // no longer drops a whole ~7 km cell to another rule (that drew stair-steps along the grid).
  const fy = (lat - LAT0) / D, fx = (lon - LON0) / D;
  const y = Math.floor(fy), x = Math.floor(fx), ty = fy - y, tx = fx - x;
  if (y < 0 || x < 0 || y >= NY - 1 || x >= NX - 1) return NaN;
  let s = 0, w = 0;
  for (const [j, i, k] of [[0, 0, (1 - tx) * (1 - ty)], [0, 1, tx * (1 - ty)], [1, 0, (1 - tx) * ty], [1, 1, tx * ty]] as const) {
    const v = a[(y + j) * NX + x + i];
    if (Number.isFinite(v)) { s += v * k; w += k; }
  }
  return w > 0.05 ? s / w : NaN;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * 27 Nov (owner: blocky snow edges): ICON-EU leaves its snow line out over whole areas, and it jumps from cell to
 * cell. Averaged over the cells around that have one (box blur, twice, r cells each way), with how many had one
 * as a 0..1 weight, so the snow line fades in and out over ~30 km instead of switching along a grid edge.
 */
function smoothMissing(a: Float32Array, r: number): { v: Float32Array; w: Float32Array } {
  let v = new Float32Array(NY * NX), w = new Float32Array(NY * NX);
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) { v[i] = a[i]; w[i] = 1; }
  const blur = (src: Float32Array) => {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for (let y = 0; y < NY; y++) {
      let s = 0; const row = y * NX;
      for (let x = -r; x < NX + r; x++) {
        if (x + r < NX && x + r >= 0) s += src[row + x + r];
        if (x - r - 1 >= 0 && x - r - 1 < NX) s -= src[row + x - r - 1];
        if (x >= 0 && x < NX) tmp[row + x] = s;
      }
    }
    for (let x = 0; x < NX; x++) {
      let s = 0;
      for (let y = -r; y < NY + r; y++) {
        if (y + r < NY && y + r >= 0) s += tmp[(y + r) * NX + x];
        if (y - r - 1 >= 0 && y - r - 1 < NY) s -= tmp[(y - r - 1) * NX + x];
        if (y >= 0 && y < NY) out[y * NX + x] = s;
      }
    }
    return out;
  };
  for (let k = 0; k < 2; k++) { v = blur(v); w = blur(w); }
  const n = (2 * r + 1) ** 4, val = new Float32Array(NY * NX), wt = new Float32Array(NY * NX);
  for (let i = 0; i < val.length; i++) { wt[i] = w[i] / n; val[i] = w[i] > 1e-3 ? v[i] / w[i] : NaN; }
  return { v: val, w: wt };
}

/** Wet-bulb lapse with height: ~5 °C per km (between the dry and moist rates). */
const LAPSE = 0.005;
function rawTw(f: WetBulbField, lat: number, lon: number): number {
  const tw = sample(f.tw, lat, lon);
  if (!Number.isFinite(tw)) return NaN;
  const g = groundAt(lat, lon), hs = sample(f.hs, lat, lon);
  const own = Number.isFinite(g) && Number.isFinite(hs) ? tw - LAPSE * (g - hs) : tw;
  // 25 Nov: the model's own snow line against the real ground. ICON-EU puts its snowfall limit where the
  // wet-bulb is about 1.3 °C; ground above it is that much colder, below it warmer. Averaged with the
  // wet-bulb above, so either one going odd can't flip a whole area.
  const sl = f.sl ? sample(f.sl, lat, lon) : NaN;
  if (!Number.isFinite(g) || !Number.isFinite(sl) || !Number.isFinite(hs)) return own;
  // Faded in and out (not switched) where the snow line is near the ground or very high.
  const cover = f.slw ? clamp01(sample(f.slw, lat, lon) * 1.5) : 1;
  const k = 0.5 * cover * clamp01((sl - (hs - 100)) / 150) * clamp01((6000 - sl) / 800);
  const line = 1.3 - LAPSE * (g - sl);
  return (1 - k) * own + k * line;
}

/** Wet-bulb here, height-corrected and nudged by nearby airports (within ~40 km, fading out). */
export function wetBulbAt(f: WetBulbField, lat: number, lon: number): number {
  let tw = rawTw(f, lat, lon);
  if (!Number.isFinite(tw)) return NaN;
  let wsum = 0, dsum = 0, snow = 0, rain = 0;
  for (const s of f.fix) {
    const dy = (lat - s.lat) * 111, dx = (lon - s.lon) * 111 * Math.cos((lat * Math.PI) / 180);
    const d2 = dx * dx + dy * dy;
    // Wider (owner, 24 Nov: sleet shown over Oxford, Birmingham and Stoke where webcams and airports had rain).
    if (d2 > 100 * 100) continue;
    const w = Math.exp(-d2 / (2 * 38 * 38));
    wsum += w; dsum += w * s.d;
    if (s.snow) snow += w; if (s.rain) rain += w;
  }
  if (wsum > 0) tw += (dsum / wsum) * Math.min(1, wsum);
  // An airport seeing snow keeps it snow close by; seeing rain keeps it rain.
  // Faded by how close the airports are (27 Nov: was on/off, which drew hard edges).
  if (snow > 0.1) tw -= Math.max(0, tw - 0.4) * clamp01((snow - 0.1) / 0.3);
  else if (rain > 0.05 && tw < 1.6) {
    // Rain at the airports: rain in the towns around them too. High ground (fading out from 200 to 320 m) keeps
    // its own value, so sleet or wet snow can still show on the hills.
    const g = groundAt(lat, lon);
    const low = Number.isFinite(g) ? clamp01((320 - g) / 120) : 1;
    tw += (1.6 - tw) * clamp01((rain - 0.05) / 0.2) * low;
  }
  return tw;
}

// --- Loading, per hour (the newest ICON-EU run that has it), kept in memory.
const cache = new Map<number, WetBulbField | "loading" | "none">();
const stampOf = (run: Date) => `${run.getUTCFullYear()}${String(run.getUTCMonth() + 1).padStart(2, "0")}${String(run.getUTCDate()).padStart(2, "0")}${String(run.getUTCHours()).padStart(2, "0")}`;
async function load(hour: number): Promise<WetBulbField | null> {
  if (!demLoading) demLoading = loadDem().catch(() => {});
  const t = hour * 3_600_000;
  for (let back = 3; back <= 18; back += 3) {
    const run = new Date(Math.floor((Date.now() - back * 3_600_000) / 10_800_000) * 10_800_000);
    const step = Math.round((t - run.getTime()) / 3_600_000);
    if (step < 0 || step > 120) continue;
    const rh = String(run.getUTCHours()).padStart(2, "0"), st = stampOf(run), ss = String(step).padStart(3, "0");
    const u = (v: string, V: string) => `https://opendata.dwd.de/weather/nwp/icon-eu/grib/${rh}/${v}/icon-eu_europe_regular-lat-lon_single-level_${st}_${ss}_${V}.grib2.bz2`;
    const [t2, td] = await Promise.all([grib(u("t_2m", "T_2M")), grib(u("td_2m", "TD_2M"))]);
    if (!t2 || !td) continue;
    const hs = await grib(`https://opendata.dwd.de/weather/nwp/icon-eu/grib/${rh}/hsurf/icon-eu_europe_regular-lat-lon_time-invariant_${st}_HSURF.grib2.bz2`);
    const tw = new Float32Array(NY * NX);
    for (let i = 0; i < tw.length; i++) tw[i] = wetBulb(t2[i] - 273.15, td[i] - 273.15);
    const slRaw = await grib(u("snowlmt", "SNOWLMT"));
    const sm = slRaw ? smoothMissing(slRaw, 4) : null;
    const f: WetBulbField = { tw, hs: hs ?? new Float32Array(NY * NX).fill(NaN), sl: sm?.v, slw: sm?.w, fix: [] };
    const sl = slRaw;
    await demLoading;
    f.fix = await airports(f, t);
    console.log(`[wetbulb] ICON-EU ${st}+${ss} for ${new Date(t).toISOString()}, ${f.fix.length} airports, snow line ${sl ? "yes" : "no"}`);
    return f;
  }
  return null;
}

/** Airports' own wet-bulb against the model's there (only for times within the last 2 hours). */
async function airports(f: WetBulbField, t: number) {
  if (Date.now() - t > 2 * 3_600_000) return [];
  const j = await fetch("https://aviationweather.gov/api/data/metar?bbox=35,-25,71,45&format=json", { signal: AbortSignal.timeout(20_000) })
    .then((r) => (r.ok ? r.json() : [])).catch(() => []) as any[];
  const out: WetBulbField["fix"] = [];
  for (const m of j) {
    if (typeof m?.lat !== "number" || typeof m?.temp !== "number" || typeof m?.dewp !== "number") continue;
    if (Math.abs((m.obsTime ?? 0) * 1000 - t) > 90 * 60_000) continue;
    const model = rawTw(f, m.lat, m.lon);
    if (!Number.isFinite(model)) continue;
    const obs = wetBulb(m.temp, m.dewp);
    const wx = String(m.wxString ?? "");
    out.push({ lat: m.lat, lon: m.lon, d: Math.max(-3, Math.min(3, obs - model)),
      snow: /(^|\s)[-+]?(SN|SHSN|BLSN|SG)/.test(wx) && !/RA/.test(wx), rain: /(^|\s)[-+]?(RA|SHRA|DZ)/.test(wx) && !/SN|PL|FZ/.test(wx) });
  }
  return out;
}

/** The field for time t if ready; else null and loading starts (never blocks a tile). */
export function wetBulbNow(t: number): WetBulbField | null {
  const hour = Math.round(t / 3_600_000);
  const c = cache.get(hour);
  if (c && c !== "loading" && c !== "none") return c;
  if (c === "none" || c === "loading") return null;
  cache.set(hour, "loading");
  load(hour).then((f) => { cache.set(hour, f ?? "none"); while (cache.size > 8) cache.delete(cache.keys().next().value!); })
    .catch(() => cache.set(hour, "none"));
  return null;
}
export const wetBulbSettled = (t: number) => { const c = cache.get(Math.round(t / 3_600_000)); return c !== undefined && c !== "loading"; };
