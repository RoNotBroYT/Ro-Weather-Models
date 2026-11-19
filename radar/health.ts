// Free-limit safety check (owner, 19 Nov 2026: never "full, come back tomorrow").
// Every hour: how close each free allowance is, cleans up early when something is filling, and
// FAILS the GitHub job (so GitHub emails the owner) once anything passes the warning line.
//   - each D1 shard (500 MB free each): above 70% delete expired rows; above 85% warn
//   - Workers requests today (100,000 a day free): above 70% warn
//   - Backblaze bucket (10 GB free): above 75% warn
import { readFileSync } from "node:fs";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

const ACC = process.env.CF_ACCOUNT_ID!, TOKEN = process.env.CF_API_TOKEN!;
const cf = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  return r.json() as Promise<any>;
};
const warnings: string[] = [];
const line = (s: string) => console.log(s);

// D1 shards, from the worker's own settings.
const ids = [...readFileSync(new URL("../maps-worker/wrangler.toml", import.meta.url), "utf8").matchAll(/database_id = "([0-9a-f-]+)"/g)].map((m) => m[1]);
const D1_MAX = 500 * 1024 * 1024;
for (const id of ids) {
  const j = await cf(`/accounts/${ACC}/d1/database/${id}`);
  const size = j?.result?.file_size ?? 0, name = j?.result?.name ?? id;
  let pct = Math.round((size / D1_MAX) * 100);
  if (pct >= 70) {
    const now = Math.floor(Date.now() / 1000);
    await cf(`/accounts/${ACC}/d1/database/${id}/query`, { method: "POST", body: JSON.stringify({ sql: "DELETE FROM tiles WHERE exp < ?", params: [now] }) });
    const after = (await cf(`/accounts/${ACC}/d1/database/${id}`))?.result?.file_size ?? size;
    line(`${name}: ${pct}% -> cleaned expired rows -> ${Math.round((after / D1_MAX) * 100)}%`);
    pct = Math.round((after / D1_MAX) * 100);
  } else line(`${name}: ${pct}%`);
  if (pct >= 85) warnings.push(`D1 ${name} at ${pct}% of 500 MB even after clean-up`);
}

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
  if (r?.errors?.length) line(`(analytics: ${String(r.errors[0]?.message).slice(0, 120)})`);
} catch (e) { line(`Workers requests: could not read (${String(e).slice(0, 100)})`); }

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
