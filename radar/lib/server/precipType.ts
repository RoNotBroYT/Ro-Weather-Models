// Precipitation TYPE for the radar colour tiles: rain, mix (sleet / freezing
// mix) or snow, from GFS temperatures at the radar frame's time.
//
// The radar only measures reflectivity; whether it is rain or snow comes from
// the temperature where it falls. Standard simple rule:
//   T2m ≤ 0.5 °C                → snow
//   0.5 < T2m ≤ 2 °C            → mix
//   …but T850 ≤ −2 °C and T2m ≤ 2 °C → snow (cold column above a near-0 surface)
//   otherwise                   → rain
//
// Never blocks a tile: precipFieldNow() returns the field if it is already in
// memory, otherwise null (draw rain) and starts loading it.

import { mixLut, snowLut } from "../radarColours";
import { GFS_LEADS, gfsLayer, latestGfsRun, sampleGlobalSmooth, type GlobalGrid } from "./gfs";

export const RAIN = 0;
export const MIX = 1;
export const SNOW = 2;

export interface PrecipField {
  t2: GlobalGrid;
  t850: GlobalGrid | null;
}

type G = { __ptype?: Map<string, PrecipField | "loading">; __ptypeRun?: { at: number; run: number | null; loading?: boolean } };
const g = globalThis as unknown as G;
const fields = (g.__ptype ??= new Map());
const runState = (g.__ptypeRun ??= { at: 0, run: null });

const H3 = 3 * 3_600_000;

function refreshRun() {
  if (runState.loading || Date.now() - runState.at < 10 * 60_000) return;
  runState.loading = true;
  latestGfsRun()
    .then((r) => {
      if (r != null) runState.run = r;
    })
    .catch(() => {})
    .finally(() => {
      runState.at = Date.now();
      runState.loading = false;
    });
}

/** The temperature field for time t, waiting up to `ms` for it to load (a tile
 *  drawn without it shows snow as rain, and cuts snow off at the tile edges). */
export async function precipFieldWait(t: number, ms = 4000): Promise<PrecipField | null> {
  const end = Date.now() + ms;
  for (;;) {
    const f = precipFieldNow(t);
    if (f || Date.now() >= end) return f;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** The temperature field for time t if loaded; else null and the load is started. */
export function precipFieldNow(t: number): PrecipField | null {
  refreshRun();
  const latest = runState.run;
  if (latest == null) return null;
  // The newest run at or before t (up to a day back — those files stay up);
  // later times use the latest run's nearest lead.
  let run = latest;
  while (run > t && latest - run < 24 * 3_600_000) run -= 6 * 3_600_000;
  if (run > t) run = latest;
  const lead = Math.max(0, Math.min(GFS_LEADS[GFS_LEADS.length - 1], Math.round((t - run) / H3) * 3));
  const key = `${run}|${lead}`;
  const f = fields.get(key);
  if (f && f !== "loading") return f;
  if (!f) {
    fields.set(key, "loading");
    Promise.all([gfsLayer(run, lead, "temperature"), gfsLayer(run, lead, "t850").catch(() => null)])
      .then(([t2, t850]) => {
        fields.set(key, { t2, t850 });
        while (fields.size > 12) fields.delete(fields.keys().next().value!);
      })
      .catch(() => fields.delete(key));
  }
  return null;
}

export function precipTypeAt(f: PrecipField, lat: number, lon: number): number {
  // Smooth (not nearest-cell) sampling: the 0.5° grid otherwise shows as squares at the snow line.
  const t2 = sampleGlobalSmooth(f.t2, lat, lon);
  if (!Number.isFinite(t2)) return RAIN;
  if (t2 <= 0.5) return SNOW;
  if (t2 <= 2) {
    const t8 = f.t850 ? sampleGlobalSmooth(f.t850, lat, lon) : NaN;
    return t8 <= -2 ? SNOW : MIX;
  }
  return RAIN;
}

/**
 * Type per 4×4-pixel block of an S×S Web-Mercator tile (row-major, S/4 a side),
 * or null when every block is rain (nothing to recolour).
 */
export const TYPE_BLOCK = 4;
export function tileTypes(f: PrecipField, west: number, east: number, north: number, south: number, S: number): Uint8Array | null {
  const K = TYPE_BLOCK;
  const B = Math.ceil(S / K);
  const out = new Uint8Array(B * B);
  const yN = Math.log(Math.tan(Math.PI / 4 + (north * Math.PI) / 360));
  const yS = Math.log(Math.tan(Math.PI / 4 + (south * Math.PI) / 360));
  let any = false;
  for (let by = 0; by < B; by++) {
    const fy = (by * K + K / 2) / S;
    const lat = (Math.atan(Math.sinh(yN + (yS - yN) * fy)) * 180) / Math.PI;
    for (let bx = 0; bx < B; bx++) {
      const lon = west + ((east - west) * (bx * K + K / 2)) / S;
      const ty = precipTypeAt(f, lat, lon);
      out[by * B + bx] = ty;
      if (ty) any = true;
    }
  }
  return any ? out : null;
}

// The snow and mix colour scales live in lib/radarColours.ts, shared with the
// browser (which reads a tapped pixel's colour back into dBZ with them).
const SNOW_LUT = snowLut();
const MIX_LUT = mixLut();

/** Snow / mix colour for a dBZ (type MIX or SNOW). */
export function typedRgba(type: number, dbz: number): [number, number, number, number] {
  const i = Math.max(0, Math.min(254, Math.round((dbz + 32) * 2))) * 4;
  const t = type === SNOW ? SNOW_LUT : MIX_LUT;
  return [t[i], t[i + 1], t[i + 2], t[i + 3]];
}
