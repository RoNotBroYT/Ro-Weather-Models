// Free-limit safety check (owner, 19 Nov 2026: never "full, come back tomorrow").
// Every hour: how close each free allowance is, cleans up early when something is filling, and
// FAILS the GitHub job (so GitHub emails the owner) once anything passes the warning line.
//   - each D1 shard (500 MB free each): above 70% delete expired rows; above 85% warn
//   - Workers requests today (100,000 a day free): above 70% warn
//   - Backblaze bucket (10 GB free): above 75% warn
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const ACC = process.env.CF_ACCOUNT_ID!, TOKEN = process.env.CF_API_TOKEN!;
const cf = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  return r.json() as Promise<any>;
};
const warnings: string[] = [];
const line = (s: string) => console.log(s);

// D1 shards: sizes from the radar worker itself (our API key can't read D1). Above 70% the worker's
// own clean route deletes expired rows on every shard.
const D1_MAX = 500 * 1024 * 1024;
const health = async (trim = false) => {
  const j = (await (await fetch("https://radar.ro-weather.app/_health" + (trim ? "?trim=1" : ""), { headers: { "x-put-key": process.env.MAPS_PUT_KEY! } })).json()) as { sizes: ({ file: number | null; free: number | null } | null)[] };
  j.sizes.forEach((x: any, i) => { if (x?.trimError) line(`  shard ${i} trim: ${x.trimError}`); });
  // In use = the file minus pages SQLite freed (it re-uses those before growing).
  return { sizes: j.sizes.map((x) => (x && x.file != null ? x.file - (x.free ?? 0) : null)) };
};
let { sizes } = await health();
if (sizes.some((x) => x != null && x / D1_MAX >= 0.7)) {
  await fetch("https://radar.ro-weather.app/_put?clean=1", { method: "POST", headers: { "x-put-key": process.env.MAPS_PUT_KEY!, "content-type": "application/octet-stream" }, body: new Uint8Array(0) }).catch(() => null);
  line("A shard passed 70%: asked the worker to delete expired rows");
  ({ sizes } = await health(true));   // and trim any still over 75%
}
sizes.forEach((x, i) => {
  if (x == null) { warnings.push(`D1 shard ${i}: size could not be read`); return; }
  const pct = Math.round((x / D1_MAX) * 100);
  line(`D1 shard ${i}: ${(x / 1e6).toFixed(0)} MB (${pct}%)`);
  if (pct >= 85) warnings.push(`D1 shard ${i} at ${pct}% of 500 MB even after clean-up`);
});

// Workers requests so far today (UTC), all workers on the account.
try {
  const day = new Date().toISOString().slice(0, 10);
  const q = `query { viewer { accounts(filter:{accountTag:"${ACC}"}) { workersInvocationsAdaptive(limit:100, filter:{date_geq:"${day}"}) { sum { requests } } } } }`;
  const r = await (await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: q }) })).json() as any;
  const rows = r?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  const req = rows.reduce((a: number, x: any) => a + (x.sum?.requests ?? 0), 0);
  const pct = Math.round((req / 100_000) * 100);
  line(`Workers requests today: ${req} (${pct}% of 100,000)`);
  if (pct >= 70) warnings.push(`Workers at ${pct}% of the free 100,000 requests today`);
  if (r?.errors?.length) line(`Workers requests: not readable with this key (${String(r.errors[0]?.message).slice(0, 80)}); the owner can add "Account Analytics: Read" to CF_API_TOKEN`);
} catch (e) { line(`Workers requests: could not read (${String(e).slice(0, 100)})`); }

// D1 rows written so far today (UTC), all databases: the free 100,000 a day is a hard stop (on
// 20 Nov the radar froze at 20:15 when it ran out).
try {
  const day = new Date().toISOString().slice(0, 10);
  const q = `query { viewer { accounts(filter:{accountTag:"${ACC}"}) { d1AnalyticsAdaptiveGroups(limit:50, filter:{date_geq:"${day}"}) { sum { rowsWritten } } } } }`;
  const r = await (await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ query: q }) })).json() as any;
  const rows = r?.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
  const w = rows.reduce((a: number, x: any) => a + (x.sum?.rowsWritten ?? 0), 0);
  const hrs = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;
  const pct = Math.round((w / 100_000) * 100), pace = hrs > 1 ? Math.round((w / hrs) * 24 / 1000) : null;
  line(`D1 rows written today: ${w} (${pct}% of 100,000${pace != null ? `, on pace for ~${pace}k` : ""})`);
  if (pct >= 70 || (pace != null && pace >= 90)) warnings.push(`D1 writes at ${pct}% of the free 100,000 a day (pace ~${pace}k)`);
} catch (e) { line(`D1 writes: could not read (${String(e).slice(0, 100)})`); }

// Backblaze bucket size.
try {
  const s3 = new S3Client({ region: process.env.R2_REGION ?? "auto", endpoint: process.env.R2_ENDPOINT,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! } });
  let bytes = 0, token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET!, ContinuationToken: token, MaxKeys: 1000 }));
    for (const o of r.Contents ?? []) bytes += o.Size ?? 0;
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  const pct = Math.round((bytes / 10e9) * 100);
  line(`Backblaze: ${(bytes / 1e9).toFixed(2)} GB (${pct}% of 10 GB)`);
  if (pct >= 75) warnings.push(`Backblaze at ${pct}% of 10 GB`);
} catch (e) { line(`Backblaze: could not read (${String(e).slice(0, 100)})`); }

if (warnings.length) {
  console.error("WARNING: " + warnings.join("; "));
  process.exit(1);   // GitHub emails the owner about the failed job
}
line("All free limits fine.");
