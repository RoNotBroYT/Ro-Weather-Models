// Canada's national radar composite (Environment and Climate Change Canada,
// GeoMet "RADAR_1KM_RRAI": precipitation rate, 1 km, every 6 minutes, last
// 3 hours, ~15 minutes behind; Open Government Licence – Canada, commercial
// use allowed with credit).
//
// ECCC publishes this composite only as coloured pictures (WMS), not as raw
// numbers. Its stepped style has 14 exact colours, one per rain-rate band, so
// each pixel is turned back into a rate (the band's middle, geometric) and
// then into dBZ with Marshall–Palmer (Z = 200 R^1.6) — and drawn by the same
// code and colours as OPERA and MRMS. The bands make it a little steppier than
// those two; that is the data, not the drawing.

import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { MrmsField } from "./mrms";

const WMS = "https://geo.weather.gc.ca/geomet";
const STEP = 6 * 60_000;

// Colour → rain rate (mm/h), from the style's own legend (RADARURPPRECIPR14).
const BANDS: [number, number, number, number, number][] = [
  // r, g, b, from, to (mm/h)
  [152, 203, 254, 0.1, 1],
  [0, 152, 254, 1, 2],
  [0, 254, 102, 2, 4],
  [0, 203, 0, 4, 8],
  [0, 152, 0, 8, 12],
  [0, 102, 0, 12, 16],
  [254, 254, 0, 16, 24],
  [254, 203, 0, 24, 32],
  [254, 152, 0, 32, 50],
  [254, 102, 0, 50, 64],
  [254, 0, 0, 64, 100],
  [254, 2, 152, 100, 125],
  [152, 51, 203, 125, 200],
  [102, 0, 152, 200, 300],
];
const BAND_DBZ = BANDS.map(([, , , a, b]) => 10 * Math.log10(200 * Math.pow(Math.sqrt(a * b), 1.6)));

function dbzOf(r: number, g: number, b: number): number {
  let best = -1, bd = 1e9;
  for (let k = 0; k < BANDS.length; k++) {
    const [R, G, B] = BANDS[k];
    const d = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return bd < 900 ? BAND_DBZ[best] : NaN; // anything far from every band (map labels, edges) is ignored
}

/** Roughly where Canada's radars reach: inside it, a clear pixel means dry (not "no data"). */
const covered = (lat: number, lon: number) => lat > 41.5 && lat < 66 && lon > -141 && lon < -52;

const merc = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const R_EARTH = 6378137;

/** The composite for one tile at radar time t (the 6-minute picture at or just before it), or null. */
export async function canadaTile(t: number, west: number, east: number, north: number, south: number, S: number): Promise<MrmsField | null> {
  const ct = Math.floor(t / STEP) * STEP;
  if (Date.now() - ct > 3 * 3_600_000 - STEP) return null; // GeoMet keeps 3 hours
  const x0 = (west * Math.PI * R_EARTH) / 180, x1 = (east * Math.PI * R_EARTH) / 180;
  const y0 = merc(south) * R_EARTH, y1 = merc(north) * R_EARTH;
  const url =
    `${WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=RADAR_1KM_RRAI&STYLES=RADARURPPRECIPR14` +
    `&CRS=EPSG:3857&BBOX=${x0},${y0},${x1},${y1}&WIDTH=${S}&HEIGHT=${S}&FORMAT=image/png&TRANSPARENT=TRUE` +
    `&TIME=${new Date(ct).toISOString().slice(0, 19)}Z`;
  let img;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("image")) return null;
    img = await loadImage(Buffer.from(await r.arrayBuffer()));
  } catch {
    return null;
  }
  const c = createCanvas(S, S);
  const cx = c.getContext("2d");
  cx.drawImage(img, 0, 0, S, S);
  const px = cx.getImageData(0, 0, S, S).data;
  const dbz = new Float32Array(S * S);
  const yN = merc(north), yS = merc(south);
  for (let py = 0; py < S; py++) {
    const lat = (Math.atan(Math.sinh(yN + ((yS - yN) * (py + 0.5)) / S)) * 180) / Math.PI;
    for (let pxx = 0; pxx < S; pxx++) {
      const i = py * S + pxx;
      const lon = west + ((east - west) * (pxx + 0.5)) / S;
      dbz[i] = px[i * 4 + 3] < 128 ? (covered(lat, lon) ? -32 : NaN) : dbzOf(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
    }
  }
  // Sampled like the other sources: any box, by position (the smoothing asks a slightly larger one).
  return {
    time: ct,
    sample: (w, e, n, s, SS) => {
      if (w === west && e === east && n === north && s === south && SS === S) return dbz;
      const out = new Float32Array(SS * SS).fill(NaN);
      const qN = merc(n), qS = merc(s);
      for (let qy = 0; qy < SS; qy++) {
        const fy = (qN + ((qS - qN) * (qy + 0.5)) / SS - yN) / (yS - yN);
        const sy = Math.floor(fy * S);
        if (sy < 0 || sy >= S) continue;
        for (let qx = 0; qx < SS; qx++) {
          const sx = Math.floor(((w + ((e - w) * (qx + 0.5)) / SS - west) / (east - west)) * S);
          if (sx >= 0 && sx < S) out[qy * SS + qx] = dbz[sy * S + sx];
        }
      }
      return out;
    },
  };
}
