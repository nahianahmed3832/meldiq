"""Replay source versions into an exclusive, versioned Frankfurt staging bucket.
Run with uv run --with boto3 --with awscrt. Manifest contains private keys.
"""
import argparse
import collections
import concurrent.futures
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import threading
import xml.etree.ElementTree as ET

import boto3
from botocore.config import Config

REGIONS = ("ap-southeast-1", "eu-central-1")
HEAD_FIELDS = ("ContentLength", "ContentType", "ContentDisposition", "CacheControl",
               "ContentEncoding", "ContentLanguage", "Expires", "Metadata",
               "WebsiteRedirectLocation", "ServerSideEncryption", "StorageClass")
CHECKSUMS = ("ChecksumSHA256", "ChecksumSHA1", "ChecksumCRC32C", "ChecksumCRC32", "ChecksumCRC64NVME")


def inventory(client, bucket):
    # Boto separates versions and markers, losing service order within a second.
    # Use the original interleaved response, including across pages of one key.
    by_key = collections.defaultdict(list)
    def capture(http_response, **kwargs):
        if http_response.status_code != 200:
            return
        root = ET.fromstring(http_response.content)
        for element in root:
            kind = element.tag.split('}')[-1]
            if kind in ('Version', 'DeleteMarker'):
                key = element.findtext('{*}Key')
                by_key[key].append((element.findtext('{*}VersionId'), kind,
                                    element.findtext('{*}IsLatest') == 'true'))
    event = 'after-call.s3.ListObjectVersions'
    client.meta.events.register(event, capture)
    try:
        for _ in client.get_paginator('list_object_versions').paginate(Bucket=bucket, EncodingType='url'):
            pass
    finally:
        client.meta.events.unregister(event, capture)
    from urllib.parse import unquote
    for rows in by_key.values():
        if not rows[0][2] or sum(r[2] for r in rows) != 1:
            raise ValueError("Unordered or changing inventory; repeat snapshot")
    return {unquote(key):list(reversed(rows)) for key, rows in by_key.items()}


def digest(client, args):
    with contextlib.closing(client.get_object(**args)['Body']) as stream:
        h = hashlib.sha256()
        for chunk in stream.iter_chunks(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def verify(src, dst, old, new):
    a, b = [client.head_object(**args, ChecksumMode='ENABLED') for client,args in ((src,old),(dst,new))]
    if any(a.get(k) != b.get(k) for k in HEAD_FIELDS):
        raise ValueError("Object metadata mismatch")
    tags = [sorted((t['Key'],t['Value']) for t in c.get_object_tagging(**o)['TagSet']) for c,o in ((src,old),(dst,new))]
    if tags[0] != tags[1]:
        raise ValueError("Object tags mismatch")
    for field in CHECKSUMS:
        if a.get(field) and a[field] == b.get(field) and a.get('ChecksumType') == b.get('ChecksumType'):
            return a['ContentLength'],field + '=' + a[field]
    left,right = digest(src,old),digest(dst,new)
    if left != right:
        raise ValueError("Object digest mismatch")
    return a['ContentLength'],'sha256=' + left


def run(args):
    session = boto3.Session()
    config = Config(retries={'mode':'standard','total_max_attempts':5},connect_timeout=8,read_timeout=120,max_pool_connections=36)
    src,dst = (session.client('s3',region_name=r,config=config) for r in REGIONS)
    stack = session.client('cloudformation',region_name=REGIONS[1]).describe_stacks(StackName='orbit-storage-meldiq-frankfurt')['Stacks'][0]
    target = next(o['OutputValue'] for o in stack['Outputs'] if o['OutputKey']=='MediaBucket')
    if args.source == target:
        raise ValueError('Source equals destination')
    account = session.client('sts').get_caller_identity()['Account']
    for client,bucket,region in zip((src,dst),(args.source,target),REGIONS):
        if client.get_bucket_location(Bucket=bucket,ExpectedBucketOwner=account)['LocationConstraint'] != region or client.get_bucket_versioning(Bucket=bucket)['Status'] != 'Enabled':
            raise ValueError('Bucket region/versioning mismatch')
    args.state.mkdir(mode=0o700,parents=True,exist_ok=True)
    lock = (args.state/'lock').open('a')
    fcntl.flock(lock,fcntl.LOCK_EX | fcntl.LOCK_NB)
    source,destination = inventory(src,args.source),inventory(dst,target)
    journal = args.state/'manifest.jsonl'
    known = {}
    if journal.exists():
        for line in journal.read_text().splitlines():
            row=json.loads(line)
            if row['source']!=args.source or row['destination']!=target:
                raise ValueError("Wrong manifest")
            known[row['key'],row['version']]=row
    # Legacy disk versions precede any later S3 history for the same key.
    # Exempt only a version verified by the companion disk staging manifest.
    supplement = args.state/'disk-manifest.jsonl'
    disk = {}
    if supplement.exists():
        for line in supplement.read_text().splitlines():
            item = json.loads(line)
            key = item['key']
            rows = destination.get(key, [])
            if item['destination'] != target or not item['verified'] or not rows or rows[0][:2] != (item['destination_version'],'Version'):
                raise ValueError("Disk version no longer matches the manifest")
            obj = dst.head_object(Bucket=target,Key=key,VersionId=item['destination_version'],ChecksumMode='ENABLED')
            if obj['ContentLength'] != item['bytes'] or obj.get('ChecksumSHA256') != item['checksum']:
                raise ValueError("Disk checksum mismatch")
            disk[key] = rows[0]
            destination[key] = rows[1:]
            if not destination[key]:
                del destination[key]
    if destination.keys()-source.keys():
        raise ValueError("Unexpected destination keys; stop and reconcile")
    mutex=threading.Lock()
    def record(row):
        with mutex, journal.open('a') as f:
            f.write(json.dumps(row)+'\n')
            f.flush()
            os.fsync(f.fileno())
    def replay(key):
        rows=source[key]
        existing=destination.get(key,[])
        if len(existing)>len(rows):
            raise ValueError("Unexpected destination history")
        for index,(version,kind,_) in enumerate(rows):
            row = dict(source=args.source,destination=target,key=key,destination_key=key,version=version,kind=kind)
            previous=known.get((key,version),{})
            attempts=previous.get('attempts',0)
            try:
                old=dict(Bucket=args.source,Key=key,VersionId=version)
                if index < len(existing):
                    did,existing_kind,_=existing[index]
                    if existing_kind!=kind or previous.get('destination_version',did)!=did:
                        raise ValueError("Unexpected destination version order")
                    if previous.get('verified') and not args.reverify:
                        continue
                else:
                    if previous.get('verified'):
                        raise ValueError("Previously verified destination version disappeared")
                    attempts+=1
                    if kind=='DeleteMarker':
                        did=dst.delete_object(Bucket=target,Key=key)['VersionId']
                    else:
                        head=src.head_object(**old)
                        if head['ServerSideEncryption']!='AES256' or head.get('StorageClass','STANDARD')!='STANDARD' or head['ContentLength']>5_000_000_000:
                            raise ValueError("Source version needs different copy policy")
                        did=dst.copy_object(Bucket=target,Key=key,CopySource=old,CopySourceIfMatch=head['ETag'],MetadataDirective='COPY',TaggingDirective='COPY')['VersionId']
                row.update(destination_version=did)
                if kind=='Version':
                    size,checksum=verify(src,dst,old,dict(Bucket=target,Key=key,VersionId=did))
                    row.update(source_size=size,destination_size=size,checksum=checksum)
                record(dict(row,verified=True,attempts=attempts))
            except Exception as e:
                record(dict(row,verified=False,attempts=attempts,error=type(e).__name__+': '+str(e)[:300]))
                raise
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        list(pool.map(replay,source))
    final=inventory(dst,target)
    for key,row in disk.items():
        if not final.get(key) or final[key][0][:2] != row[:2]:
            raise ValueError("Unexpected disk history")
        final[key] = final[key][1:]
        if not final[key]:
            del final[key]
    if {k:[r[1] for r in v] for k,v in source.items()}!={k:[r[1] for r in v] for k,v in final.items()}:
        raise ValueError("Final destination history mismatch")
    if source!=inventory(src,args.source):
        raise ValueError("Source changed during copy. Rerun delta.")
    print(json.dumps(dict(keys=len(source),history_entries=sum(map(len,source.values())),destination=target,verified=True)))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',required=True)
    parser.add_argument('--state',type=Path,required=True)
    parser.add_argument('--reverify',action='store_true')
    os.umask(0o077)
    run(parser.parse_args())


if __name__ == '__main__':
    main()
