// Snow on the ground (17 Nov): NOAA's daily IMS snow and ice map (public domain, 4 km, northern
// hemisphere, made from satellites and ground reports), turned once a day into a see-through
// picture over Europe for the maps: white where snow is lying, pale blue for sea and lake ice.
//   snowcover/latest.png  (Web Mercator, lon −25…45, lat 34…72)
//   snowcover/latest.json {date, bounds}
// The grid is polar stereographic: true at 60°N, straight down from the pole along 80°W, 4 km.
import { createCanvas } from "@napi-rs/canvas";
import { gunzipSync } from "zlib";

const N = 6144, CELL = 4.0, R = 6371.2;
export const BOUNDS = { west: -25, east: 45, south: 34, north: 72 };

export async function latestIms(): Promise<{ day: string; grid: Uint8Array } | null> {
  for (let back = 0; back < 4; back++) {
    const d = new Date(Date.now() - back * 86_400_000), y = d.getUTCFullYear();
    const doy = Math.floor((d.getTime() - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
    const url = `https://noaadata.apps.nsidc.org/NOAA/G02156/4km/${y}/ims${y}${String(doy).padStart(3, "0")}_00UTC_4km_v1.3.asc.gz`;
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) }).catch(() => null);
    if (!r?.ok) continue;
    const lines = gunzipSync(Buffer.from(await r.arrayBuffer())).toString("latin1").split("\n").map((l) => l.trim()).filter((l) => /^[0-4]+$/.test(l) && l.length >= N);
    if (lines.length < N) continue;
    const rows = lines.slice(-N);                      // the first data row is the bottom (south) edge
    const grid = new Uint8Array(N * N);
    for (let j = 0; j < N; j++) { const l = rows[j]; for (let i = 0; i < N; i++) grid[j * N + i] = l.charCodeAt(i) - 48; }
    return { day: `${y}-${String(doy).padStart(3, "0")}`, grid };
  }
  return null;
}

/** IMS value at a place (row 0 = bottom). */
export function imsAt(grid: Uint8Array, lat: number, lon: number): number {
  const phi = (lat * Math.PI) / 180, lam = ((lon + 80) * Math.PI) / 180;
  const k = (1 + Math.sin((60 * Math.PI) / 180)) / 2;
  const rho = 2 * R * k * Math.tan(Math.PI / 4 - phi / 2);
  const x = rho * Math.sin(lam), y = -rho * Math.cos(lam);
  const i = Math.floor(x / CELL + N / 2), j = Math.floor(y / CELL + N / 2);
  if (i < 0 || j < 0 || i >= N || j >= N) return 0;
  return grid[j * N + i];
}

/** The overlay picture (Web Mercator over BOUNDS). */
export async function snowPicture(grid: Uint8Array, W = 1400): Promise<Buffer> {
  const merc = (la: number) => Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360));
  const H = Math.round((W * (merc(BOUNDS.north) - merc(BOUNDS.south))) / (((BOUNDS.east - BOUNDS.west) * Math.PI) / 180));
  const c = createCanvas(W, H), cx = c.getContext("2d"), img = cx.createImageData(W, H);
  for (let py = 0; py < H; py++) {
    const m = merc(BOUNDS.north) - ((merc(BOUNDS.north) - merc(BOUNDS.south)) * (py + 0.5)) / H;
    const lat = (Math.atan(Math.sinh(m)) * 180) / Math.PI;
    for (let px = 0; px < W; px++) {
      const lon = BOUNDS.west + ((BOUNDS.east - BOUNDS.west) * (px + 0.5)) / W;
      const v = imsAt(grid, lat, lon), o = (py * W + px) * 4;
      if (v === 4) { img.data[o] = 245; img.data[o + 1] = 250; img.data[o + 2] = 255; img.data[o + 3] = 200; }
      else if (v === 3) { img.data[o] = 170; img.data[o + 1] = 215; img.data[o + 2] = 255; img.data[o + 3] = 150; }
    }
  }
  cx.putImageData(img, 0, 0);
  return c.encode("png");
}

if (import.meta.main) {
  const out = process.argv[2];
  const ims = await latestIms();
  if (!ims) { console.log("no IMS file"); process.exit(1); }
  for (const [n, la, lo] of [["Greenland", 72, -40], ["Atlantic", 50, -25], ["Alps (Zermatt)", 46.0, 7.75], ["London", 51.5, -0.1], ["Norway (Finse)", 60.6, 7.5], ["Cairngorms", 57.1, -3.65]] as const)
    console.log(n.padEnd(16), imsAt(ims.grid, la, lo));
  if (out) await Bun.write(out, await snowPicture(ims.grid));
  console.log("IMS", ims.day);
}
