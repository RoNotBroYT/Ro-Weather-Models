// radar.ro-weather.app: serves map pictures from the private Backblaze bucket
// "ro-weather-maps" (free, no card). Every reply is kept in Cloudflare's free cache,
// so Backblaze is asked once per picture. Free plan: if the daily request limit is
// hit it stops for the day, it never bills.
let auth = null; // { token, url, until }

async function authorize(env) {
  if (auth && Date.now() < auth.until) return auth;
  // Shared across every Worker copy via KV, so Backblaze is logged in to about once a day
  // (each login counts against its small free daily allowance).
  if (env.LISTS) {
    const saved = await env.LISTS.get("_b2auth", "json");
    if (saved && Date.now() < saved.until) { auth = saved; return auth; }
  }
  const r = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: { Authorization: "Basic " + btoa(`${env.B2_KEY_ID}:${env.B2_APP_KEY}`) },
  });
  if (!r.ok) throw new Error("b2 auth " + r.status);
  const j = await r.json();
  auth = { token: j.authorizationToken, url: j.apiInfo.storageApi.downloadUrl, until: Date.now() + 20 * 3600_000 };
  if (env.LISTS) await env.LISTS.put("_b2auth", JSON.stringify(auth), { expirationTtl: 20 * 3600 });
  return auth;
}

// Drawn pictures live in D1 (17 Nov), 16x16 squares packed per row: Backblaze's free
// 2,500 downloads a day ran out. A row: u32 count, then per square u16 x, u16 y, u32 offset,
// u32 length, then the pictures. Big blocks are split into parts, each with its own index.
const B = 16;
const PICT = /^((?:tile|nowcast|s3|gfs\/tile)\/.+)\/(\d+)\/(\d+)\/(\d+)(@2x)?\.webp$/;
// Which of the eight databases a row lives in: two per kind, chosen by the row's own key.
function shard(env, k) {
  const kind = k.startsWith("tile/") ? 0 : k.startsWith("nowcast/") ? 1 : k.startsWith("s3/") ? 2 : 3;
  let h = 2166136261;
  for (let i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619); }
  return env["T" + (kind * 2 + ((h >>> 0) & 1))];
}
const ALL = (env) => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => env["T" + i]).filter(Boolean);

async function fromD1(env, key) {
  const m = PICT.exec(key);
  if (!m || !env.T0) return null;
  const [, g, z, xs, ys, s = ""] = m, x = +xs, y = +ys;
  const blk = `${g}/${z}/${Math.floor(x / B)}/${Math.floor(y / B)}${s}`;
  let { results } = await shard(env, blk).prepare("SELECT data FROM tiles WHERE k = ?").bind(blk).all();
  if (!results?.length && env.DB) ({ results } = await env.DB.prepare("SELECT data FROM tiles WHERE k = ?").bind(blk).all());
  for (const r of results ?? []) {
    const u = new Uint8Array(r.data), v = new DataView(u.buffer, u.byteOffset, u.byteLength);
    const n = v.getUint32(0), base = 4 + n * 12;
    for (let i = 0; i < n; i++) {
      const o = 4 + i * 12;
      if (v.getUint16(o) === x && v.getUint16(o + 2) === y) {
        const off = v.getUint32(o + 4), len = v.getUint32(o + 8);
        return u.slice(base + off, base + off + len);
      }
    }
  }
  return null;
}

// The radar job sends finished blocks here (secret key). Body: per row u16 key length, key,
// u32 part, u32 expiry (unix seconds), u32 data length, data. Old rows go each time.
async function store(req, env) {
  if (!env.PUT_KEY || req.headers.get("x-put-key") !== env.PUT_KEY) return new Response("no", { status: 403 });
  const u = new Uint8Array(await req.arrayBuffer()), v = new DataView(u.buffer);
  const td = new TextDecoder(), rows = [];
  for (let o = 0; o < u.length; ) {
    const kl = v.getUint16(o); o += 2;
    const k = td.decode(u.subarray(o, o + kl)); o += kl;
    const part = v.getUint32(o), exp = v.getUint32(o + 4), dl = v.getUint32(o + 8); o += 12;
    rows.push([k, part, exp, u.slice(o, o + dl)]); o += dl;
  }
  // Per database: drop the old rows of these keys, then write the new ones.
  const per = new Map();
  for (const r of rows) { const db = shard(env, r[0]); if (!per.has(db)) per.set(db, []); per.get(db).push(r); }
  for (const [db, rs] of per) {
    const keys = [...new Set(rs.map((r) => r[0]))];
    await db.batch([
      ...keys.map((k) => db.prepare("DELETE FROM tiles WHERE k = ?").bind(k)),
      ...rs.map(([k, part, exp, d]) => db.prepare("INSERT OR REPLACE INTO tiles (k, part, exp, data) VALUES (?, ?, ?, ?)").bind(k, part, exp, d)),
    ]);
  }
  if (new URL(req.url).searchParams.has("clean")) {
    const now = Math.floor(Date.now() / 1000);
    await Promise.all([...ALL(env), env.DB].filter(Boolean).map((db) => db.prepare("DELETE FROM tiles WHERE exp < ?").bind(now).run().catch(() => null)));
  }
  return new Response(`stored ${rows.length}`, { status: 200 });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/_put") return store(req, env).catch((e) => new Response("store failed: " + String(e?.message ?? e).slice(0, 300), { status: 500 }));
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("no", { status: 405 });
    const key = decodeURIComponent(url.pathname.slice(1));
    if (!key) return new Response("Ro-Weather maps", { status: 200 });
    const cache = caches.default;
    const cacheKey = new Request(url.origin + url.pathname);
    let res = await cache.match(cacheKey);
    if (res) return res;
    // The small lists the radar job keeps (what's ready, the chart run): from KV, free and
    // generous, so they never use up Backblaze's daily download allowance (16 Nov).
    if (env.LISTS && /\.(json|bin)$/.test(key)) {
      const v = await env.LISTS.get(key, "arrayBuffer");
      if (v) {
        const hk = new Headers({ "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=60",
          "Content-Type": key.endsWith(".json") ? "application/json" : "application/octet-stream" });
        res = new Response(v, { status: 200, headers: hk });
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      }
    }
    const pic = await fromD1(env, key).catch(() => null);
    if (pic) {
      const hk = new Headers({ "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400, immutable",
        "Content-Type": pic[0] === 0x52 && pic[1] === 0x49 ? "image/webp" : "image/jpeg" });
      res = new Response(pic, { status: 200, headers: hk });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    }
    // Chart line files and wind grids, stored whole in D1 under their own address.
    if (env.T0 && /^(gfs\/(isobars|contours|windgrid)|lightning|snowcover)\//.test(key)) {
      const row = await shard(env, key).prepare("SELECT data FROM tiles WHERE k = ? AND part = 0").bind(key).first().catch(() => null);
      if (row) {
        // Live lightning changes every 20 s, its list every 5 min; the rest never changes.
        const age = key === "lightning/live.json" ? "public, max-age=15" : key === "lightning/index.json" ? "public, max-age=60" : key.startsWith("snowcover/") ? "public, max-age=1800" : "public, max-age=86400, immutable";
        res = new Response(new Uint8Array(row.data), { status: 200, headers: { "Access-Control-Allow-Origin": "*", "Cache-Control": age, "Content-Type": key.endsWith(".png") ? "image/png" : "application/json" } });
        ctx.waitUntil(cache.put(cacheKey, res.clone()));
        return res;
      }
    }
    let a = await authorize(env);
    const path = `${a.url}/file/${env.B2_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
    let b = await fetch(path, { headers: { Authorization: a.token } });
    if (b.status === 401) { auth = null; if (env.LISTS) await env.LISTS.delete("_b2auth"); a = await authorize(env); b = await fetch(path, { headers: { Authorization: a.token } }); }
    const h = new Headers();
    h.set("Access-Control-Allow-Origin", "*");
    h.set("Content-Type", b.headers.get("Content-Type") ?? "application/octet-stream");
    if (!b.ok) {
      // Never keep a failure in Cloudflare's cache (a 502 was being served for hours, 17 Nov).
      h.set("Cache-Control", "no-store");
      return new Response(null, { status: b.status === 404 ? 404 : 502, headers: h });
    } else {
      // Live files (lists, lightning) change; drawn pictures never do.
      const live = /\.(json|bin)$/.test(key);
      h.set("Cache-Control", live ? "public, max-age=60" : "public, max-age=86400, immutable");
      res = new Response(b.body, { status: 200, headers: h });
    }
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
