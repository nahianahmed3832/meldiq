#!/usr/bin/env bash
# Deploy/redeploy Meldiq (formerly Orbit / Griip Message) to a VPS over SSH. Only touches /opt/griip-internal-messaging
# and Compose project griip-internal-messaging (names kept after the rebrand, see compose.yaml). Never runs global Docker cleanup.
#   TARGET=root@your-vps ./deploy/scripts/deploy.sh
set -euo pipefail
: "${TARGET:?set TARGET=user@host}"
DIR=/opt/griip-internal-messaging
PROJECT=griip-internal-messaging
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SSH="ssh -o BatchMode=yes $TARGET"

# This legacy full-stack template predates the retained PostgreSQL acceptance/CA mounts and Redis.
# It must not overwrite the canonical, verified deployment after the database authority changes.
REMOTE_DATABASE_MODE=$($SSH "docker exec griip-internal-messaging-api-1 node -p 'process.env.DATABASE_MODE || \"\"'" 2>/dev/null || true)
if [ "$REMOTE_DATABASE_MODE" = supabase ]; then
  echo "The deployed API uses PostgreSQL. Preserve its canonical compose/env, acceptance, CA and data volume."
  echo "Use an API-only image replacement under /run/lock/meldiq-production-release.lock; see docs/SUPABASE_DATABASE_CUTOVER.md."
  exit 1
fi

echo "→ preflight (read-only)"
$SSH "mkdir -p $DIR/scripts $DIR/ntfy && chmod 750 $DIR"
scp -q "$ROOT/deploy/scripts/preflight.sh" "$TARGET:$DIR/scripts/preflight.sh"
$SSH "bash $DIR/scripts/preflight.sh" || { echo "Preflight failed; not deploying."; exit 1; }

echo "→ sync files"
rsync -az --delete --exclude node_modules --exclude dist --exclude data --exclude test \
  "$ROOT/server/" "$TARGET:$DIR/server/"
rsync -az "$ROOT/deploy/compose.yaml" "$ROOT/deploy/.env.example" "$TARGET:$DIR/"
rsync -az "$ROOT/deploy/livekit/livekit.yaml.template" "$TARGET:$DIR/livekit/"
rsync -az "$ROOT/deploy/ntfy/server.yml" "$TARGET:$DIR/ntfy/"
rsync -az "$ROOT/deploy/scripts/" "$TARGET:$DIR/scripts/"

echo "→ config"
$SSH "sh $DIR/scripts/gen-config.sh"

echo "→ build & start (project-scoped)"
$SSH "cd $DIR && docker compose -p $PROJECT -f compose.yaml config -q && docker compose -p $PROJECT -f compose.yaml up -d --build --remove-orphans"
$SSH "bash $DIR/scripts/verify.sh"
