// One-off / daily: delete map pictures older than 24 h from the Backblaze bucket
// (free storage is 10 GB; deletes cost nothing). The base map is never touched.
import { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } from "@aws-sdk/client-s3";
const s3 = new S3Client({ region: process.env.R2_REGION ?? "auto", endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! } });
const Bucket = process.env.R2_BUCKET!;
const cutoff = Date.now() - 24 * 3600_000;
let total = 0;
for (const Prefix of ["tile/", "nowcast/", "s2/", "s3/", "sat/", "lightning/", "gfs/"]) {
  // Every stored version and hide marker: a plain delete on Backblaze only hides
  // the file, which still counts towards the 10 GB.
  let km: string | undefined, vm: string | undefined; let n = 0;
  do {
    const r = await s3.send(new ListObjectVersionsCommand({ Bucket, Prefix, KeyMarker: km, VersionIdMarker: vm, MaxKeys: 1000 }));
    const items = [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])]
      .filter((o) => o.LastModified && (o.LastModified.getTime() < cutoff || !(r.Versions ?? []).some((v) => v.Key === o.Key && v.IsLatest)) && !/index\.json$|live\.json$|^gfs\/meta\.json$/.test(o.Key!));
    for (let i = 0; i < items.length; i += 1000)
      await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: items.slice(i, i + 1000).map((o) => ({ Key: o.Key!, VersionId: o.VersionId })), Quiet: true } }));
    n += items.length;
    km = r.IsTruncated ? r.NextKeyMarker : undefined; vm = r.IsTruncated ? r.NextVersionIdMarker : undefined;
  } while (km);
  console.log(`${Prefix} deleted ${n}`); total += n;
}
console.log(`total deleted ${total}`);
