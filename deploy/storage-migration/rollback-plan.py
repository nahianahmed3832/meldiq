"""Read-only reverse delta. Run with the original private manifest and exclusive write fence."""
import argparse
import collections
import hashlib
import time
import json
import os
from pathlib import Path

import boto3
from reconcile import inventory, verify, REGIONS


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    p = args.state
    status = p/'reverse-status.json'
    status.write_text(json.dumps({'valid':False,'startedAt':time.time()}))
    verified = {}
    for line in (p/'manifest.jsonl').read_text().splitlines():
        row = json.loads(line)
        verified[row['key'],row['version']] = row
    if not verified or not all(row['verified'] for row in verified.values()):
        raise ValueError("Forward manifest incomplete")
    buckets = {(row['source'],row['destination']) for row in verified.values()}
    if len(buckets)!=1: raise ValueError("Mixed buckets")
    source,target = buckets.pop()
    session = boto3.Session()
    sg_client=session.client('s3',region_name=REGIONS[0])
    fra_client=session.client('s3',region_name=REGIONS[1])
    sg=inventory(sg_client,source)
    fra=inventory(fra_client,target)
    baseline=collections.defaultdict(list)
    if (p/'disk-manifest.jsonl').exists():
        for line in (p/'disk-manifest.jsonl').read_text().splitlines():
            row=json.loads(line)
            baseline[row['key']].append((row['destination_version'],'Version'))
    pending_path=p/'previous-source-session-ids.json'
    pending=set(json.loads(pending_path.read_text())) if pending_path.exists() else set()
    found=set()
    for key,entries in sg.items():
        appended=False
        for version,kind,_ in entries:
            row=verified.get((key,version))
            if row:
                if appended or kind!=row['kind']:raise ValueError("Unexpected baseline order")
                found.add((key,version))
                baseline[key].append((row['destination_version'],kind))
                continue
            # A named pre-cutover session or an older desktop can still PUT to
            # the previous origin. Count it as mirrored only after verification.
            appended=True
            attachment=key.removeprefix('orbit/attachments/')
            history=fra.get(key,[])
            ordinal=len(baseline[key])
            if key==attachment or not (attachment.startswith('a_legacy_') or attachment in pending) or ordinal>=len(history):
                raise ValueError("Singapore has an unpaired write; keep the fence and reconcile")
            dest_version,dest_kind,_=history[ordinal]
            if kind!=dest_kind:raise ValueError("Singapore and Frankfurt histories diverged")
            if kind=='Version':
                verify(sg_client,fra_client,dict(Bucket=source,Key=key,VersionId=version),
                       dict(Bucket=target,Key=key,VersionId=dest_version))
            baseline[key].append((dest_version,kind))
    if found!=set(verified):
        raise ValueError("Singapore history missing: do not switch")
    delta=[]
    for key in set(baseline)|set(fra):
        entries = [(v,kind) for v,kind,_ in fra.get(key,[])]
        previous=baseline.get(key,[])
        if entries[:len(previous)]!=previous: raise ValueError("Frankfurt history changed before baseline")
        delta.extend(dict(key=key,frankfurt_version=v,action='soft-delete-marker' if kind=='DeleteMarker' else 'copy-specific-version',source=target,destination=source) for v,kind in entries[len(previous):])
    tmp=p/'reverse-delta.partial'
    tmp.write_text(''.join(json.dumps(row)+'\n' for row in delta))
    digest=hashlib.sha256(tmp.read_bytes()).hexdigest()
    tmp.replace(p/'reverse-delta.jsonl')
    completed=p/'reverse-status.partial'
    completed.write_text(json.dumps(dict(valid=True,completedAt=time.time(),entries=len(delta),sha256=digest)))
    completed.replace(status)
    print(json.dumps(dict(delta_entries=len(delta),eligible_for_switch=False,reason='Verify database, sessions, disk fallback, fencing and private delivery separately.')))


if __name__=='__main__':
    main()
