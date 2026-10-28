#!/usr/bin/env bash
# Stores Meldiq's MongoDB connection string on the VPS without showing it (docs/MONGODB_ATLAS_FREE_REPORT_2026-10-28.md
# §6). Run it yourself: it asks for the database user's password at a hidden prompt and writes MONGODB_URI, MONGODB_DB
# and MONGODB_STORAGE_LIMIT_MB to their own file, .env.mongodb (mode 600), next to the API's .env. The secret travels over
# SSH's standard input, never as an argument.
#
# Not into .env on purpose: with MONGODB_URI there, every API restart connects to MongoDB first and refuses to start if
# it can't, and /healthz answers 503 when MongoDB drops, even while no domain lives there. Until a cutover, only one-off
# admin commands read .env.mongodb (docker run … --env-file .env --env-file .env.mongodb … node dist/admin.js mongo-…).
# Refuses if .env.mongodb already holds a URI.
set -euo pipefail
host="${MELDIQ_VPS:-root@72.60.107.88}"
target="${MELDIQ_MONGO_ENV_FILE:-/opt/griip-internal-messaging/.env.mongodb}"
user="${MONGODB_USER:-meldiq_api}"
cluster="${MONGODB_HOST:-cluster0.23iuld0.mongodb.net}"

read -rsp "Password for ${user} (paste it; nothing will show): " pw
echo
if [ -z "$pw" ]; then
  echo "No password entered; nothing changed." >&2
  exit 1
fi
encoded=$(printf '%s' "$pw" | python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read(), safe=""))')
unset pw
uri="mongodb+srv://${user}:${encoded}@${cluster}/meldiq?retryWrites=true&w=majority&appName=meldiq-api"
unset encoded

printf '%s' "$uri" | ssh "$host" "set -eu
f='$target'
if [ -f \"\$f\" ] && grep -q '^MONGODB_URI=' \"\$f\"; then echo \"\$f already holds MONGODB_URI; nothing changed.\" >&2; exit 3; fi
IFS= read -r u || true
[ -n \"\$u\" ] || { echo 'Nothing received; nothing changed.' >&2; exit 1; }
umask 077
printf 'MONGODB_URI=%s\nMONGODB_DB=meldiq\nMONGODB_STORAGE_LIMIT_MB=512\n' \"\$u\" > \"\$f\"
echo \"Stored in \$f (value not shown). The API's .env is unchanged; the running API doesn't use it.\""
status=$?
unset uri
exit "$status"
