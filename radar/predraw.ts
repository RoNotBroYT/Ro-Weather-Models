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
import { kvGet, kvPut } from "./kv";
import { lonLatToGrid } from "./lib/server/operaRadar";
import { d1On, hold, flush, pending, putFile, blockOf } from "./d1";
import { wetBulbNow, wetBulbSettled } from "./lib/server/wetbulb";
import { historyTimes, latestOperaTime, opera, renderTile, renderData } from "./lib/server/radar24";
import { renderNowcastTile, NOWCAST_MAX_LEAD_MIN } from "./lib/server/radarNowcast";
import { buildClutter } from "./clutter";
import { liveLightning, saveLightning } from "./lightning";
import { eumetsatSkipped, renderView, useMtgMosaics, VIEW_SATS, type ViewSat } from "./lib/server/satView";

const s3 = new S3Client({
  region: process.env.R2_REGION ?? "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
});
const Bucket = process.env.R2_BUCKET ?? "ro-weather-radar";
let started = Date.now();
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
    const k = await kvGet(DONE);
    if (k) return JSON.parse(k);
    const r = await s3.send(new GetObjectCommand({ Bucket, Key: DONE }));
    return JSON.parse(await r.Body!.transformToString());
  } catch { return []; }
};
// "d1" in a list marks frames saved to D1; an older list (frames in Backblaze) is started afresh.
const done = new Set(await readDone().then((l) => (process.env.MAPS_PUT_KEY && process.env.R2_ENDPOINT && !l.includes("d1") ? [] : l)));
// Blocks of a listed radar frame still waiting for a late radar (23 Nov): kept in the list as "redo:<block>",
// drawn again (whole block, so its stored row is complete) until every square in them is final.
const redo = new Set([...done].filter((g) => g.startsWith("redo:")).map((g) => g.slice(5)));
for (const g of [...done]) if (g.startsWith("redo:")) done.delete(g);
const newRedo = new Set<string>();
const touched = new Set<string>();   // redo blocks drawn again this run
const exists = async (Key: string) => { const b = blockOf(Key); if (b && redo.has(b)) return false; return done.has(Key.replace(/\/\d+\/\d+\/\d+(@2x)?\.webp$/, "")); };
// Drawn pictures go to Cloudflare D1 through radar.ro-weather.app (see d1.ts).
const useD1 = !local && d1On;
const put = (Key: string, buf: Buffer, type = "image/webp") => useD1 && hold(Key, buf) ? Promise.resolve() : local ? fs.mkdir(`out/${Key.replace(/\/[^/]+$/, "")}`, { recursive: true }).then(() => fs.writeFile(`out/${Key}`, buf)) :
  s3.send(new PutObjectCommand({ Bucket, Key, Body: buf, ContentType: type, CacheControl: "public, max-age=86400, immutable" }));

let failed = false;
let drawn = 0, skipped = 0;
const unfinished = new Set<string>();
const group = (k: string) => k.replace(/\/\d+\/\d+\/\d+(@2x)?\.webp$/, "");
const groups = new Set<string>();
async function job(key: string, draw: () => Promise<{ buf: Buffer; final: boolean }>) {
  groups.add(group(key));
  if (await exists(key)) return void skipped++;
  { const b = blockOf(key); if (b && redo.has(b)) touched.add(b); }
  // At most ~4 min of drawing per run (newest first), so every run finishes and records
  // what it did; the rest of a first fill carries on in the next runs.
  if (Date.now() - started > 240_000) return void unfinished.add(group(key));
  const { buf, final } = await draw().catch((e) => { unfinished.add(group(key)); throw e; });
  if (!final) {
    // A radar picture still waiting for a late radar: the frame is listed now and this block is drawn again next run.
    const b = key.startsWith("tile/") ? blockOf(key) : null;
    if (b) { newRedo.add(b); return; }
    unfinished.add(group(key)); return; // still filling in at the source: the site draws it for now
  }
  await put(key, buf).catch((e) => { unfinished.add(group(key)); throw e; });
  drawn++;
}
async function pool(jobs: (() => Promise<void>)[], n = 8) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < jobs.length) await jobs[i++]().catch((e) => { console.warn(String(e).slice(0, 200)); failed = true; }); }));
}


/** Saves every finished frame's pictures and writes the list of done frames (what the app and site read). */
let lastBody: Buffer | null = null;
async function publish() {
  // Send each finished frame's pictures (unfinished ones are drawn again next run).
  for (const g of [...pending.keys()]) {
    if (!groups.has(g) || unfinished.has(g)) continue;
    await flush(g, 7).catch((e) => { console.warn(String(e).slice(0, 200)); unfinished.add(g); failed = true; });
  }
  // A frame counts as done only when every one of its pictures was saved; list the last 6 h
  // (the cleanup deletes older pictures, so older frames must not be offered).
  const cutoff = Date.now() - 6 * 3600_000;
  const all = [...new Set([...done, ...([...groups].filter((g) => !unfinished.has(g)))])];
  const keep = [...all.filter((g) => !/^(s2|s3|sat)\//.test(g) && Number(g.split("/")[1]) > cutoff), ...all.filter((g) => g.startsWith("s3/")).slice(useD1 ? -36 : -80)];
  // Still waiting: what this run found waiting, plus last run's blocks not drawn again yet (never dropped unseen).
  const waiting = new Set([...newRedo, ...[...redo].filter((b) => !touched.has(b))]);
  const redoKeep = [...waiting].filter((b) => Number(b.split("/")[1]) > cutoff).map((b) => "redo:" + b);
  const body = Buffer.from(JSON.stringify([...new Set(keep), ...(useD1 ? ["d1"] : []), ...redoKeep]));
  // Cloudflare KV allows 1,000 free writes a day: the second list of a run is only written if it changed.
  if (lastBody && lastBody.equals(body)) return;
  lastBody = body;
  if (local) await fs.writeFile(`out/${DONE}`, body);
  else {
    // D1 first (what the Worker serves; 23 Nov), then KV and Backblaze as before. A refusal from one (KV's daily
    // limit) must not stop the others.
    if (useD1) await putFile(`lists/${DONE}`, body).catch((e) => console.warn("d1 list", String(e).slice(0, 150)));
    await kvPut(DONE, body).catch((e) => console.warn("kv list", String(e).slice(0, 150)));
    await s3.send(new PutObjectCommand({ Bucket, Key: DONE, Body: body, ContentType: "application/json", CacheControl: "no-store" })).catch((e) => console.warn("b2 list", String(e).slice(0, 150)));
  }
}

// Satellite lightning (GOES GLM): its own machine; nothing else from this file runs there.
if (PART === "lightning") {
  const get = async (Key: string) => {
    if (local) return fs.readFile(`out/${Key}`, "utf8").catch(() => null);
    // From D1 through the Worker (17 Nov: Backblaze's free downloads ran out).
    if (d1On) return fetch(`https://radar.ro-weather.app/${Key}`, { signal: AbortSignal.timeout(15_000) }).then((r) => (r.ok ? r.text() : null)).catch(() => null);
    try { return await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body!.transformToString(); } catch { return null; }
  };
  const putJson = async (Key: string, body: string, maxAge: number) => {
    if (local) { await fs.mkdir(`out/${Key.replace(/\/[^/]+$/, "")}`, { recursive: true }); return fs.writeFile(`out/${Key}`, body); }
    // A dropped connection must not stop the whole lightning job (17 Nov): log it; the next
    // save (20 s later, or the next run) carries on.
    if (d1On) return putFile(Key, body).catch((e) => console.warn("lightning save", Key, String(e).slice(0, 120)));
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
// Rain / sleet / snow by wet-bulb (wetbulb.ts): load the ICON-EU fields, ground heights and
// airports BEFORE drawing (they take a minute or two), so every picture uses them; the drawing
// budget starts after.
if (PART === "radar" || PART === "forecast") {
  const t0 = Date.now();
  for (const t of [latest, latest + 3_600_000]) wetBulbNow(t);
  while (!wetBulbSettled(latest) && Date.now() - t0 < 75_000) await new Promise((r) => setTimeout(r, 1000));
  console.log(`[wetbulb] ready after ${Math.round((Date.now() - t0) / 1000)} s: ${wetBulbNow(latest) ? "ICON-EU" : "not available, GFS rule"}`);
  started = Date.now();
}
// Newest first; a fresh day fills in once, after that each run draws only what is new.
const times = [...new Set([[2, 5], [6, 10], [12, 20], [24, 30]].flatMap(([h, st]) => historyTimes(h, st, latest)))].sort((a, b) => b - a);
// Never save a picture drawn without its European radar file (a failed download
// would otherwise be saved as "finished" and stay wrong): skip that time, the site draws it.
const ok = new Set<number>();
const radarWork = doing("radar") || doing("forecast");
// Only the newest scan's file first (23 Nov: downloading the whole loop's files, ~2 MB each, took 8 minutes
// before anything was drawn); the older ones are checked after the newest scan is published.
const check = (ts: number[]) => Promise.all(ts.map(async (t) => { if (await opera(t).catch(() => null)) ok.add(t); }));
if (radarWork) await check([latest]);
if (radarWork && !ok.has(latest)) { console.log("newest European radar file not readable: nothing saved"); process.exit(1); }
// Past radar also at zoom 7 and 8 over Great Britain and Ireland: the app (and the site,
// with your location on) opens zoomed in on a town, where nothing was drawn ahead.
const CLOSE: [number, number, number][] = [];
for (const [z, x0, x1, y0, y1] of [[7, 59, 66, 38, 44], [8, 118, 132, 77, 88]] as const)
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) CLOSE.push([z, x, y]);
const jobs: (() => Promise<void>)[] = [];
// The radar as numbers for the app's falling rain and snow (one small file a picture), newest first.
// Scan by scan, newest first (23 Nov: all the rain data came before any picture, so the newest scan waited).
const newestJobs: (() => Promise<void>)[] = [];
const scanJobs = (t: number, list: (() => Promise<void>)[]) => {
  list.push(() => job(`data/${t}.png`, () => renderData(t)));
  for (const [z, x, y] of [...VIEW, ...CLOSE]) list.push(() => job(`tile/${t}/${z}/${x}/${y}@2x.webp`, () => renderTile(t, z, x, y, 2)));
};
if (ok.has(latest)) scanJobs(latest, newestJobs);
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
if (doing("radar")) {
  // The newest scan, then its list at once (owner, 23 Nov: the app was 25 to 45 minutes behind, because the
  // list was only written at the end of a ~9 minute run). The older frames follow and the list is written again.
  await pool(newestJobs, 10);
  await publish();
  await check(times.filter((t) => t !== latest));
  for (const t of times.filter((t) => t !== latest && ok.has(t))) scanJobs(t, jobs);
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
  await pool(jobs, 10);
  await clutterTest(latest).catch((e) => console.warn("clutter test", String(e).slice(0, 150)));
}
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

await publish();
console.log(`[${PART}] newest ${new Date(latest).toISOString()}: drew ${drawn}, already there ${skipped}, ${Math.round((Date.now() - started) / 1000)} s`);


/**
 * TEST ONLY, changes nothing (owner, 23 Nov: Dublin's false "storms" fed the rain forecast). For the newest scan:
 * strong echoes (30 dBZ or more) over the UK and Ireland, grouped by half-degree squares, and what the satellite
 * rain product (H SAF h40b, EUMETSAT) says there. Logs which ones a filter would remove, to check before using it.
 */
async function clutterTest(t: number) {
  const o = await opera(t);
  if (!o) return;
  const cells = new Map<string, { la: number; lo: number; n: number; max: number }>();
  for (let la = 49.8; la <= 60.9; la += 0.1) for (let lo = -10.8; lo <= 2.0; lo += 0.1) {
    const { col, row } = lonLatToGrid(lo, la, o.grid);
    const c = Math.round(col), r = Math.round(row);
    if (r < 0 || c < 0 || r >= o.grid.rows || c >= o.grid.cols) continue;
    const v = o.read(r, r + 1, c, c + 1)[0];
    if (v === o.nodata || v === o.undetect || !Number.isFinite(v)) continue;
    const dbz = v * o.gain + o.offset;
    if (dbz < 30) continue;
    const k = `${Math.round(la * 2) / 2},${Math.round(lo * 2) / 2}`;
    const e = cells.get(k) ?? { la: 0, lo: 0, n: 0, max: 0 };
    e.la += la; e.lo += lo; e.n++; e.max = Math.max(e.max, dbz); cells.set(k, e);
  }
  const iso = new Date(t).toISOString().replace(".000", "");
  const list = [...cells.values()].sort((a, b) => b.n - a.n).slice(0, 12);
  if (!list.length) return void console.log("[clutter-test] no strong echoes over the UK and Ireland");
  for (const c of list) {
    const la = c.la / c.n, lo = c.lo / c.n;
    const u = `https://view.eumetsat.int/geoserver/ows?service=WMS&version=1.3.0&request=GetFeatureInfo&layers=mtg_fd:h40b&query_layers=mtg_fd:h40b&styles=&crs=EPSG:4326&bbox=${la - 0.05},${lo - 0.05},${la + 0.05},${lo + 0.05}&width=11&height=11&i=5&j=5&info_format=application/json&time=${iso}`;
    const j = await fetch(u, { signal: AbortSignal.timeout(15_000) }).then((r) => r.json()).catch(() => null) as { features?: { properties?: Record<string, number> }[] } | null;
    const p = j?.features?.[0]?.properties;
    const rain = p?.Instantaneous_rain_rate, q = p?.Quality_index;
    const would = rain === 0 && (q ?? 0) >= 50;
    console.log(`[clutter-test] ${la.toFixed(2)},${lo.toFixed(2)}: ${c.n} spots up to ${c.max.toFixed(0)} dBZ; satellite ${rain ?? "?"} mm/h (quality ${q ?? "?"})${would ? " -> would remove" : ""}`);
  }
}
