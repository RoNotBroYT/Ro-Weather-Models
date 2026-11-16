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

export default {
  async fetch(req, env, ctx) {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("no", { status: 405 });
    const url = new URL(req.url);
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
    let a = await authorize(env);
    const path = `${a.url}/file/${env.B2_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
    let b = await fetch(path, { headers: { Authorization: a.token } });
    if (b.status === 401) { auth = null; if (env.LISTS) await env.LISTS.delete("_b2auth"); a = await authorize(env); b = await fetch(path, { headers: { Authorization: a.token } }); }
    const h = new Headers();
    h.set("Access-Control-Allow-Origin", "*");
    h.set("Content-Type", b.headers.get("Content-Type") ?? "application/octet-stream");
    if (!b.ok) {
      h.set("Cache-Control", "public, max-age=60");
      res = new Response(null, { status: b.status === 404 ? 404 : 502, headers: h });
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
