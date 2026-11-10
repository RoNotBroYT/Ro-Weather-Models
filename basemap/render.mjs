/**
 * Draws the site's base maps (OpenFreeMap Liberty and Dark, with the same street
 * detail the radar page strips) as ready-made 512-px picture squares for zoom 0–7,
 * so the radar page shows a finished map at once (like satellite), instead of
 * every visitor's browser building it from raw map data.
 *   basemap/<style>/<z>/<x>/<y>.webp  in R2 (ro-weather-radar), or ./out locally.
 * Run by .github/workflows/basemap.yml now and then (the map hardly changes).
 *   node render.mjs <style> <zFrom> <zTo> [shard] [shards]
 */
import mbgl from "@maplibre/maplibre-gl-native";
import sharp from "sharp";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs/promises";

const [style = "liberty", z0 = "0", z1 = "3", shard = "0", shards = "1"] = process.argv.slice(2);
const STYLE_URL = `https://tiles.openfreemap.org/styles/${style}`;
// Same as WeatherRadar.tsx DETAIL: the radar page never shows these.
const DETAIL = /^(building|aeroway|road_area_pier|road_pier|highway_path|highway_minor|road_oneway|railway|highway_name_other|landuse_|landcover_wood|place_other|place_suburb)/;

const local = !process.env.R2_ENDPOINT;
const s3 = local ? null : new S3Client({ region: process.env.R2_REGION ?? "auto", endpoint: process.env.R2_ENDPOINT, credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY } });
const put = async (key, buf) => {
  if (local) { await fs.mkdir(`out/${key.replace(/\/[^/]+$/, "")}`, { recursive: true }); return fs.writeFile(`out/${key}`, buf); }
  await s3.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET ?? "ro-weather-radar", Key: key, Body: buf, ContentType: "image/webp", CacheControl: "public, max-age=604800" }));
};

const styleJson = await fetch(STYLE_URL).then((r) => r.json());
// No place names: pictures cut names off at their edges, so the site draws the names
// live on top (light work) and these pictures carry everything else.
styleJson.layers = styleJson.layers.filter((l) => !DETAIL.test(l.id) && l.type !== "symbol");

const map = new mbgl.Map({
  ratio: 2,
  request: (req, cb) => {
    fetch(req.url).then(async (r) => {
      if (r.status === 204 || r.status === 404) return cb();
      if (!r.ok) return cb(new Error(`${r.status} ${req.url}`));
      cb(null, { data: Buffer.from(await r.arrayBuffer()) });
    }).catch((e) => cb(e));
  },
});
map.load(styleJson);
const render = (opts) => new Promise((ok, no) => map.render(opts, (e, px) => (e ? no(e) : ok(px))));

// Centre of square x/y at zoom z; maplibre-native's zoom is for 512-px squares, so
// a 256-px-tile zoom z square drawn at 512 px (ratio 2, 256 css px) uses zoom z.
const lon = (x, z) => (x / 2 ** z) * 360 - 180;
const lat = (y, z) => { const n = Math.PI - (2 * Math.PI * y) / 2 ** z; return (180 / Math.PI) * Math.atan(Math.sinh(n)); };

// Drawn in blocks of up to 8×8 squares with a one-square margin all round, then cut
// up: drawing each square alone cut place names off at every edge ("Kingdor").
const M = 8;
let done = 0, i = 0;
const t0 = Date.now();
for (let z = +z0; z <= +z1; z++) {
  const n = 2 ** z, m = Math.min(M, n);
  for (let bx = 0; bx < n; bx += m)
    for (let by = 0; by < n; by += m) {
      if (i++ % +shards !== +shard) continue;
      const pad = n > m ? 1 : 0; // the whole world fits: no margin needed
      const w = (m + 2 * pad) * 256; // css px
      // Block centre; latitude from Mercator y so the margin is even top and bottom.
      const cx = bx + m / 2, cy = by + m / 2;
      const px = await render({ zoom: z - 1, center: [lon(cx, z), lat(cy, z)], width: w, height: w });
      const W = w * 2;
      const img = sharp(px, { raw: { width: W, height: W, channels: 4 } });
      const full = await img.png().toBuffer();
      for (let dx = 0; dx < m; dx++)
        for (let dy = 0; dy < m; dy++) {
          const buf = await sharp(full).extract({ left: (pad + dx) * 512, top: (pad + dy) * 512, width: 512, height: 512 }).webp({ quality: 82 }).toBuffer();
          await put(`basemap/${style}/${z}/${bx + dx}/${by + dy}.webp`, buf);
          done++;
        }
    }
}
map.release();
console.log(`${style} z${z0}-${z1} shard ${shard}/${shards}: ${done} squares, ${Math.round((Date.now() - t0) / 1000)} s`);
