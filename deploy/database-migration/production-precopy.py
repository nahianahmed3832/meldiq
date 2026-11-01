#!/usr/bin/env python3
"""Online copy watchdog. Does not change authority or stop the application.

Run on the production host under the shared release lock, against a dedicated,
immutable SQLite backup. Only its own migration container is stopped on trouble.
The CLI records counts/checksums, never document contents or connection strings.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--image", required=True)
parser.add_argument("--source", type=Path, required=True)
parser.add_argument("--run-directory", type=Path, required=True)
parser.add_argument("--phase", required=True)
parser.add_argument("--write-batch-size", type=int, choices=[25, 50, 75], default=50)
parser.add_argument("--prune", action="store_true")
args = parser.parse_args()
if not args.phase.replace("-", "").isalnum():
    raise SystemExit("Invalid phase")
source = args.source.resolve(strict=True)
run = args.run_directory.resolve(strict=True)
lock = json.loads((run / "release-lock-held.json").read_text())
os.kill(lock["pid"], 0)
if (run / "release-lock.done").exists():
    raise SystemExit("Release lock already released")
phase = run / args.phase
phase.mkdir(mode=0o700)
before = hashlib.file_digest(source.open("rb"), "sha256").hexdigest()
name = "meldiq-atlas-" + args.phase
base = ["docker", "run", "--rm", "--no-healthcheck", "--name", name, "--memory", "768m", "--cpus", "0.5",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=32m", "--env-file", "/opt/griip-internal-messaging/.env",
        "-e", "MONGODB_STORAGE_LIMIT_MB=512", "-e", "NODE_OPTIONS=--max-old-space-size=384",
        "-v", str(source.parent) + ":/review:rw", args.image,
        "node", "dist/databaseMigration.js", "copy", "/review/" + source.name,
        "--apply", "--batch-size", str(args.write_batch_size), "--read-batch-size", "5000",
        "--batch-delay-ms", "1000", "--archive-conflicts"]
if args.prune:
    base.append("--prune")

def health():
    start = time.monotonic()
    with urllib.request.urlopen("http://127.0.0.1:18080/healthz", timeout=5) as response:
        result = json.load(response)
    elapsed = round(time.monotonic() - start, 3)
    if not result.get("ok") or result.get("version") != "0.74.0":
        raise RuntimeError("API health or release changed")
    return elapsed

health()
started = time.time()
failures = 0
samples = 0
worst = 0
stopped = False
with (phase / "copy.json").open("wb") as out, (phase / "copy-progress.jsonl").open("wb") as err:
    process = subprocess.Popen(base, stdout=out, stderr=err)
    try:
        while process.poll() is None:
            time.sleep(5)
            try:
                elapsed = health()
                samples += 1
                worst = max(worst, elapsed)
                failures = failures + 1 if elapsed >= 3 else 0
                os.kill(lock["pid"], 0)
                if (run / "release-lock.done").exists():
                    raise RuntimeError("Release lock released")
            except Exception:
                failures += 1
            if failures >= 3:
                stopped = True
                subprocess.run(["docker", "stop", "--time", "30", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                break
            progress = {"phase": args.phase, "authorityChanged": False, "applicationWritersStopped": False,
                        "startedAtUnix": started, "updatedAtUnix": time.time(), "healthSamples": samples,
                        "worstHealthSeconds": worst, "consecutiveUnhealthy": failures}
            temp = run / "progress.tmp"
            temp.write_text(json.dumps(progress) + "\n")
            temp.replace(run / "progress.json")
    except BaseException:
        subprocess.run(["docker", "stop", "--time", "30", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        raise
    finally:
        code = process.wait()
after = hashlib.file_digest(source.open("rb"), "sha256").hexdigest()
receipt = {"phase": args.phase, "image": args.image, "sourceSha256": before,
           "writeBatchSize": args.write_batch_size,
           "sourceUnchanged": before == after, "authorityChanged": False,
           "applicationWritersStopped": False, "exitCode": code, "watchdogStopped": stopped,
           "healthSamples": samples, "worstHealthSeconds": worst, "durationSeconds": round(time.time()-started, 1)}
(phase / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
print(json.dumps(receipt), flush=True)
if code or stopped or before != after:
    raise SystemExit(1)
