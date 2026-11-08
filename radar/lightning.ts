/**
 * Satellite lightning for Ro-Weather (replacing Blitzortung, whose terms don't allow a
 * public map or storm warnings). NOAA GOES-19 (East) and GOES-18 (West) Geostationary
 * Lightning Mapper: every flash, public domain, a new file every 20 s on AWS.
 * Each run reads the files since the last run and saves the flashes as 5-minute pieces:
 *   lightning/<t5>.json   [[lon, lat, secondsIntoPiece, energyClass], …]   (t5 = ms, 5-min step)
 *   lightning/index.json  the pieces there (newest last), kept 24 h
 */
import { promises as fsp } from "fs";
import os from "os";
import path from "path";

export type Flash = [number, number, number, number];
/** Each satellite keeps the flashes nearer its own longitude (where both see one, once only). */
const SATS: { bucket: string; keep: (lon: number) => boolean }[] = [
  { bucket: "noaa-goes19", keep: (lon) => lon > -106.2 },
  { bucket: "noaa-goes18", keep: (lon) => lon <= -106.2 },
];

async function list(bucket: string, prefix: string): Promise<string[]> {
  const xml = await fetch(`https://${bucket}.s3.amazonaws.com/?list-type=2&prefix=${prefix}`).then((r) => r.text());
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
}

/** Start time of a GLM file from its name (…_s20263120026000_…: year, day, h, m, s, tenths). */
function fileStart(key: string): number {
  const m = key.match(/_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)/)!;
  return Date.UTC(+m[1], 0, +m[2], +m[3], +m[4], +m[5], +m[6] * 100);
}

let h5: Promise<typeof import("h5wasm/node")> | null = null;
const lib = () => (h5 ??= import("h5wasm/node").then(async (m) => (await m.ready, m)));

async function read(bucket: string, key: string): Promise<{ lat: number[]; lon: number[]; t: number[]; e: number[] } | null> {
  const res = await fetch(`https://${bucket}.s3.amazonaws.com/${key}`).catch(() => null);
  if (!res?.ok) return null;
  const { File: H5File } = await lib();
  const tmp = path.join(os.tmpdir(), `glm-${Math.random().toString(36).slice(2)}.nc`);
  await fsp.writeFile(tmp, new Uint8Array(await res.arrayBuffer()));
  try {
    const f = new H5File(tmp, "r");
    // Packed numbers: value × scale_factor + add_offset (and _Unsigned for the time offsets).
    const get = (k: string): number[] => {
      const d = f.get(k) as any;
      if (!d) return [];
      const a = d.attrs ?? {};
      const sc = Number(a.scale_factor?.value ?? 1), of = Number(a.add_offset?.value ?? 0);
      const uns = String(a._Unsigned?.value ?? "") === "true";
      const bits = d.dtype?.size ? d.dtype.size * 8 : 16;
      return Array.from(d.value as ArrayLike<number>, (v) => (uns && v < 0 ? v + 2 ** bits : v) * sc + of);
    };
    const out = { lat: get("flash_lat"), lon: get("flash_lon"), t: get("flash_time_offset_of_first_event"), e: get("flash_energy") };
    f.close();
    return out;
  } catch {
    return null;
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }
}

/** All flashes from files that started in [from, to). */
export async function glmFlashes(from: number, to: number): Promise<{ t: number; lon: number; lat: number; e: number }[]> {
  const out: { t: number; lon: number; lat: number; e: number }[] = [];
  const hours = new Set<string>();
  for (let t = from - 3_600_000; t <= to; t += 3_600_000) {
    const d = new Date(t);
    const doy = Math.floor((t - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
    hours.add(`GLM-L2-LCFA/${d.getUTCFullYear()}/${String(doy).padStart(3, "0")}/${String(d.getUTCHours()).padStart(2, "0")}/`);
  }
  for (const { bucket, keep } of SATS) {
    const keys = (await Promise.all([...hours].map((h) => list(bucket, h).catch(() => [])))).flat().filter((k) => {
      const s = fileStart(k);
      return s >= from && s < to;
    });
    for (let i = 0; i < keys.length; i += 8) {
      const got = await Promise.all(keys.slice(i, i + 8).map((k) => read(bucket, k).then((r) => ({ k, r }))));
      for (const { k, r } of got) {
        if (!r) continue;
        const s = fileStart(k);
        for (let j = 0; j < r.lat.length; j++) if (keep(r.lon[j])) out.push({ t: s + r.t[j] * 1000, lon: r.lon[j], lat: r.lat[j], e: r.e[j] });
      }
    }
  }
  return out;
}

const STEP = 300_000;

/**
 * Saves every finished 5-minute piece not saved yet (newest first, so a fresh start shows
 * now at once and fills the past day over the next runs), at most `budgetMs` of work.
 */
export async function saveLightning(
  get: (key: string) => Promise<string | null>,
  put: (key: string, body: string, maxAge: number) => Promise<unknown>,
  budgetMs = 200_000,
): Promise<string> {
  const started = Date.now();
  const index: number[] = JSON.parse((await get("lightning/index.json")) ?? "[]");
  const have = new Set(index);
  // A piece is finished once its last 20-second file is out (~1 min after it ends).
  const newest = Math.floor((Date.now() - 90_000) / STEP) * STEP - STEP;
  let saved = 0, flashes = 0;
  for (let t = newest; t > newest - 24 * 3_600_000; t -= STEP) {
    if (have.has(t)) continue;
    if (Date.now() - started > budgetMs) break;
    const f = await glmFlashes(t, t + STEP);
    // [lon, lat, seconds into the piece, strength 0–3] — small enough to fetch a day of.
    const rows = f.map((x) => [+x.lon.toFixed(3), +x.lat.toFixed(3), Math.max(0, Math.round((x.t - t) / 1000)), Math.max(0, Math.min(3, Math.round(Math.log10(Math.max(x.e, 1e-16)) + 15)))]);
    await put(`lightning/${t}.json`, JSON.stringify(rows), 86_400);
    have.add(t);
    saved++;
    flashes += rows.length;
  }
  const keep = [...have].filter((t) => t > Date.now() - 24 * 3_600_000 - STEP).sort((a, b) => a - b);
  await put("lightning/index.json", JSON.stringify(keep), 60);
  return `lightning: saved ${saved} pieces (${flashes} flashes), ${keep.length} in the last 24 h`;
}

/**
 * Live: for the rest of this run (the next run takes over as it ends), check every 20 s
 * (the satellite's own rate) and keep lightning/live.json = the last 10 minutes of flashes,
 * [lon, lat, seconds before `at`, strength]. About 30–60 s behind the real flash.
 */
export async function liveLightning(
  put: (key: string, body: string, maxAge: number) => Promise<unknown>,
  untilMs: number,
): Promise<string> {
  let flashes: { t: number; lon: number; lat: number; e: number }[] = [];
  let upTo = Date.now() - 10 * 60_000;
  let writes = 0;
  while (Date.now() < untilMs) {
    const now = Date.now();
    const got = await glmFlashes(upTo, now).catch(() => []);
    if (got.length) upTo = Math.max(upTo, ...got.map((f) => f.t)) + 1;
    flashes = [...flashes, ...got].filter((f) => f.t > now - 10 * 60_000);
    const rows = flashes.map((x) => [+x.lon.toFixed(3), +x.lat.toFixed(3), Math.max(0, Math.round((now - x.t) / 1000)), Math.max(0, Math.min(3, Math.round(Math.log10(Math.max(x.e, 1e-16)) + 15)))]);
    await put("lightning/live.json", JSON.stringify({ at: now, flashes: rows }), 15);
    writes++;
    const wait = 20_000 - (Date.now() - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  return `lightning live: ${writes} updates, ${flashes.length} flashes in the last 10 min`;
}
