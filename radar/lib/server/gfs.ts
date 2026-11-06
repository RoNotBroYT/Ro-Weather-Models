/**
 * WORLDWIDE forecast fields for the Charts page: NOAA's GFS model at 0.5°
 * (~55 km), every 3 hours to +120 h, from NOAA's open-data bucket on AWS
 * (noaa-gfs-bdp-pds — public, no key, no rate limit).
 *
 * Only the messages needed are downloaded: each GFS file has an .idx
 * listing where every field starts, so one field is one HTTP range request
 * (~150–300 KB), decoded by lib/server/grib2.ts (checked against the raw
 * values: PRMSL 935–1053 hPa worldwide, London 1010.8 hPa on the 29 Sep
 * 18 UTC run, +3 h).
 *
 * FIELDS (units as drawn)
 *   pressure     mean sea-level pressure, hPa (GFS PRMSL)
 *   temperature  air temperature 2 m above ground, °C
 *   wind         mean wind speed 10 m above ground, mph (from U/V)
 *   gusts        surface wind gust, mph (GFS GUST)
 *   cape         surface-based CAPE, J/kg
 *   shear        bulk shear 10 m → 500 hPa, knots: |V500 − V10|
 *   z500         500 hPa geopotential height, decametres (GFS HGT gpm ÷ 10)
 *   t850         850 hPa temperature, °C
 *   thickness    1000–500 hPa thickness, dam (HGT500 − HGT1000)
 * Each is the model's value AT the forecast hour (GFS GUST: the gust at
 * that hour). Model forecast, not observation.
 */
import { decodeGrib2, type Grib2Field } from "./grib2";

const BUCKET = "https://noaa-gfs-bdp-pds.s3.amazonaws.com";
export const GFS_LEADS = Array.from({ length: 41 }, (_, i) => i * 3); // 0..120 h
export type GfsLayer = "pressure" | "temperature" | "wind" | "gusts" | "cape" | "shear" | "rain" | "z500" | "t850" | "thickness" | "winter" | "winterdepth" | "snowdepth" | "cloud" | "raincloud";
/**
 * Winter overview (rain/snow type fill, optional snow depth beneath, thickness + isobar lines):
 * "winter" / "winterdepth" are tile layers, "snowdepth" the snow-lying field (depth shading, lines,
 * point readout). All on RAIN_LEADS: PRATE, the categorical type fields and SNOD are in every file to +384 h.
 */
export const WINTER_LAYERS: GfsLayer[] = ["winter", "winterdepth", "snowdepth", "raincloud"];
export const GFS_LAYERS: GfsLayer[] = ["pressure", "temperature", "wind", "gusts", "cape", "shear", "z500", "t850", "thickness"];
/** Layers drawn with their own contour lines (/api/gfs/contours/<layer>/…). */
export const GFS_CONTOUR_LAYERS: GfsLayer[] = ["z500", "t850", "thickness"];
/**
 * Rain goes the whole way (16 days): every 3 h to +120 h, then every 6 h to +384 h. Each step is
 * the model's rain rate at that hour (GFS PRATE), in mm/h; none at +0 h.
 */
export const RAIN_LEADS = [
  ...Array.from({ length: 40 }, (_, i) => (i + 1) * 3),
  ...Array.from({ length: 44 }, (_, i) => 126 + i * 6),
];

const MSG: Record<string, string> = {
  prmsl: ":PRMSL:mean sea level:",
  t2m: ":TMP:2 m above ground:",
  u10: ":UGRD:10 m above ground:",
  v10: ":VGRD:10 m above ground:",
  gust: ":GUST:surface:",
  cape: ":CAPE:surface:",
  prate: ":PRATE:surface:",
  u500: ":UGRD:500 mb:",
  v500: ":VGRD:500 mb:",
  z500: ":HGT:500 mb:",
  z1000: ":HGT:1000 mb:",
  t850: ":TMP:850 mb:",
  tcdc: ":TCDC:entire atmosphere:",
  snod: ":SNOD:surface:",
  csnow: ":CSNOW:surface:",
  crain: ":CRAIN:surface:",
  cfrzr: ":CFRZR:surface:",
  cicep: ":CICEP:surface:",
};
type Raw = keyof typeof MSG;

/** A global field on GFS's 0.5° grid: row 0 = 90°N, col 0 = 0°E, 720 × 361. */
export interface GlobalGrid {
  values: Float32Array;
  ni: number;
  nj: number;
}

const ymd = (t: number) => {
  const d = new Date(t);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};
const hh = (t: number) => String(new Date(t).getUTCHours()).padStart(2, "0");
const fileUrl = (run: number, lead: number) =>
  `${BUCKET}/gfs.${ymd(run)}/${hh(run)}/atmos/gfs.t${hh(run)}z.pgrb2.0p50.f${String(lead).padStart(3, "0")}`;

type G = {
  __gfsRun?: { at: number; run: number };
  __gfsIdx?: Map<string, Promise<string[]>>;
  __gfsRaw?: Map<string, Promise<GlobalGrid>>;
  __gfsLayer?: Map<string, Promise<GlobalGrid>>;
};
const g = globalThis as unknown as G;
const idxCache = (g.__gfsIdx ??= new Map());
const rawCache = (g.__gfsRaw ??= new Map());
const layerCache = (g.__gfsLayer ??= new Map());
const trim = (m: Map<string, unknown>, max: number) => {
  while (m.size > max) m.delete(m.keys().next().value!);
};

/**
 * The newest GFS run whose +120 h file is published (a run appears ~3.5–5 h
 * after its nominal time and fills in lead by lead; waiting for the last
 * lead means every step on the slider exists). Checked, not assumed.
 */
export async function latestGfsRun(): Promise<number | null> {
  if (g.__gfsRun && Date.now() - g.__gfsRun.at < 10 * 60_000) return g.__gfsRun.run;
  const newest = Math.floor(Date.now() / 21_600_000) * 21_600_000;
  const cands = Array.from({ length: 5 }, (_, i) => newest - i * 21_600_000);
  const ok = await Promise.all(
    cands.map((run) =>
      fetch(`${fileUrl(run, GFS_LEADS[GFS_LEADS.length - 1])}.idx`, { method: "HEAD", cache: "no-store", signal: AbortSignal.timeout(8000) })
        .then((r) => r.ok)
        .catch(() => false)
    )
  );
  const i = ok.indexOf(true);
  if (i < 0) return null;
  g.__gfsRun = { at: Date.now(), run: cands[i] };
  return cands[i];
}

function idx(run: number, lead: number): Promise<string[]> {
  const url = `${fileUrl(run, lead)}.idx`;
  let p = idxCache.get(url);
  if (!p) {
    p = fetch(url, { signal: AbortSignal.timeout(20_000) })
      .then((r) => {
        if (!r.ok) throw new Error(`GFS idx ${r.status}`);
        return r.text();
      })
      .then((t) => t.trim().split("\n"));
    p.catch(() => idxCache.delete(url));
    idxCache.set(url, p);
    trim(idxCache, 200);
  }
  return p;
}

function raw(run: number, lead: number, name: Raw): Promise<GlobalGrid> {
  const key = `${run}|${lead}|${name}`;
  let p = rawCache.get(key);
  if (!p) {
    p = (async () => {
      const lines = await idx(run, lead);
      const i = lines.findIndex((l) => l.includes(MSG[name]));
      if (i < 0) throw new Error(`GFS: ${name} not in file`);
      const start = Number(lines[i].split(":")[1]);
      const end = i + 1 < lines.length ? Number(lines[i + 1].split(":")[1]) - 1 : undefined;
      const r = await fetch(fileUrl(run, lead), {
        headers: { Range: `bytes=${start}-${end ?? ""}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (r.status !== 206 && r.status !== 200) throw new Error(`GFS download ${r.status}`);
      const f: Grib2Field = decodeGrib2(Buffer.from(await r.arrayBuffer()));
      if (f.ni !== 720 || f.nj !== 361 || f.dLat > 0) throw new Error("GFS: unexpected grid");
      return { values: f.values, ni: f.ni, nj: f.nj };
    })();
    p.catch(() => rawCache.delete(key));
    rawCache.set(key, p);
    trim(rawCache, 120);
  }
  return p;
}

const MS_TO_MPH = 2.236936;
const MS_TO_KT = 1.943844;

/** One drawable layer at one forecast hour, in the units listed at the top. */
export function gfsLayer(run: number, lead: number, layer: GfsLayer): Promise<GlobalGrid> {
  const key = `${run}|${lead}|${layer}`;
  let p = layerCache.get(key);
  if (!p) {
    p = (async (): Promise<GlobalGrid> => {
      const map1 = (a: GlobalGrid, fn: (v: number) => number): GlobalGrid => {
        const out = new Float32Array(a.values.length);
        for (let i = 0; i < out.length; i++) out[i] = fn(a.values[i]);
        return { values: out, ni: a.ni, nj: a.nj };
      };
      switch (layer) {
        case "pressure":
          return map1(await raw(run, lead, "prmsl"), (v) => v / 100);
        case "temperature":
          return map1(await raw(run, lead, "t2m"), (v) => v - 273.15);
        case "gusts":
          return map1(await raw(run, lead, "gust"), (v) => v * MS_TO_MPH);
        case "cape":
          return raw(run, lead, "cape");
        case "cloud":
          return map1(await raw(run, lead, "tcdc"), (v) => Math.min(100, Math.max(0, v)));
        case "snowdepth":
          return map1(await raw(run, lead, "snod"), (v) => Math.max(0, v * 100)); // m → cm
        case "winter":
        case "winterdepth":
        case "raincloud":
        case "rain":
          return map1(await raw(run, lead, "prate"), (v) => Math.max(0, v * 3600));
        case "z500":
          return map1(await raw(run, lead, "z500"), (v) => v / 10);
        case "t850":
          return map1(await raw(run, lead, "t850"), (v) => v - 273.15);
        case "thickness": {
          const [a, b] = await Promise.all([raw(run, lead, "z500"), raw(run, lead, "z1000")]);
          const out = new Float32Array(a.values.length);
          for (let i = 0; i < out.length; i++) out[i] = (a.values[i] - b.values[i]) / 10;
          return { values: out, ni: a.ni, nj: a.nj };
        }
        case "wind": {
          const [u, v] = await Promise.all([raw(run, lead, "u10"), raw(run, lead, "v10")]);
          const out = new Float32Array(u.values.length);
          for (let i = 0; i < out.length; i++) out[i] = Math.hypot(u.values[i], v.values[i]) * MS_TO_MPH;
          return { values: out, ni: u.ni, nj: u.nj };
        }
        case "shear": {
          const [u1, v1, u2, v2] = await Promise.all([
            raw(run, lead, "u10"),
            raw(run, lead, "v10"),
            raw(run, lead, "u500"),
            raw(run, lead, "v500"),
          ]);
          const out = new Float32Array(u1.values.length);
          for (let i = 0; i < out.length; i++)
            out[i] = Math.hypot(u2.values[i] - u1.values[i], v2.values[i] - v1.values[i]) * MS_TO_KT;
          return { values: out, ni: u1.ni, nj: u1.nj };
        }
      }
    })();
    p.catch(() => layerCache.delete(key));
    layerCache.set(key, p);
    trim(layerCache, 60);
  }
  return p;
}

/** 10 m wind components (m/s) for arrows. */
export async function gfsWindUV(run: number, lead: number): Promise<[GlobalGrid, GlobalGrid]> {
  return Promise.all([raw(run, lead, "u10"), raw(run, lead, "v10")]);
}

/** Bilinear sample at lat/lon (any longitude; wraps round the globe). NaN outside. */
export function sampleGlobal(f: GlobalGrid, lat: number, lon: number): number {
  const y = (90 - lat) / 0.5;
  if (y < 0 || y > f.nj - 1) return NaN;
  const x = ((((lon % 360) + 360) % 360) / 0.5);
  const x0 = Math.floor(x), y0 = Math.min(Math.floor(y), f.nj - 2);
  const x1 = (x0 + 1) % f.ni;
  const tx = x - x0, ty = y - y0;
  const v = f.values;
  return (
    v[y0 * f.ni + x0] * (1 - tx) * (1 - ty) +
    v[y0 * f.ni + x1] * tx * (1 - ty) +
    v[(y0 + 1) * f.ni + x0] * (1 - tx) * ty +
    v[(y0 + 1) * f.ni + x1] * tx * ty
  );
}

/** Precipitation type at the forecast hour: GFS categorical fields (1 = yes), instantaneous. */
export async function gfsPrecipType(run: number, lead: number) {
  const [rain, snow, frzr, icep] = await Promise.all([
    raw(run, lead, "crain"), raw(run, lead, "csnow"), raw(run, lead, "cfrzr"), raw(run, lead, "cicep"),
  ]);
  return { rain, snow, frzr, icep };
}
/** 0 none, 1 rain, 2 snow, 3 freezing rain, 4 sleet (ice pellets): the strongest bilinear share wins, ties to the wintrier type. */
export function pickPrecipType(t: Awaited<ReturnType<typeof gfsPrecipType>>, lat: number, lon: number): number {
  const c = [sampleGlobal(t.icep, lat, lon), sampleGlobal(t.frzr, lat, lon), sampleGlobal(t.snow, lat, lon), sampleGlobal(t.rain, lat, lon)];
  const code = [4, 3, 2, 1];
  let best = 0, bv = 0.5;
  for (let i = 0; i < 4; i++) if (c[i] >= bv) { bv = c[i]; best = code[i]; if (c[i] > 0.99) break; }
  return best;
}

const cr = (p0: number, p1: number, p2: number, p3: number, t: number) =>
  p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
/**
 * Smooth (Catmull-Rom bicubic) sample for drawing tiles: the 0.5° grid looks chunky with plain
 * bilinear. Clamped to the range of the four nearest grid values, so no overshoot: heavy-rain
 * cores keep their peak and dry areas stay dry. Drawing only; readouts use sampleGlobal.
 */
export function sampleGlobalSmooth(f: GlobalGrid, lat: number, lon: number): number {
  const y = (90 - lat) / 0.5;
  if (y < 0 || y > f.nj - 1) return NaN;
  const x = ((((lon % 360) + 360) % 360) / 0.5);
  const x0 = Math.floor(x), y0 = Math.min(Math.floor(y), f.nj - 2);
  const tx = x - x0, ty = y - y0;
  const v = f.values;
  const col = (xi: number) => ((xi % f.ni) + f.ni) % f.ni;
  const row = (yi: number) => Math.min(f.nj - 1, Math.max(0, yi));
  const rows: number[] = [];
  let lo = Infinity, hi = -Infinity;
  for (let j = -1; j <= 2; j++) {
    const r = row(y0 + j) * f.ni;
    const a = v[r + col(x0 - 1)], b = v[r + col(x0)], c = v[r + col(x0 + 1)], d = v[r + col(x0 + 2)];
    rows.push(cr(a, b, c, d, tx));
    if (j === 0 || j === 1) { lo = Math.min(lo, b, c); hi = Math.max(hi, b, c); }
  }
  const out = cr(rows[0], rows[1], rows[2], rows[3], ty);
  return out < lo ? lo : out > hi ? hi : out;
}
