#!/usr/bin/env python3
"""Creates isolated Redis credentials locally; never prints passwords or overwrites existing files."""
import argparse, hashlib, os, secrets
from pathlib import Path
parser=argparse.ArgumentParser()
parser.add_argument("directory",type=Path)
a=parser.parse_args()
a.directory.mkdir(parents=True,exist_ok=True,mode=0o700)
private=a.directory/"secrets"
private.mkdir(exist_ok=True,mode=0o700)
os.chmod(a.directory,0o700)
os.chmod(private,0o700)
if (private/"redis.acl").exists() or (a.directory/".env.redis").exists():
 raise SystemExit("Refusing to overwrite existing Redis credentials")
password=secrets.token_urlsafe(48)
commands="+ping +get +set +del +incr +pttl +pexpire +eval +evalsha +script|load +script|exists +publish +subscribe +unsubscribe +quit +hello +select +client|setinfo +client|setname +zadd +zrem +zremrangebyscore +zcount +info"
acl="user default off\nuser meldiq on #"+hashlib.sha256(password.encode()).hexdigest()+" ~meldiq:* &meldiq:* -@all "+commands+"\n"
env="REDIS_URL=redis://meldiq@redis:6379/0\nREDIS_PASSWORD="+password+"\nREDIS_PRIVATE_NETWORK=true\nREDIS_KEY_PREFIX=meldiq:production:v1\nREDIS_TIMEOUT_MS=1000\n"
# ACL has only a high-entropy password HASH; 0644 allows the non-root Redis process to read the secret mount.
# Its parent directory is 0700; the plaintext password is confined to the 0600 env file.
for path,text,mode in [(private/"redis.acl",acl,0o644),(a.directory/".env.redis",env,0o600)]:
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,mode)
 with os.fdopen(fd,"w") as f:f.write(text)
 # Preserve the reviewed mode even when provisioning runs under umask 0077.
 os.chmod(path,mode)
print("Redis credential files created. No credentials printed. Review Compose config with config -q only.")
