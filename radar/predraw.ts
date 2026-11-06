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
import { eumetsatSkipped, renderView, VIEW_SATS, type ViewSat } from "./lib/server/satView";

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
});
const Bucket = process.env.R2_BUCKET ?? "ro-weather-radar";
const started = Date.now();

// The squares people open: the UK at zoom 4–6, Europe at 3, the world at 2.
const VIEW: [number, number, number][] = [];
for (const [z, x0, x1, y0, y1] of [[2, 0, 3, 0, 3], [3, 3, 4, 1, 2], [4, 7, 8, 4, 5], [5, 15, 16, 9, 10], [6, 30, 32, 19, 21]] as const)
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) VIEW.push([z, x, y]);

// No R2 keys (a local test): write into ./out instead.
const local = !process.env.R2_ENDPOINT;
const fs = await import("fs/promises");
// What earlier runs finished, in one small file (checking each picture in R2
// would be ~2 million reads a day, past the free allowance).
const readDone = async (): Promise<string[]> => {
  try {
    if (local) return JSON.parse(await fs.readFile("out/done.json", "utf8"));
    const r = await s3.send(new GetObjectCommand({ Bucket, Key: "done.json" }));
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
  const { buf, final } = await draw();
  if (!final) { unfinished.add(group(key)); return; } // still filling in at the source: the site draws it for now
  await put(key, buf);
  drawn++;
}
async function pool(jobs: (() => Promise<void>)[], n = 8) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < jobs.length) await jobs[i++]().catch((e) => { console.warn(String(e).slice(0, 200)); failed = true; }); }));
}

const latest = await latestOperaTime();
// Newest first; a fresh day fills in once, after that each run draws only what is new.
const times = [...new Set([[2, 5], [6, 10], [12, 20], [24, 30]].flatMap(([h, st]) => historyTimes(h, st, latest)))].sort((a, b) => b - a);
// Never save a picture drawn without its European radar file (a failed download
// would otherwise be saved as "finished" and stay wrong): skip that time, the site draws it.
const ok = new Set<number>();
await Promise.all(times.map(async (t) => { if (await opera(t).catch(() => null)) ok.add(t); }));
if (!ok.has(latest)) { console.log("newest European radar file not readable: nothing saved"); process.exit(1); }
const jobs: (() => Promise<void>)[] = [];
for (const t of times.filter((t) => ok.has(t)))
  for (const [z, x, y] of VIEW)
    for (const s of [2, 1]) jobs.push(() => job(`tile/${t}/${z}/${x}/${y}${s === 2 ? "@2x" : ""}.webp`, () => renderTile(t, z, x, y, s)));
// The forecast, as the site's frame list makes it (UK and Europe only).
const now = Date.now();
const forecast: number[] = [];
for (let t = latest + 5 * 60_000; t <= now; t += 5 * 60_000) forecast.push(t);
for (let t = Math.ceil(now / 600_000) * 600_000; t <= now + 60 * 60_000 && t - latest <= NOWCAST_MAX_LEAD_MIN * 60_000; t += 10 * 60_000)
  if (t > (forecast[forecast.length - 1] ?? latest)) forecast.push(t);
const fjobs: (() => Promise<void>)[] = [];
for (const ft of forecast)
  for (const [z, x, y] of VIEW.filter(([z]) => z >= 4))
    for (const s of [2, 1]) fjobs.push(() => job(`nowcast/${latest}/${ft}/${z}/${x}/${y}${s === 2 ? "@2x" : ""}.webp`, () => renderNowcastTile(latest, ft, z, x, y, s)));
// Newest history frame and the forecast first (what people open), then the rest.
const first = jobs.splice(0, VIEW.length * 2);
await pool(first);
await pool(fjobs);
await pool(jobs);
// Satellite: the newest picture's squares (world, Europe, UK), as the site's map asks
// for them (components/satView.ts satTiles). Keyed by the scans used, so never stale.
const MAX = 20037508.342789244;
const satKey = (p: string) => p.replace(/[^A-Za-z0-9-]/g, "_");
try {
  const loop = await fetch("https://www.ro-weather.app/api/satellite-loop?src=world&hours=1", { signal: AbortSignal.timeout(20_000) }).then((r) => r.json());
  const f = loop?.frames?.[loop.frames.length - 1];
  const parts: Partial<Record<ViewSat, string>> = {};
  for (const [k, v] of Object.entries((f?.parts ?? {}) as Record<string, string | null>)) if (v && VIEW_SATS.includes(k as ViewSat)) parts[k as ViewSat] = v;
  const p = Object.entries(f?.parts ?? {}).filter(([, v]) => !!v).map(([k, v]) => `${k}~${v}`).join(",");
  const g = `sat/${satKey(p)}`;
  if (p && !done.has(g)) {
    const sq: [number, number, number][] = [];
    for (const [z, x0, x1, y0, y1] of [[2, 0, 3, 0, 3], [3, 3, 4, 1, 2], [4, 7, 8, 4, 5], [5, 15, 16, 9, 10]] as const)
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) sq.push([z, x, y]);
    let bad = false;
    await pool(sq.map(([z, x, y]) => async () => {
      const size = (2 * MAX) / 2 ** z, x0 = -MAX + x * size, y1 = MAX - y * size;
      const buf = await renderView({ x0, y0: y1 - size, x1: x0 + size, y1, w: 512, h: 512, parts });
      if (parts.mtg && eumetsatSkipped()) { bad = true; return; } // Meteosat missing: let the site draw it later
      await put(`${g}/${z}/${x}/${y}.webp`, buf, buf.subarray(0, 4).toString("ascii") === "RIFF" ? "image/webp" : "image/jpeg");
      drawn++;
    }), 6);
    if (!bad) groups.add(g);
  }
} catch (e) {
  console.warn("satellite skipped:", String(e).slice(0, 200));
}

// A frame counts as done only when every one of its pictures was saved; keep the last 2 days.
const cutoff = Date.now() - 2 * 86_400_000;
const all = [...new Set([...done, ...(failed ? [] : [...groups].filter((g) => !unfinished.has(g)))])];
const keep = [...all.filter((g) => !g.startsWith("sat/") && Number(g.split("/")[1]) > cutoff), ...all.filter((g) => g.startsWith("sat/")).slice(-40)];
const body = Buffer.from(JSON.stringify([...new Set(keep)]));
if (local) await fs.writeFile("out/done.json", body);
else await s3.send(new PutObjectCommand({ Bucket, Key: "done.json", Body: body, ContentType: "application/json", CacheControl: "no-store" }));
console.log(`newest ${new Date(latest).toISOString()}: drew ${drawn}, already there ${skipped}, ${Math.round((Date.now() - started) / 1000)} s`);
