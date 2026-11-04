"""
Upload a finished blend to Cloudflare R2 and keep only the newest runs.

    runs/<run>/blend.bin   the data
    runs/<run>/meta.json   how to read it
    latest.json            which run is newest (written last, so readers never
                           see a run before its data has fully arrived)

Credentials come from the environment (GitHub repo secrets), never from code:
R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT. Bucket: R2_BUCKET or
"ro-weather-models".
"""

import json
import os
import sys

import boto3
from boto3.s3.transfer import TransferConfig

KEEP = 2  # runs kept in the bucket (about 1.4 GB each)


def main(out_dir="out"):
    bucket = os.environ.get("R2_BUCKET", "ro-weather-models")
    s3 = boto3.client(
        "s3",
        endpoint_url=os.environ["R2_ENDPOINT"],
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )
    meta = json.load(open(os.path.join(out_dir, "meta.json")))
    run = meta["run"].replace(":", "")
    big = TransferConfig(multipart_chunksize=64 * 1024 * 1024, max_concurrency=8)
    s3.upload_file(os.path.join(out_dir, "blend.bin"), bucket, f"runs/{run}/blend.bin", Config=big,
                   ExtraArgs={"ContentType": "application/octet-stream"})
    s3.upload_file(os.path.join(out_dir, "meta.json"), bucket, f"runs/{run}/meta.json",
                   ExtraArgs={"ContentType": "application/json"})
    latest = dict(meta, path=f"runs/{run}/")
    s3.put_object(Bucket=bucket, Key="latest.json", Body=json.dumps(latest).encode(),
                  ContentType="application/json", CacheControl="max-age=300")
    print("uploaded", run)

    # Drop older runs.
    runs = sorted({o["Key"].split("/")[1] for o in s3.list_objects_v2(Bucket=bucket, Prefix="runs/").get("Contents", [])})
    for old in runs[:-KEEP]:
        for o in s3.list_objects_v2(Bucket=bucket, Prefix=f"runs/{old}/").get("Contents", []):
            s3.delete_object(Bucket=bucket, Key=o["Key"])
        print("removed", old)


if __name__ == "__main__":
    main(*sys.argv[1:])
