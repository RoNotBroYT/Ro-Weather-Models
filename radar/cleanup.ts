// One-off / daily: delete map pictures older than 24 h from the Backblaze bucket
// (free storage is 10 GB; deletes cost nothing). The base map is never touched.
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
const s3 = new S3Client({ region: process.env.R2_REGION ?? "auto", endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! } });
const Bucket = process.env.R2_BUCKET!;
const cutoff = Date.now() - 24 * 3600_000;
let total = 0;
for (const Prefix of ["tile/", "nowcast/", "s2/", "s3/", "sat/", "lightning/"]) {
  let token: string | undefined; let n = 0;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken: token, MaxKeys: 1000 }));
    const old = (r.Contents ?? []).filter((o) => o.LastModified && o.LastModified.getTime() < cutoff && !/index\.json$|live\.json$/.test(o.Key!));
    for (let i = 0; i < old.length; i += 1000) {
      await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: old.slice(i, i + 1000).map((o) => ({ Key: o.Key! })), Quiet: true } }));
    }
    n += old.length;
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  console.log(`${Prefix} deleted ${n}`); total += n;
}
console.log(`total deleted ${total}`);
