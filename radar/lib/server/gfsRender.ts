/**
 * Drawing the worldwide GFS fields (lib/server/gfs.ts) for the Charts page:
 *   renderGfsTile   colour-fill map tiles (Web-Mercator XYZ), WebP
 *   gfsIsobars      isobars every 4 hPa + H/L centres, GeoJSON
 *   gfsWindGrid     10 m wind on a 1° grid, for the animated wind particles
 *   gfsPoint        every layer's value at one point, for the pointer readout
 * Colours, opacity and fades come from lib/chartLayers.ts + lib/fieldRamps.ts
 * — the same definitions the legend is drawn from.
 */
import { createCanvas } from "@napi-rs/canvas";
import { contourGrid } from "./contour";
import { gfsLayer, gfsPrecipType, pickPrecipType, sampleGlobalSmooth, gfsWindUV, sampleGlobal, GFS_LAYERS, GFS_LEADS, RAIN_LEADS, type GfsLayer } from "./gfs";
import { encodeTerrainRgb } from "../radarHeight";
import { chartLayerById } from "../chartLayers";
import { FIELD_RAMPS, rampColour } from "../fieldRamps";

const tile2lon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;

export async function renderGfsTile(
  layer: GfsLayer,
  run: number,
  lead: number,
  z: number,
  x: number,
  y: number,
  scale = 1,
  bare = false
): Promise<Buffer> {
  if (layer === "raincloud") return renderRainCloudTile(run, lead, z, x, y, scale, bare);
  if (layer === "winter" || layer === "winterdepth") return renderWinterTile(run, lead, z, x, y, scale, layer === "winterdepth");
  const f = await gfsLayer(run, lead, layer);
  const def = chartLayerById(layer);
  const stops = FIELD_RAMPS[def.ramp];
  const S = 256 * scale;
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(S, S);
  const n = 2 ** z;
  const west = tile2lon(x, z), east = tile2lon(x + 1, z);
  const alpha = def.fillAlpha * 255;
  const fade = def.fadeIn;
  for (let py = 0; py < S; py++) {
    const my = Math.PI * (1 - (2 * (y + (py + 0.5) / S)) / n);
    const lat = (Math.atan(Math.sinh(my)) * 180) / Math.PI;
    for (let px = 0; px < S; px++) {
      const lon = west + ((east - west) * (px + 0.5)) / S;
      const v = sampleGlobal(f, lat, lon);
      if (v !== v) continue;
      let a = alpha;
      if (fade) {
        const t = (v - fade[0]) / (fade[1] - fade[0]);
        if (t <= 0) continue;
        if (t < 1) a *= t;
      }
      const [r, g, b] = rampColour(v, stops);
      const k = 4 * (py * S + px);
      img.data[k] = r;
      img.data[k + 1] = g;
      img.data[k + 2] = b;
      img.data[k + 3] = Math.round(a);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toBuffer("image/webp", 88);
}

/**
 * Rain overview tile, layered like a forecaster's overview chart: a soft temperature tint on
 * the ground, a translucent white cloud veil over it, then precipitation on top (rain scale;
 * snow, freezing rain and sleet in their own scales where the model says so).
 */
async function renderRainCloudTile(run: number, lead: number, z: number, x: number, y: number, scale: number, bare = false): Promise<Buffer> {
  const [rate, cloud, temp, types] = await Promise.all([
    gfsLayer(run, lead, "rain"), gfsLayer(run, lead, "cloud"), gfsLayer(run, lead, "temperature"), gfsPrecipType(run, lead),
  ]);
  const S = 256 * scale;
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(S, S);
  const n = 2 ** z;
  const west = tile2lon(x, z), east = tile2lon(x + 1, z);
  const def = chartLayerById("rain");
  let col: [number, number, number] = [0, 0, 0], a = 0;
  const over = (c: [number, number, number], ca: number) => {
    const oa = ca + a * (1 - ca);
    if (oa <= 0) return;
    col = [0, 1, 2].map((i) => (c[i] * ca + col[i] * a * (1 - ca)) / oa) as [number, number, number];
    a = oa;
  };
  for (let py = 0; py < S; py++) {
    const my = Math.PI * (1 - (2 * (y + (py + 0.5) / S)) / n);
    const lat = (Math.atan(Math.sinh(my)) * 180) / Math.PI;
    for (let px = 0; px < S; px++) {
      const lon = west + ((east - west) * (px + 0.5)) / S;
      col = [0, 0, 0]; a = 0;
      // `bare` (3D): no ground tint, so the raised surface is only rain and cloud.
      const tc = bare ? NaN : sampleGlobalSmooth(temp, lat, lon);
      if (tc === tc) {
        // Quiet ground: washed towards grey and faint, so the rain and cloud colours read first.
        const g = rampColour(tc, FIELD_RAMPS.overviewTemp);
        over([0, 1, 2].map((i) => g[i] * 0.55 + 150 * 0.45) as [number, number, number], 0.3);
      }
      const c = sampleGlobalSmooth(cloud, lat, lon);
      if (c === c) over([250, 251, 255], 0.5 * (c / 100) ** 1.5);
      const v = sampleGlobalSmooth(rate, lat, lon);
      if (v === v) {
        const t = (v - def.fadeIn![0]) / (def.fadeIn![1] - def.fadeIn![0]);
        if (t > 0) {
          const code = pickPrecipType(types, lat, lon) || 1;
          over(rampColour(v, FIELD_RAMPS[code === 1 ? "rain" : WINTER_RAMPS[code]!]), def.fillAlpha * Math.min(1, t));
        }
      }
      if (a <= 0.01) continue;
      const k = 4 * (py * S + px);
      img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2]; img.data[k + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toBuffer("image/webp", 88);
}

const WINTER_RAMPS = [null, "winterRain", "winterSnow", "winterFrzr", "winterSleet"] as const;

/**
 * Winter tile: rain rate coloured by type (GFS categorical flags), fading in with rate; with
 * `depth`, snow lying (cm) is shaded underneath and the precipitation blended on top.
 */
async function renderWinterTile(run: number, lead: number, z: number, x: number, y: number, scale: number, depth: boolean): Promise<Buffer> {
  const [rate, types, snow] = await Promise.all([
    gfsLayer(run, lead, "rain"), gfsPrecipType(run, lead), depth ? gfsLayer(run, lead, "snowdepth") : null,
  ]);
  const S = 256 * scale;
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(S, S);
  const n = 2 ** z;
  const west = tile2lon(x, z), east = tile2lon(x + 1, z);
  const pdef = chartLayerById("winter"), ddef = chartLayerById("snowdepth");
  for (let py = 0; py < S; py++) {
    const my = Math.PI * (1 - (2 * (y + (py + 0.5) / S)) / n);
    const lat = (Math.atan(Math.sinh(my)) * 180) / Math.PI;
    for (let px = 0; px < S; px++) {
      const lon = west + ((east - west) * (px + 0.5)) / S;
      let col: [number, number, number] = [0, 0, 0], a = 0;
      if (snow) {
        const d = sampleGlobalSmooth(snow, lat, lon);
        if (d === d) {
          const t = (d - ddef.fadeIn![0]) / (ddef.fadeIn![1] - ddef.fadeIn![0]);
          if (t > 0) { col = rampColour(d, FIELD_RAMPS.snowdepth); a = ddef.fillAlpha * Math.min(1, t); }
        }
      }
      const v = sampleGlobalSmooth(rate, lat, lon);
      if (v === v) {
        const t = (v - pdef.fadeIn![0]) / (pdef.fadeIn![1] - pdef.fadeIn![0]);
        if (t > 0) {
          const code = pickPrecipType(types, lat, lon) || 1;
          const pc = rampColour(v, FIELD_RAMPS[WINTER_RAMPS[code]!]);
          const pa = pdef.fillAlpha * Math.min(1, t);
          const oa = pa + a * (1 - pa);
          col = [0, 1, 2].map((i) => (pc[i] * pa + col[i] * a * (1 - pa)) / oa) as [number, number, number];
          a = oa;
        }
      }
      if (a <= 0) continue;
      const k = 4 * (py * S + px);
      img.data[k] = col[0];
      img.data[k + 1] = col[1];
      img.data[k + 2] = col[2];
      img.data[k + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toBuffer("image/webp", 88);
}

/** One pass of Chaikin corner-cutting; keeps closed rings closed. Coordinates to 0.1° (~10 km). */
function smooth(pts: [number, number][], closed: boolean): [number, number][] {
  let p = closed ? pts.slice(0, -1) : pts;
  for (let it = 0; it < 1 && p.length >= 3; it++) {
    const out: [number, number][] = closed ? [] : [p[0]];
    const m = closed ? p.length : p.length - 1;
    for (let i = 0; i < m; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    if (!closed) out.push(p[p.length - 1]);
    p = out;
  }
  const r = p.map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10] as [number, number]);
  return closed ? [...r, r[0]] : r;
}

/**
 * Isobars every 4 hPa on a 1° version of the grid (0.5° lines are no more
 * accurate at chart scale and four times the data), longitudes −180…180,
 * plus H / L centres: the highest / lowest point within 8° that stands at
 * least 5 hPa clear of the highest / lowest value around it — so a flat
 * area does not sprout a scatter of meaningless letters. Polar rows (beyond
 * ±80°) are left out: Mercator cannot draw them.
 */
export async function gfsIsobars(run: number, lead: number): Promise<GeoJSON.FeatureCollection> {
  const f = await gfsLayer(run, lead, "pressure");
  const cols = 361, rows = 161; // lon −180..180, lat 80..−80, 1°
  const vals: (number | null)[] = new Array(cols * rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) vals[r * cols + c] = sampleGlobal(f, 80 - r, -180 + c);
  let min = Infinity, max = -Infinity;
  for (const v of vals) if (v != null) { if (v < min) min = v; if (v > max) max = v; }
  const features: GeoJSON.Feature[] = [];
  for (const line of contourGrid(vals, cols, rows, min, max, 4, 80)) {
    if (line.points.length < 3) continue;
    const pts = line.points.map((p) => [-180 + p.x, 80 - p.y] as [number, number]);
    const a = pts[0], b = pts[pts.length - 1];
    const closed = Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
    // Tiny closed loops (under ~2° round) are grid noise, not systems.
    if (closed && pts.length < 8) continue;
    features.push({
      type: "Feature",
      properties: { kind: "isobar", level: Math.round(line.level), label: String(Math.round(line.level)) },
      geometry: { type: "LineString", coordinates: smooth(pts, closed) },
    });
  }
  const R = 8;
  for (let r = R; r < rows - R; r++)
    for (let c = 0; c < cols - 1; c++) {
      const v = vals[r * cols + c] as number;
      let lo = true, hi = true, nMax = -Infinity, nMin = Infinity;
      for (let dy = -R; dy <= R && (lo || hi); dy++)
        for (let dx = -R; dx <= R; dx++) {
          if (!dx && !dy) continue;
          const cc = (((c + dx) % 360) + 360) % 360;
          const n = vals[(r + dy) * cols + cc] as number;
          if (n <= v) lo = false;
          if (n >= v) hi = false;
          if (n > nMax) nMax = n;
          if (n < nMin) nMin = n;
        }
      if (lo && nMax - v >= 5) {
        features.push({ type: "Feature", properties: { kind: "L", text: `L\n${Math.round(v)}` }, geometry: { type: "Point", coordinates: [-180 + c, 80 - r] } });
      } else if (hi && v - nMin >= 5) {
        features.push({ type: "Feature", properties: { kind: "H", text: `H\n${Math.round(v)}` }, geometry: { type: "Point", coordinates: [-180 + c, 80 - r] } });
      }
    }
  return { type: "FeatureCollection", features };
}

/**
 * Contour lines for an upper-air layer (z500 every 6 dam, t850 every 4 °C,
 * thickness every 6 dam), same 1° grid and smoothing as the isobars.
 * Properties: kind "contour", level, label (and major: 528 dam thickness,
 * 0 °C at 850 hPa, every 2nd z500 line — drawn bolder).
 */
export async function gfsContours(run: number, lead: number, layer: GfsLayer): Promise<GeoJSON.FeatureCollection> {
  const f = await gfsLayer(run, lead, layer);
  const step = layer === "temperature" ? 4 : chartLayerById(layer).contourStep || 6;
  const levels = layer === "snowdepth" ? [1, 5, 10, 25, 50] : null;
  const cols = 361, rows = 161;
  const vals: (number | null)[] = new Array(cols * rows);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) { const v = sampleGlobal(f, 80 - r, -180 + c); vals[r * cols + c] = v === v ? v : layer === "snowdepth" ? 0 : v; }
  let min = Infinity, max = -Infinity;
  for (const v of vals) if (v != null) { if (v < min) min = v; if (v > max) max = v; }
  const features: GeoJSON.Feature[] = [];
  const lines = levels ? levels.flatMap((lv) => (max >= lv ? contourGrid(vals, cols, rows, lv + 0.01, lv + 0.01, lv + 0.01, 1) : [])) : contourGrid(vals, cols, rows, min, max, step, 80);
  for (const line of lines) {
    if (line.points.length < 3) continue;
    const pts = line.points.map((p) => [-180 + p.x, 80 - p.y] as [number, number]);
    const a = pts[0], b = pts[pts.length - 1];
    const closed = Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
    if (closed && pts.length < 8) continue;
    if (levels) {
      features.push({ type: "Feature", properties: { kind: "contour", level: Math.round(line.level), label: `${Math.round(line.level)} cm`, major: 0 }, geometry: { type: "LineString", coordinates: smooth(pts, closed) } });
      continue;
    }
    const level = Math.round(line.level);
    const major = layer === "thickness" ? level === 528 : layer === "t850" || layer === "temperature" ? level === 0 : level % 12 === 0;
    features.push({
      type: "Feature",
      properties: { kind: "contour", level, label: String(level), major: major ? 1 : 0 },
      geometry: { type: "LineString", coordinates: smooth(pts, closed) },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Every layer's value at one point (NaN → null), plus the 10 m wind direction (FROM). */
export async function gfsPoint(run: number, lead: number, lat: number, lon: number) {
  const out: Record<string, number | null> = {};
  // Rain too (its own steps, out to 16 days; the other layers stop at 5): a tap on the
  // Rain chart read nothing before. Each layer only where this lead is one of its steps.
  const layers: GfsLayer[] = [...(GFS_LEADS.includes(lead) ? GFS_LAYERS : []), ...(RAIN_LEADS.includes(lead) ? ((["rain", "snowdepth", "cloud", ...(GFS_LEADS.includes(lead) ? [] : ["thickness", "temperature", "pressure"])] as GfsLayer[])) : [])];
  await Promise.all(
    layers.map(async (l) => {
      const v = sampleGlobal(await gfsLayer(run, lead, l), lat, lon);
      out[l] = v === v ? Math.round(v * 10) / 10 : null;
    })
  );
  if (RAIN_LEADS.includes(lead)) {
    // Winter chart readout: type (0 none, 1 rain, 2 snow, 3 freezing rain, 4 sleet) and rate.
    out.winter = out.rain;
    out.ptype = pickPrecipType(await gfsPrecipType(run, lead), lat, lon);
  }
  if (GFS_LEADS.includes(lead)) {
    const [u, v] = await gfsWindUV(run, lead);
    const uu = sampleGlobal(u, lat, lon), vv = sampleGlobal(v, lat, lon);
    out.windFrom = uu === uu ? Math.round(((Math.atan2(-uu, -vv) * 180) / Math.PI + 360) % 360) : null;
  }
  return out;
}

/**
 * 10 m wind as a compact 1° grid for the animated wind particles:
 * lat 85…−85 (171 rows), lon −180…179 (360 columns), U and V in m/s × 10,
 * packed as Int16 and base64-encoded (~120 KB per component before gzip).
 */
export async function gfsWindGrid(run: number, lead: number) {
  const [u, v] = await gfsWindUV(run, lead);
  const nx = 360, ny = 171;
  const U = new Int16Array(nx * ny), V = new Int16Array(nx * ny);
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const lat = 85 - j, lon = -180 + i;
      U[j * nx + i] = Math.round(sampleGlobal(u, lat, lon) * 10);
      V[j * nx + i] = Math.round(sampleGlobal(v, lat, lon) * 10);
    }
  return {
    lat0: 85,
    lon0: -180,
    step: 1,
    nx,
    ny,
    scale: 10,
    u: Buffer.from(U.buffer).toString("base64"),
    v: Buffer.from(V.buffer).toString("base64"),
  };
}

/**
 * 3D height tile (Mapbox terrain-RGB PNG) for the Charts overview 3D mode: precipitation rate
 * raised (about 3.5 km per mm/h^0.65) plus a gentle swell from cloud cover. A drawing aid:
 * height shows rain intensity and cloud amount, not cloud height. Before the view's own exaggeration.
 */
export async function renderGfsDem(layer: GfsLayer, run: number, lead: number, z: number, x: number, y: number): Promise<Buffer> {
  const windy = layer === "wind";
  const [rate, cloud] = await Promise.all([gfsLayer(run, lead, windy ? "wind" : "rain"), layer === "raincloud" ? gfsLayer(run, lead, "cloud") : null]);
  const S = 256;
  const heights = new Float32Array(S * S);
  const n = 2 ** z;
  const west = tile2lon(x, z), east = tile2lon(x + 1, z);
  for (let py = 0; py < S; py++) {
    const my = Math.PI * (1 - (2 * (y + (py + 0.5) / S)) / n);
    const lat = (Math.atan(Math.sinh(my)) * 180) / Math.PI;
    for (let px = 0; px < S; px++) {
      const lon = west + ((east - west) * (px + 0.5)) / S;
      const r = sampleGlobalSmooth(rate, lat, lon);
      // Wind: speed (m/s) raised as a smooth swell; rain: rate (mm/h) as before.
      let h = windy ? (r === r && r > 1 ? 260 * Math.min(r, 40) : 0) : r === r && r > 0.05 ? 3500 * Math.pow(Math.min(r, 20), 0.65) : 0;
      if (cloud) {
        const c = sampleGlobalSmooth(cloud, lat, lon);
        if (c === c) h += 900 * (c / 100) ** 2;
      }
      heights[py * S + px] = h;
    }
  }
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(S, S);
  encodeTerrainRgb(heights, img.data);
  ctx.putImageData(img, 0, 0);
  return canvas.toBuffer("image/png");
}
