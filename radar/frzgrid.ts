// Freezing-rain share (GFS categorical CFRZR, 0..1) on the snow video's map grid, every hour of
// gfsrs.json's times: sampled at GFS's 3-hourly steps and blended linearly between them.
// Reads NOAA's GFS files directly (no Open-Meteo). Usage: bun frzgrid.ts <gfsrs.json> <out.json>
import { readFileSync, writeFileSync } from "fs";
import { latestGfsRun, gfsPrecipType, sampleGlobal } from "./lib/server/gfs";
const [inp, out] = process.argv.slice(2);
const G = JSON.parse(readFileSync(inp, "utf8")) as { lats: number[]; lons: number[]; time: string[] };
const run = (await latestGfsRun())!;
const times = G.time.map((t) => Date.parse(t + ":00Z")); // November: UK time = UTC
const lead = (t: number) => (t - run) / 3_600_000;
const steps = [...new Set(times.map((t) => Math.floor(lead(t) / 3) * 3).flatMap((l) => [l, l + 3]))].filter((l) => l >= 3 && l <= 120).sort((a, b) => a - b);
const at: Record<number, number[]> = {};
for (const l of steps) {
  const p = await gfsPrecipType(run, l);
  at[l] = G.lats.flatMap((la) => G.lons.map((lo) => sampleGlobal(p.frzr, la, lo)));
  console.log("lead", l, "max", Math.max(...at[l]).toFixed(2));
}
const n = G.lats.length * G.lons.length;
const rows: number[][] = Array.from({ length: n }, () => []);
for (const t of times) {
  const L = lead(t), l0 = Math.floor(L / 3) * 3, l1 = l0 + 3, w = (L - l0) / 3;
  const a = at[l0], b = at[l1] ?? a;
  for (let i = 0; i < n; i++) rows[i].push(a && b ? +(a[i] * (1 - w) + b[i] * w).toFixed(2) : 0);
}
writeFileSync(out, JSON.stringify({ frz: rows, run: new Date(run).toISOString() }));
console.log("done, run", new Date(run).toISOString());
