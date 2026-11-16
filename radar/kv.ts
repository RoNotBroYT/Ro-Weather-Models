// The small lists (what's ready, the chart run) live in Cloudflare KV, not Backblaze: KV's free
// plan reads 100,000 a day, where Backblaze's free download allowance (2,500 a day) was used up
// by these lists alone by midday (16 Nov). The Worker on radar.ro-weather.app reads KV first.
const ACC = process.env.CF_ACCOUNT_ID, NS = process.env.CF_KV_NS, TOKEN = process.env.CF_API_TOKEN;
const on = !!(ACC && NS && TOKEN);
const url = (key: string) => `https://api.cloudflare.com/client/v4/accounts/${ACC}/storage/kv/namespaces/${NS}/values/${encodeURIComponent(key)}`;

export async function kvGet(key: string): Promise<string | null> {
  if (!on) return null;
  try {
    const r = await fetch(url(key), { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(15000) });
    return r.ok ? await r.text() : null;
  } catch { return null; }
}

export async function kvPut(key: string, body: string | Buffer): Promise<void> {
  if (!on) return;
  try {
    const r = await fetch(url(key), { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}` }, body, signal: AbortSignal.timeout(15000) });
    if (!r.ok) console.warn("kv put", key, r.status, (await r.text()).slice(0, 200));
  } catch (e) { console.warn("kv put", key, String(e).slice(0, 200)); }
}
