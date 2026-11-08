/**
 * MTG Lightning Imager (Meteosat-12, EUMETSAT): every lightning flash over Europe, Africa,
 * the Middle East and the Atlantic, as Level-2 "Lightning Flashes" (LI-2-LFL) products from
 * the EUMETSAT Data Store, a new one every ~30 s. Needs a free EUMETSAT account: the keys
 * are GitHub secrets EUMETSAT_KEY / EUMETSAT_SECRET (never in code). Credit: EUMETSAT.
 */
import { promises as fsp } from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

const COLLECTION = "EO:EUM:DAT:0691"; // LI Lightning Flashes, Level 2
const API = "https://api.eumetsat.int";

let tok: { at: number; value: string } | null = null;
async function token(): Promise<string | null> {
  const key = process.env.EUMETSAT_KEY, secret = process.env.EUMETSAT_SECRET;
  if (!key || !secret) return null;
  if (tok && Date.now() - tok.at < 30 * 60_000) return tok.value;
  const r = await fetch(`${API}/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) { console.warn("[mtg] token", r.status); return null; }
  tok = { at: Date.now(), value: (await r.json()).access_token };
  return tok.value;
}

let h5: Promise<typeof import("h5wasm/node")> | null = null;
const lib = () => (h5 ??= import("h5wasm/node").then(async (m) => (await m.ready, m)));

/** Seconds-since-epoch base from a CF "units" string, e.g. "seconds since 2000-01-01 00:00:00.0". */
function epoch(units: string): number | null {
  const m = units.match(/(seconds|milliseconds) since (\d{4}-\d\d-\d\d)[ T]?(\d\d:\d\d:\d\d)?/);
  if (!m) return null;
  return Date.parse(`${m[2]}T${m[3] ?? "00:00:00"}Z`);
}

async function readProduct(href: string, bearer: string, fallbackT: number): Promise<{ t: number; lon: number; lat: number; e: number }[]> {
  const r = await fetch(href, { headers: { Authorization: `Bearer ${bearer}` } });
  if (!r.ok) return [];
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mtg-"));
  try {
    const zip = path.join(dir, "p.zip");
    await fsp.writeFile(zip, new Uint8Array(await r.arrayBuffer()));
    execFileSync("unzip", ["-qo", zip, "-d", dir]);
    const files = (await fsp.readdir(dir, { recursive: true })) as string[];
    const nc = files.find((f) => /BODY.*\.nc$/i.test(f)) ?? files.find((f) => f.endsWith(".nc"));
    if (!nc) return [];
    const { File: H5File } = await lib();
    const f = new H5File(path.join(dir, nc), "r");
    const names: string[] = (f as any).keys?.() ?? [];
    const pick = (re: RegExp) => names.find((n) => re.test(n));
    const read = (n?: string): number[] => {
      if (!n) return [];
      const d = f.get(n) as any;
      const a = d.attrs ?? {};
      const sc = Number(a.scale_factor?.value ?? 1), of = Number(a.add_offset?.value ?? 0);
      const fill = a._FillValue?.value;
      return Array.from(d.value as ArrayLike<number>, (v) => (v === fill ? NaN : v * sc + of));
    };
    const latN = pick(/^latitude$/i), lonN = pick(/^longitude$/i), tN = pick(/^flash_time$/i) ?? pick(/time/i);
    const lat = read(latN), lon = read(lonN), tt = read(tN), rad = read(pick(/radiance/i));
    const base = tN ? epoch(String((f.get(tN) as any).attrs?.units?.value ?? "")) : null;
    f.close();
    const out: { t: number; lon: number; lat: number; e: number }[] = [];
    for (let i = 0; i < lat.length; i++) {
      if (!Number.isFinite(lat[i]) || !Number.isFinite(lon[i])) continue;
      const t = base != null && Number.isFinite(tt[i]) ? base + tt[i] * 1000 : fallbackT;
      // Strength 0–3 like GLM's, from the flash's radiance (a rough match, for the dot size).
      const e = Number.isFinite(rad[i]) ? 1e-15 * Math.max(1, rad[i]) : 1e-14;
      out.push({ t, lon: lon[i], lat: lat[i], e });
    }
    if (!out.length) console.warn("[mtg] no flashes read; variables:", names.slice(0, 30).join(","));
    return out;
  } catch (e) {
    console.warn("[mtg] read", String(e).slice(0, 200));
    return [];
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/** Every MTG LI flash in products sensed in [from, to). Empty without keys. */
export async function mtgFlashes(from: number, to: number): Promise<{ t: number; lon: number; lat: number; e: number }[]> {
  const bearer = await token();
  if (!bearer) return [];
  const q = new URLSearchParams({ pi: COLLECTION, dtstart: new Date(from).toISOString(), dtend: new Date(to).toISOString(), format: "json", c: "100" });
  const r = await fetch(`${API}/data/search-products/1.0.0/os?${q}`, { headers: { Authorization: `Bearer ${bearer}` } });
  if (!r.ok) { console.warn("[mtg] search", r.status); return []; }
  const feats: any[] = (await r.json()).features ?? [];
  const out: { t: number; lon: number; lat: number; e: number }[] = [];
  for (let i = 0; i < feats.length; i += 6) {
    const got = await Promise.all(feats.slice(i, i + 6).map((ft) => {
      const id = ft.id ?? ft.properties?.identifier;
      const href = ft.properties?.links?.data?.[0]?.href ?? `${API}/data/download/1.0.0/collections/${encodeURIComponent(COLLECTION)}/products/${encodeURIComponent(id)}`;
      const when = Date.parse(String(ft.properties?.date ?? "").split("/")[0]) || from;
      return readProduct(href, bearer, when);
    }));
    for (const g of got) out.push(...g);
  }
  return out.filter((f) => f.t >= from - 60_000 && f.t < to + 60_000);
}
