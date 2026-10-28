#!/usr/bin/env bash
# Gives the MongoDB user a new password and stores Meldiq's connection string on the VPS without anyone seeing it
# (docs/MONGODB_ATLAS_FREE_REPORT_2026-10-28.md §6). Run it yourself on your Mac:
#   1. it generates a random 24-character password (letters and digits) and never prints it;
#   2. it writes MONGODB_URI, MONGODB_DB and MONGODB_STORAGE_LIMIT_MB to .env.mongodb (mode 600) on the VPS, sending the
#      secret over SSH's standard input, never as an argument;
#   3. it puts the password on your clipboard: paste it into Atlas (meldiq_api > Edit > Edit Password) and click
#      Update User; press Enter here afterwards and it clears the clipboard.
# The password goes into Atlas by paste, not out of Atlas by its Copy button (which doesn't reach the Mac's clipboard
# from the Claude app's built-in browser).
#
# Not into .env on purpose: with MONGODB_URI there, every API restart connects to MongoDB first and refuses to start if
# it can't, and /healthz answers 503 when MongoDB drops, even while no domain lives there. Until a cutover, only one-off
# admin commands read .env.mongodb. Refuses if .env.mongodb already holds a URI.
set -euo pipefail
host="${MELDIQ_VPS:-root@72.60.107.88}"
target="${MELDIQ_MONGO_ENV_FILE:-/opt/griip-internal-messaging/.env.mongodb}"
user="${MONGODB_USER:-meldiq_api}"
cluster="${MONGODB_HOST:-cluster0.23iuld0.mongodb.net}"
password_length=24

pw=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$password_length" || true)
if [ "${#pw}" -ne "$password_length" ]; then
  echo "Couldn't generate a password; nothing changed." >&2
  exit 1
fi
uri="mongodb+srv://${user}:${pw}@${cluster}/meldiq?retryWrites=true&w=majority&appName=meldiq-api"

printf '%s' "$uri" | ssh "$host" "set -eu
f='$target'
if [ -f \"\$f\" ] && grep -q '^MONGODB_URI=' \"\$f\"; then echo \"\$f already holds MONGODB_URI; nothing changed.\" >&2; exit 3; fi
IFS= read -r u || true
[ -n \"\$u\" ] || { echo 'Nothing received; nothing changed.' >&2; exit 1; }
umask 077
printf 'MONGODB_URI=%s\nMONGODB_DB=meldiq\nMONGODB_STORAGE_LIMIT_MB=512\n' \"\$u\" > \"\$f\"
echo \"Stored on the server in \$f (value not shown).\""
unset uri

printf '%s' "$pw" | pbcopy
unset pw
echo
echo "The new password for ${user} is now on your clipboard (not shown). In Atlas, in Google Chrome:"
echo "  ${user} > EDIT > Edit Password > click in 'Enter new password' > Cmd+A, then Cmd+V"
echo "  (Cmd+A first: the browser may have pre-filled the field, and a paste would only add to it)"
echo "  > click SHOW: the field must hold exactly ${password_length} letters and digits > Update User"
echo
read -rp "Press Enter here once you've clicked Update User (the clipboard is then cleared): " _
pbcopy < /dev/null
echo "Clipboard cleared. Done: tell Claude it's stored."
