"""Read-only reverse delta. Run with the original private manifest and exclusive write fence."""
import argparse
import collections
import json
import os
from pathlib import Path

import boto3
from reconcile import inventory, REGIONS


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    p = args.state
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
    sg=inventory(session.client('s3',region_name=REGIONS[0]),source)
    fra=inventory(session.client('s3',region_name=REGIONS[1]),target)
    baseline=collections.defaultdict(list)
    if (p/'disk-manifest.jsonl').exists():
        for line in (p/'disk-manifest.jsonl').read_text().splitlines():
            row=json.loads(line)
            baseline[row['key']].append((row['destination_version'],'Version'))
    for key,entries in sg.items():
        for version,kind,_ in entries:
            row=verified.get((key,version))
            if not row or kind!=row['kind']: raise ValueError("Singapore drift: reconcile before rollback")
            baseline[key].append((row['destination_version'],kind))
    if {(k,v) for k,entries in sg.items() for v,_,_ in entries} != set(verified):
        raise ValueError("Singapore history missing: do not switch")
    delta=[]
    for key in set(baseline)|set(fra):
        entries = [(v,kind) for v,kind,_ in fra.get(key,[])]
        previous=baseline.get(key,[])
        if entries[:len(previous)]!=previous: raise ValueError("Frankfurt history changed before baseline")
        delta.extend(dict(key=key,frankfurt_version=v,action='soft-delete-marker' if kind=='DeleteMarker' else 'copy-specific-version',source=target,destination=source) for v,kind in entries[len(previous):])
    tmp=p/'reverse-delta.partial'
    tmp.write_text(''.join(json.dumps(row)+'\n' for row in delta))
    tmp.replace(p/'reverse-delta.jsonl')
    print(json.dumps(dict(delta_entries=len(delta),eligible_for_switch=False,reason='Verify database, sessions, disk fallback, fencing and private delivery separately.')))


if __name__=='__main__':
    main()
