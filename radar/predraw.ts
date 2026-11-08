/**
 * Draws the newest radar pictures and saves them to R2, so the site's server
 * (Vercel, paid by the minute) hardly ever has to draw radar. Started every 5
 * minutes by a Cloudflare Worker timer. The site asks R2 first and falls back
 * to drawing on Vercel for anything not here, so a late or failed run only
 * means slower pictures, never missing ones.
 *
 * Keys (same as the site's tile addresses, so the map can swap host only):
 *   tile/<t>/<z>/<x>/<y>[@2x].webp
 *   nowcast/<t0>/<t>/<z>/<x>/<y>[@2x].webp
 * Old pictures are removed by the bucket's 2-day rule.
 */
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { historyTimes, latestOperaTime, opera, renderTile } from "./lib/server/radar24";
import { renderNowcastTile, NOWCAST_MAX_LEAD_MIN } from "./lib/server/radarNowcast";
import { buildClutter } from "./clutter";
import { liveLightning, saveLightning } from "./lightning";
import { eumetsatSkipped, renderView, useMtgMosaics, VIEW_SATS, type ViewSat } from "./lib/server/satView";

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
});
const Bucket = process.env.R2_BUCKET ?? "ro-weather-radar";
const started = Date.now();
// Which share of the work this machine does (the GitHub job runs them side by side):
// "radar" = past frames, "forecast", "sat"; unset = all (a local test).
const PART = process.env.PART ?? "all";
const doing = (k: string) => PART === "all" || PART === k;
const DONE = `done-${PART}.json`;

// The squares people open: the UK at zoom 4–6, Europe at 3, the world at 2.
const VIEW: [number, number, number][] = [];
// World at 2, Europe at 3–4, the UK and its neighbours at 5–6 (wider than any screen opens on).
const AREA = [[2, 0, 3, 0, 3], [3, 2, 5, 0, 3], [4, 5, 10, 3, 7], [5, 13, 18, 7, 12], [6, 28, 34, 17, 23]] as const;
for (const [z, x0, x1, y0, y1] of AREA)
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) VIEW.push([z, x, y]);

// No R2 keys (a local test): write into ./out instead.
const local = !process.env.R2_ENDPOINT;
const fs = await import("fs/promises");
// What earlier runs finished, in one small file (checking each picture in R2
// would be ~2 million reads a day, past the free allowance).
const readDone = async (): Promise<string[]> => {
  try {
    if (local) return JSON.parse(await fs.readFile(`out/${DONE}`, "utf8"));
    const r = await s3.send(new GetObjectCommand({ Bucket, Key: DONE }));
    return JSON.parse(await r.Body!.transformToString());
  } catch { return []; }
};
const done = new Set(await readDone());
const exists = async (Key: string) => done.has(Key.replace(/\/\d+\/\d+\/\d+(@2x)?\.webp$/, ""));
const put = (Key: string, buf: Buffer, type = "image/webp") => local ? fs.mkdir(`out/${Key.replace(/\/[^/]+$/, "")}`, { recursive: true }).then(() => fs.writeFile(`out/${Key}`, buf)) :
  s3.send(new PutObjectCommand({ Bucket, Key, Body: buf, ContentType: type, CacheControl: "public, max-age=86400, immutable" }));

let failed = false;
let drawn = 0, skipped = 0;
const unfinished = new Set<string>();
const group = (k: string) => k.replace(/\/\d+\/\d+\/\d+(@2x)?\.webp$/, "");
const groups = new Set<string>();
async function job(key: string, draw: () => Promise<{ buf: Buffer; final: boolean }>) {
  groups.add(group(key));
  if (await exists(key)) return void skipped++;
  // At most ~4 min of drawing per run (newest first), so every run finishes and records
  // what it did; the rest of a first fill carries on in the next runs.
  if (Date.now() - started > 240_000) return void unfinished.add(group(key));
  const { buf, final } = await draw().catch((e) => { unfinished.add(group(key)); throw e; });
  if (!final) { unfinished.add(group(key)); return; } // still filling in at the source: the site draws it for now
  await put(key, buf).catch((e) => { unfinished.add(group(key)); throw e; });
  drawn++;
}
async function pool(jobs: (() => Promise<void>)[], n = 8) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < jobs.length) await jobs[i++]().catch((e) => { console.warn(String(e).slice(0, 200)); failed = true; }); }));
}

// Satellite lightning (GOES GLM): its own machine; nothing else from this file runs there.
if (PART === "lightning") {
  const get = async (Key: string) => {
    if (local) return fs.readFile(`out/${Key}`, "utf8").catch(() => null);
    try { return await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body!.transformToString(); } catch { return null; }
  };
  const putJson = async (Key: string, body: string, maxAge: number) => {
    if (local) { await fs.mkdir(`out/${Key.replace(/\/[^/]+$/, "")}`, { recursive: true }); return fs.writeFile(`out/${Key}`, body); }
    return s3.send(new PutObjectCommand({ Bucket, Key, Body: body, ContentType: "application/json", CacheControl: `public, max-age=${maxAge}` }));
  };
  // Live first (what the map shows now), then the 24 h pieces in between live updates.
  const runEnd = started + 4.6 * 60_000; // the next run (every 5 min) takes over
  const live = liveLightning(putJson, runEnd);
  console.log(await saveLightning(get, putJson, 150_000));
  console.log(await live);
  process.exit(0);
}

const latest = await latestOperaTime();
// Newest first; a fresh day fills in once, after that each run draws only what is new.
const times = [...new Set([[2, 5], [6, 10], [12, 20], [24, 30]].flatMap(([h, st]) => historyTimes(h, st, latest)))].sort((a, b) => b - a);
// Never save a picture drawn without its European radar file (a failed download
// would otherwise be saved as "finished" and stay wrong): skip that time, the site draws it.
const ok = new Set<number>();
const radarWork = doing("radar") || doing("forecast");
if (radarWork) await Promise.all((doing("radar") ? times : [latest]).map(async (t) => { if (await opera(t).catch(() => null)) ok.add(t); }));
if (radarWork && !ok.has(latest)) { console.log("newest European radar file not readable: nothing saved"); process.exit(1); }
// Past radar also at zoom 7 and 8 over Great Britain and Ireland: the app (and the site,
// with your location on) opens zoomed in on a town, where nothing was drawn ahead.
const CLOSE: [number, number, number][] = [];
for (const [z, x0, x1, y0, y1] of [[7, 59, 66, 38, 44], [8, 118, 132, 77, 88]] as const)
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) CLOSE.push([z, x, y]);
const jobs: (() => Promise<void>)[] = [];
for (const t of times.filter((t) => ok.has(t)))
  for (const [z, x, y] of [...VIEW, ...CLOSE])
    jobs.push(() => job(`tile/${t}/${z}/${x}/${y}@2x.webp`, () => renderTile(t, z, x, y, 2)));
// The forecast, as the site's frame list makes it (UK and Europe only).
const now = Date.now();
const forecast: number[] = [];
for (let t = latest + 5 * 60_000; t <= now; t += 5 * 60_000) forecast.push(t);
for (let t = Math.ceil(now / 600_000) * 600_000; t <= now + 60 * 60_000 && t - latest <= NOWCAST_MAX_LEAD_MIN * 60_000; t += 10 * 60_000)
  if (t > (forecast[forecast.length - 1] ?? latest)) forecast.push(t);
const fjobs: (() => Promise<void>)[] = [];
for (const ft of forecast)
  for (const [z, x, y] of VIEW.filter(([z]) => z >= 4))
    fjobs.push(() => job(`nowcast/${latest}/${ft}/${z}/${x}/${y}@2x.webp`, () => renderNowcastTile(latest, ft, z, x, y, 2)));
// Newest history frame and the forecast first (what people open), then the rest.
// Once a day: rebuild the clutter list from the past day's frames (before drawing,
// so today's pictures use it). See clutter.ts.
if (doing("radar")) {
  const age = local ? Infinity : await fetch("https://radar.ro-weather.app/clutter.bin", { method: "HEAD" }).then((r) => (r.ok ? Date.now() - Date.parse(r.headers.get("last-modified") ?? "0") : Infinity)).catch(() => Infinity);
  if (age > 86_400_000) {
    const list = await buildClutter([...ok]);
    if (list) {
      const body = Buffer.from(list.buffer);
      if (local) await fs.writeFile("out/clutter.bin", body);
      else await s3.send(new PutObjectCommand({ Bucket, Key: "clutter.bin", Body: body, ContentType: "application/octet-stream", CacheControl: "public, max-age=3600" }));
    }
  }
}
if (doing("radar")) await pool(jobs, 10); // newest first
if (doing("forecast")) await pool(fjobs, 10);
// Satellite: the newest picture's squares (world, Europe, UK), as the site's map asks
// for them (components/satView.ts satTiles). Keyed by the scans used, so never stale.
const MAX = 20037508.342789244;
const satKey = (p: string) => p.replace(/[^A-Za-z0-9-]/g, "_");
if (doing("sat")) try {
  // The whole 12 h loop the map loads (newest first); a frame already saved is skipped,
  // so after the first fill each run draws only the new one. At most ~4 min per run.
  const loop = await fetch("https://www.ro-weather.app/api/satellite-loop?src=world&hours=12", { signal: AbortSignal.timeout(20_000) }).then((r) => r.json());
  const frames = [...(loop?.frames ?? [])].reverse();
  if (!frames.length) console.log("satellite: no frames in the list");
  const sq: [number, number, number][] = [];
  // Plus the closest zoom satellite has (7) over Great Britain and Ireland: zoomed in on
  // a town, the map uses these, and drawing them on the spot took over 10 s.
  for (const [z, x0, x1, y0, y1] of [...AREA, [7, 56, 65, 37, 44]] as const)
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) sq.push([z, x, y]);
  // Newest frames first get the close-ups; the whole loop fills over the next runs.
  // Meteosat as three big pictures per scan (Europe, the UK and neighbours, Great
  // Britain and Ireland close up), each fetched once and cut into every square.
  const area = (z: number, x0: number, x1: number, y0: number, y1: number, pz: number) => {
    const size = (2 * MAX) / 2 ** z;
    const k = 2 ** (pz - z) * 512;
    return { x0: -MAX + x0 * size, x1: -MAX + (x1 + 1) * size, y1: MAX - y0 * size, y0: MAX - (y1 + 1) * size, w: (x1 - x0 + 1) * k, h: (y1 - y0 + 1) * k };
  };
  useMtgMosaics([area(3, 2, 5, 0, 3, 4), area(5, 13, 18, 7, 12, 6), area(7, 56, 65, 37, 44, 7)]);
  const satStart = Date.now();
  let satSaved = 0, viaCira = 0;
  for (const f of frames) {
    if (Date.now() - satStart > 240_000) break;
    const parts: Partial<Record<ViewSat, string>> = {};
    for (const [k, v] of Object.entries((f?.parts ?? {}) as Record<string, string | null>)) if (v && VIEW_SATS.includes(k as ViewSat)) parts[k as ViewSat] = v;
    const p = Object.entries(f?.parts ?? {}).filter(([, v]) => !!v).map(([k, v]) => `${k}~${v}`).join(",");
    const g = `s3/${satKey(p)}`; // s3: earlier sets had Europe blank or coarse
    if (!p || done.has(g)) continue;
    let bad = false;
    await pool(sq.map(([z, x, y]) => async () => {
      const size = (2 * MAX) / 2 ** z, x0 = -MAX + x * size, y1 = MAX - y * size;
      const buf = await renderView({ x0, y0: y1 - size, x1: x0 + size, y1, w: 512, h: 512, parts });
      if (parts.mtg && eumetsatSkipped()) {
        // EUMETSAT unreachable: Europe came from CIRA's copy, which runs 30–40 min late,
        // so a newer picture would have Europe blank. Keep only older ones.
        if (Date.now() - Date.parse(parts.mtg) < 75 * 60_000) { bad = true; return; }
        // CIRA's copy is coarse (~10 km blocks): fine for the world and Europe, not closer in.
        if (z >= 4) { bad = true; return; }
        viaCira++;
      }
      await put(`${g}/${z}/${x}/${y}.webp`, buf, buf.subarray(0, 4).toString("ascii") === "RIFF" ? "image/webp" : "image/jpeg");
      drawn++;
    }).map((j) => () => j().catch((e) => { bad = true; throw e; })), 6);
    if (!bad) { groups.add(g); satSaved++; }
  }
  console.log(`satellite: ${satSaved} new frames saved${viaCira ? ` (${viaCira} squares used the CIRA copy of Meteosat)` : ""}`);
} catch (e) {
  console.warn("satellite skipped:", String(e).slice(0, 200));
}

// A frame counts as done only when every one of its pictures was saved; keep the last 2 days.
const cutoff = Date.now() - 2 * 86_400_000;
const all = [...new Set([...done, ...([...groups].filter((g) => !unfinished.has(g)))])];
const keep = [...all.filter((g) => !/^(s2|s3|sat)\//.test(g) && Number(g.split("/")[1]) > cutoff), ...all.filter((g) => g.startsWith("s3/")).slice(-80)];
const body = Buffer.from(JSON.stringify([...new Set(keep)]));
if (local) await fs.writeFile(`out/${DONE}`, body);
else await s3.send(new PutObjectCommand({ Bucket, Key: DONE, Body: body, ContentType: "application/json", CacheControl: "no-store" }));
console.log(`[${PART}] newest ${new Date(latest).toISOString()}: drew ${drawn}, already there ${skipped}, ${Math.round((Date.now() - started) / 1000)} s`);
