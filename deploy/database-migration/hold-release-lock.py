#!/usr/bin/env python3
"""Hold the shared release lock until the private run directory contains release-lock.done."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import time

os.umask(0o077)

parser = argparse.ArgumentParser()
parser.add_argument("run_directory", type=Path)
parser.add_argument("--lock", type=Path, default=Path("/run/lock/meldiq-production-release.lock"))
args = parser.parse_args()
args.run_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
args.lock.parent.mkdir(parents=True, exist_ok=True)
with args.lock.open("a+") as handle:
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("Another Meldiq deployment holds the release lock; no production changes made")
    receipt = {"owner": "atlas-database-migration", "pid": os.getpid(), "runDirectory": str(args.run_directory), "lockPath": str(args.lock), "startedAtUnix": int(time.time())}
    handle.seek(0)
    handle.truncate()
    handle.write(json.dumps(receipt) + "\n")
    handle.flush()
    os.fsync(handle.fileno())
    (args.run_directory / "release-lock-held.json").write_text(json.dumps(receipt) + "\n")
    while not (args.run_directory / "release-lock.done").exists():
        time.sleep(5)
    (args.run_directory / "release-lock-released.json").write_text(json.dumps({"releasedAtUnix": int(time.time()), "owner": receipt["owner"]}) + "\n")
