/**
 * Draws the Charts page (GFS) into Backblaze, so the site's server never draws charts.
 * Runs as the "charts" machine of the Radar workflow (every 5 min, ~4 min of work each);
 * a new GFS run fills in over the following runs, nearest hours first.
 *
 * Keys (served by radar.ro-weather.app):
 *   gfs/meta.json                                  newest run + which hours are ready
 *   gfs/tile/<layer>/<run>/<lead>/<z>/<x>/<y>.webp  colour fill (drawn at 2x)
 *   gfs/isobars/<run>/<lead>.json
 *   gfs/contours/<layer>/<run>/<lead>.json
 *   gfs/windgrid/<run>/<lead>.json
 *
 * Space (free plan is 10 GB, shared with radar): a run is ~1.5 GB, so only the newest
 * two runs are kept; older chart runs are deleted here as soon as a newer one is ready.
 */
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectVersionsCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { latestGfsRun, GFS_LEADS, RAIN_LEADS } from "./lib/server/gfs";
import { renderGfsTile, gfsIsobars, gfsContours, gfsWindGrid } from "./lib/server/gfsRender";

const s3 = new S3Client({
  region: process.env.R2_REGION ?? "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
});
const Bucket = process.env.R2_BUCKET ?? "ro-weather-maps";
const local = !process.env.R2_ENDPOINT;
const fs = await import("fs/promises");
const started = Date.now();
const BUDGET = Number(process.env.CHART_BUDGET_MS ?? 240_000);

const put = async (Key: string, body: Buffer | string, type: string, maxAge = 86400) => {
  if (local) { await fs.mkdir(`out/${Key}`.replace(/\/[^/]+$/, ""), { recursive: true }); return void (await fs.writeFile(`out/${Key}`, body)); }
  await s3.send(new PutObjectCommand({ Bucket, Key, Body: body, ContentType: type, CacheControl: maxAge ? `public, max-age=${maxAge}${maxAge >= 86400 ? ", immutable" : ""}` : "no-store" }));
};
const getJson = async <T,>(Key: string, fallback: T): Promise<T> => {
  try {
    if (local) return JSON.parse(await fs.readFile(`out/${Key}`, "utf8"));
    return JSON.parse(await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body!.transformToString());
  } catch { return fallback; }
};

// Squares drawn: world at 2, Europe at 3–4, the UK and neighbours at 5 (the page opens on these).
// Closer in, the map stretches the zoom-5 picture (GFS is ~50 km, so no detail is lost).
const AREA = [[2, 0, 3, 0, 3], [3, 2, 5, 0, 3], [4, 5, 10, 3, 7], [5, 13, 18, 7, 12]] as const;
const SQ: [number, number, number][] = [];
for (const [z, x0, x1, y0, y1] of AREA) for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) SQ.push([z, x, y]);

// The page's visible layers, by the tile layer each one draws (lib/chartLayers.ts).
const TILE_LAYERS = ["pressure", "wind", "gusts", "temperature", "cape", "shear", "z500", "t850", "thickness", "raincloud", "winterdepth"] as const;
const leadsFor = (l: string) => (l === "raincloud" || l === "winterdepth" ? RAIN_LEADS : GFS_LEADS);
const ALL_LEADS = [...new Set([...GFS_LEADS, ...RAIN_LEADS])].sort((a, b) => a - b);

const run = await latestGfsRun();
if (run == null) { console.log("no complete GFS run found"); process.exit(0); }

type Meta = { run: number; leads: number[]; rainLeads: number[]; ready: number[]; source: string; prev?: number };
const meta = await getJson<Meta | null>("gfs/meta.json", null);
const DONE = `done-charts-${run}.json`;
const done = new Set(await getJson<string[]>(DONE, []));

let drawn = 0, failed = 0;
const out = () => Date.now() - started > BUDGET;
async function pool(jobs: (() => Promise<void>)[], n = 8) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < jobs.length && !out()) await jobs[i++]().catch((e) => { failed++; console.warn(String(e).slice(0, 160)); });
  }));
}

// One "group" = everything for one hour of one layer; recorded only once all of it is saved.
async function group(key: string, work: () => Promise<void>) {
  if (done.has(key) || out()) return;
  const before = failed;
  await work();
  if (failed === before && !out()) done.add(key);
}

// Nearest hours first (what people look at), all layers of an hour together.
for (const lead of ALL_LEADS) {
  if (out()) break;
  const jsonJobs: (() => Promise<void>)[] = [];
  jsonJobs.push(() => group(`iso/${lead}`, async () => put(`gfs/isobars/${run}/${lead}.json`, JSON.stringify(await gfsIsobars(run, lead)), "application/json")));
  if (GFS_LEADS.includes(lead)) {
    jsonJobs.push(() => group(`wind/${lead}`, async () => put(`gfs/windgrid/${run}/${lead}.json`, JSON.stringify(await gfsWindGrid(run, lead)), "application/json")));
    for (const c of ["z500", "t850", "thickness"])
      jsonJobs.push(() => group(`con/${c}/${lead}`, async () => put(`gfs/contours/${c}/${run}/${lead}.json`, JSON.stringify(await gfsContours(run, lead, c)), "application/json")));
  }
  if (RAIN_LEADS.includes(lead)) {
    jsonJobs.push(() => group(`con/snowdepth/${lead}`, async () => put(`gfs/contours/snowdepth/${run}/${lead}.json`, JSON.stringify(await gfsContours(run, lead, "snowdepth")), "application/json")));
    if (!GFS_LEADS.includes(lead)) jsonJobs.push(() => group(`con/thickness/${lead}`, async () => put(`gfs/contours/thickness/${run}/${lead}.json`, JSON.stringify(await gfsContours(run, lead, "thickness")), "application/json")));
  }
  await pool(jsonJobs, 3);
  for (const l of TILE_LAYERS) {
    if (!leadsFor(l).includes(lead)) continue;
    await group(`tile/${l}/${lead}`, () => pool(SQ.map(([z, x, y]) => async () => {
      const buf = await renderGfsTile(l, run, lead, z, x, y, 2, false);
      await put(`gfs/tile/${l}/${run}/${lead}/${z}/${x}/${y}.webp`, buf, "image/webp");
      drawn++;
    }), 8));
  }
}

// An hour is "ready" when every layer and line file for it is saved.
const need = (lead: number) => [
  `iso/${lead}`,
  ...(GFS_LEADS.includes(lead) ? [`wind/${lead}`, "z500", "t850", "thickness"].map((c) => (c.startsWith("wind") ? c : `con/${c}/${lead}`)) : []),
  ...(RAIN_LEADS.includes(lead) ? [`con/snowdepth/${lead}`, ...(GFS_LEADS.includes(lead) ? [] : [`con/thickness/${lead}`])] : []),
  ...TILE_LAYERS.filter((l) => leadsFor(l).includes(lead)).map((l) => `tile/${l}/${lead}`),
];
const ready = ALL_LEADS.filter((ld) => need(ld).every((k) => done.has(k)));
await put(DONE, JSON.stringify([...done]), "application/json", 0);

// Switch the page to the new run once its first day is there (until then it keeps the old run).
const firstDay = GFS_LEADS.filter((l) => l <= 24);
const switchNow = !meta || meta.run === run || firstDay.every((l) => ready.includes(l));
if (switchNow) {
  const prev = meta && meta.run !== run ? meta.run : meta?.prev;
  await put("gfs/meta.json", JSON.stringify({ run, leads: GFS_LEADS, rainLeads: RAIN_LEADS, ready, prev, source: "NOAA GFS 0.5° (open data on AWS) — model forecast, not observation" } satisfies Meta), "application/json", 60);
  // Keep the run on show and the one before it; delete every older chart run.
  if (!local) await deleteOldRuns(new Set([run, prev].filter((r): r is number => r != null)));
}
console.log(`[charts] run ${new Date(run).toISOString()}: drew ${drawn} squares, ${ready.length}/${ALL_LEADS.length} hours ready, ${failed} failed, ${Math.round((Date.now() - started) / 1000)} s`);

async function deleteOldRuns(keep: Set<number>) {
  let n = 0;
  for (const Prefix of ["gfs/tile/", "gfs/isobars/", "gfs/contours/", "gfs/windgrid/", "done-charts-"]) {
    let km: string | undefined, vm: string | undefined;
    do {
      const r = await s3.send(new ListObjectVersionsCommand({ Bucket, Prefix, KeyMarker: km, VersionIdMarker: vm, MaxKeys: 1000 }));
      const items = [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])].filter((o) => {
        const m = o.Key!.match(/(\d{13})/);
        return m && !keep.has(Number(m[1]));
      });
      for (let i = 0; i < items.length; i += 1000)
        await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: items.slice(i, i + 1000).map((o) => ({ Key: o.Key!, VersionId: o.VersionId })), Quiet: true } }));
      n += items.length;
      km = r.IsTruncated ? r.NextKeyMarker : undefined; vm = r.IsTruncated ? r.NextVersionIdMarker : undefined;
    } while (km);
  }
  if (n) console.log(`[charts] deleted ${n} files from older runs`);
}
