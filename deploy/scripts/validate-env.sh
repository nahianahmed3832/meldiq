#!/usr/bin/env bash
# READ-ONLY check of a deployment's .env and rendered LiveKit config, before `docker compose up`.
# Prints which settings are set (never their secret values) and exits non-zero on any error.
#   bash scripts/validate-env.sh            # checks ./.env next to compose.yaml
#   bash scripts/validate-env.sh path/.env
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENVF="${1:-$DIR/.env}"
errors=0
warnings=0
err()  { echo "ERROR: $*"; errors=$((errors + 1)); }
warn() { echo "warn:  $*"; warnings=$((warnings + 1)); }
ok()   { echo "ok:    $*"; }

if [ ! -f "$ENVF" ]; then
  echo "ERROR: $ENVF not found. Run scripts/gen-config.sh first (it creates .env from .env.example)."
  exit 1
fi
perm=$(stat -c '%a' "$ENVF" 2>/dev/null || stat -f '%Lp' "$ENVF")
case "$perm" in
  600|400) ok ".env permissions $perm" ;;
  *) warn ".env permissions are $perm; it holds the LiveKit secret, use chmod 600" ;;
esac

# shellcheck disable=SC1090
set -a; . "$ENVF"; set +a

url_check() { # name value scheme-secure scheme-insecure
  local name="$1" val="$2" secure="$3" insecure="$4"
  if [ -z "$val" ]; then err "$name is empty"; return; fi
  case "$val" in
    *example.com*|*example.org*) err "$name is still the example value ($val)" ;;
    "$secure"://*) ok "$name = $val" ;;
    "$insecure"://*) warn "$name uses $insecure:// ($val). Only debug app builds connect without TLS; use $secure:// for real users" ;;
    *) err "$name must start with $secure:// ($val)" ;;
  esac
}
url_check PUBLIC_API_URL "${PUBLIC_API_URL:-}" https http
url_check LIVEKIT_PUBLIC_URL "${LIVEKIT_PUBLIC_URL:-}" wss ws

if [ -z "${LIVEKIT_API_KEY:-}" ]; then err "LIVEKIT_API_KEY is empty (scripts/gen-config.sh generates one)"; else ok "LIVEKIT_API_KEY is set"; fi
sl=${#LIVEKIT_API_SECRET}
if [ "${sl:-0}" -lt 32 ]; then err "LIVEKIT_API_SECRET must be at least 32 characters (has $sl)"; else ok "LIVEKIT_API_SECRET is set ($sl characters)"; fi

case "${REGISTRATION_MODE:-invite}" in
  invite) ok "REGISTRATION_MODE = invite (new accounts need an invitation)" ;;
  open) warn "REGISTRATION_MODE = open: anyone who can reach the server can create an account" ;;
  *) err "REGISTRATION_MODE must be invite or open (is ${REGISTRATION_MODE})" ;;
esac

# Platform Admin Console (docs/PLATFORM_ADMIN_CONSOLE.md): optional; production needs its https origin.
case "${ADMIN_CONSOLE_ORIGIN:-}" in
  '') ok "ADMIN_CONSOLE_ORIGIN unset (no console routes)" ;;
  https://*/*) err "ADMIN_CONSOLE_ORIGIN must be an origin without a path (${ADMIN_CONSOLE_ORIGIN})" ;;
  https://*) ok "ADMIN_CONSOLE_ORIGIN = $ADMIN_CONSOLE_ORIGIN${ADMIN_ALLOWED_NETWORKS:+ (networks: $ADMIN_ALLOWED_NETWORKS)}" ;;
  *) err "ADMIN_CONSOLE_ORIGIN must start with https:// (${ADMIN_CONSOLE_ORIGIN})" ;;
esac

# Billing (docs/BILLING.md): none by default; the sandbox provider is test mode only and needs its webhook secret.
case "${BILLING_PROVIDER:-none}" in
  none|'') ok "BILLING_PROVIDER none (nothing can be bought)" ;;
  sandbox)
    if [ "${#BILLING_SANDBOX_WEBHOOK_SECRET}" -ge 32 ]; then warn "BILLING_PROVIDER=sandbox: test mode, no real money; not for production customers"
    else err "BILLING_SANDBOX_WEBHOOK_SECRET must be at least 32 characters with BILLING_PROVIDER=sandbox"; fi ;;
  stripe)
    case "${STRIPE_SECRET_KEY:-}" in
      sk_test_*|rk_test_*) warn "BILLING_PROVIDER=stripe with a test key: Stripe test mode, no real money" ;;
      sk_live_*|rk_live_*)
        if [ "${BILLING_ALLOW_LIVE:-}" = "true" ] && [ "${APP_ENV:-}" = "production" ]; then warn "BILLING_PROVIDER=stripe with a LIVE key: real charges"
        else err "STRIPE_SECRET_KEY is a live key: needs BILLING_ALLOW_LIVE=true and APP_ENV=production"; fi ;;
      *) err "STRIPE_SECRET_KEY must be a Stripe secret key (sk_test_… or rk_test_…) with BILLING_PROVIDER=stripe" ;;
    esac
    case "${STRIPE_WEBHOOK_SECRET:-}" in whsec_*) ok "STRIPE_WEBHOOK_SECRET set" ;; *) err "STRIPE_WEBHOOK_SECRET must be the endpoint's signing secret (whsec_…)" ;; esac
    case "${BILLING_RETURN_URL:-}" in https://*) ok "BILLING_RETURN_URL ${BILLING_RETURN_URL}" ;; *) err "BILLING_RETURN_URL must be the website's https billing page (e.g. https://meldiq.app/account/billing)" ;; esac ;;
  *) err "BILLING_PROVIDER must be none, sandbox or stripe (${BILLING_PROVIDER})" ;;
esac

# Google Play for the Android app (docs/MOJO_ANDROID.md): off unless GOOGLE_PLAY_PACKAGE is set.
if [ -n "${GOOGLE_PLAY_PACKAGE:-}" ]; then
  ok "GOOGLE_PLAY_PACKAGE ${GOOGLE_PLAY_PACKAGE}"
  play_secret="${GOOGLE_PLAY_ACCOUNT_TOKEN_SECRET:-}"
  if [ "${#play_secret}" -ge 32 ]; then ok "GOOGLE_PLAY_ACCOUNT_TOKEN_SECRET set"; else err "GOOGLE_PLAY_ACCOUNT_TOKEN_SECRET must be at least 32 characters"; fi
  if [ -r "${GOOGLE_PLAY_SERVICE_ACCOUNT_FILE:-/nonexistent}" ]; then ok "GOOGLE_PLAY_SERVICE_ACCOUNT_FILE readable"; else err "GOOGLE_PLAY_SERVICE_ACCOUNT_FILE must name a readable service account JSON key"; fi
  if [ -n "${GOOGLE_PLAY_RTDN_AUDIENCE:-}" ] && [ -n "${GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT:-}" ]; then ok "Google Play notifications on"
  elif [ -z "${GOOGLE_PLAY_RTDN_AUDIENCE:-}" ] && [ -z "${GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT:-}" ]; then ok "Google Play notifications off (purchases still verify; reconciled hourly)"
  else err "GOOGLE_PLAY_RTDN_AUDIENCE and GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT go together"; fi
else
  ok "GOOGLE_PLAY_PACKAGE unset (no Google Play purchases)"
fi

# Platform Admin 2.0: the credentials key, if set, must be 32 bytes (hex or base64); the server refuses to start otherwise.
case "${PLATFORM_SECRETS_KEY:-}" in
  '') ok "PLATFORM_SECRETS_KEY unset (the console can't store AI credentials)" ;;
  *)
    if [[ "$PLATFORM_SECRETS_KEY" =~ ^[0-9a-fA-F]{64}$ ]] || [[ "$PLATFORM_SECRETS_KEY" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then ok "PLATFORM_SECRETS_KEY set (32 bytes)"
    else err "PLATFORM_SECRETS_KEY must be 32 bytes: 64 hex characters (openssl rand -hex 32)"; fi ;;
esac

NTFY_HOST_PORT="${NTFY_HOST_PORT:-18081}"   # compose.yaml's default; .env files from before the ntfy service lack it
ports=()
for name in API_HOST_PORT LIVEKIT_SIGNAL_HOST_PORT LIVEKIT_RTC_TCP_PORT LIVEKIT_RTC_UDP_PORT NTFY_HOST_PORT; do
  v="${!name:-}"
  case "$v" in
    ''|*[!0-9]*) err "$name must be a port number (is '${v}')"; continue ;;
  esac
  if [ "$v" -lt 1 ] || [ "$v" -gt 65535 ]; then err "$name out of range ($v)"; continue; fi
  ports+=("$v")
done
dupes=$(printf '%s\n' "${ports[@]}" | sort | uniq -d)
if [ -n "$dupes" ]; then err "ports used twice: $dupes"; else ok "ports ${ports[*]} are distinct"; fi

if [ -n "${LIVEKIT_NODE_IP:-}" ]; then ok "LIVEKIT_NODE_IP = $LIVEKIT_NODE_IP"
elif [ "${LIVEKIT_USE_EXTERNAL_IP:-true}" = "true" ]; then ok "LiveKit discovers its public IP via STUN (set LIVEKIT_NODE_IP if that fails)"
else warn "LIVEKIT_USE_EXTERNAL_IP=false and no LIVEKIT_NODE_IP: phones outside this host's network may not get media"; fi

for name in QUEUE_TTL_SECONDS ATTACHMENT_TTL_SECONDS; do
  v="${!name:-604800}"
  case "$v" in ''|*[!0-9]*) err "$name must be a number of seconds"; continue ;; esac
  [ "$v" -gt 604800 ] && warn "$name=$v is above 7 days; the server caps it at 604800"
done

if [ -n "${INSTANCE_NAME:-}" ]; then ok "INSTANCE_NAME = ${INSTANCE_NAME}"; fi

if [ -n "${FEDERATION_DOMAIN:-}" ]; then
  ok "FEDERATION_DOMAIN = ${FEDERATION_DOMAIN} (addresses look like @name:${FEDERATION_DOMAIN})"
  case "${FEDERATION_PUBLIC_URL:-}" in
    "https://${FEDERATION_DOMAIN}"|"https://${FEDERATION_DOMAIN}/"*) ok "FEDERATION_PUBLIC_URL = ${FEDERATION_PUBLIC_URL}" ;;
    https://*) err "FEDERATION_PUBLIC_URL must be served from the federation domain (core nodes check it): https://${FEDERATION_DOMAIN}" ;;
    '') err "FEDERATION_PUBLIC_URL is empty" ;;
    *) err "FEDERATION_PUBLIC_URL must use https:// (${FEDERATION_PUBLIC_URL})" ;;
  esac
  n=0
  for entry in $(echo "${FEDERATION_CORE_NODES:-}" | tr ',' ' '); do
    case "$entry" in
      https://*'#'*) n=$((n + 1)) ;;
      *) err "FEDERATION_CORE_NODES entry isn't https://…#publicKey: $entry" ;;
    esac
  done
  if [ "$n" -lt 1 ]; then err "FEDERATION_CORE_NODES is empty"; else ok "$n core node(s) configured"; fi
  [ "$n" -lt 3 ] && [ "$n" -ge 1 ] && warn "fewer than 3 core nodes: losing one may stop lookups of new servers"
  q="${FEDERATION_CORE_QUORUM:-$((n / 2 + 1))}"
  case "$q" in ''|*[!0-9]*) err "FEDERATION_CORE_QUORUM must be a number" ;; *)
    if [ "$q" -gt "$n" ] || [ "$q" -lt 1 ]; then err "FEDERATION_CORE_QUORUM ($q) must be between 1 and the number of core nodes ($n)"; else ok "core quorum $q of $n"; fi ;;
  esac
  case "${FEDERATION_POLICY:-open}" in open|allowlist) ok "FEDERATION_POLICY = ${FEDERATION_POLICY:-open}" ;; *) err "FEDERATION_POLICY must be open or allowlist" ;; esac
else
  ok "federation off (standalone server)"
fi

# MongoDB (docs/MONGODB.md). The server checks the URI and refuses split domains at start; this catches the obvious.
if [ -n "${MONGODB_URI:-}" ]; then
  case "$MONGODB_URI" in
    mongodb+srv://*) ok "MongoDB with TLS (mongodb+srv)" ;;
    mongodb://127.0.0.1*|mongodb://localhost*) ok "MongoDB on this machine" ;;
    mongodb://*) case "$MONGODB_URI" in *tls=true*|*ssl=true*) ok "MongoDB with TLS" ;; *) err "MONGODB_URI must use TLS for a remote database (mongodb+srv:// or tls=true)" ;; esac ;;
    *) err "MONGODB_URI must start with mongodb:// or mongodb+srv://" ;;
  esac
  for d in $(echo "${MONGODB_DOMAINS:-}" | tr ',' ' '); do
    case "$d" in accounts|preferences|history|reports|relationships|relay|files) ok "MongoDB holds: $d (migrated first with admin mongo-migrate)" ;;
      integrations) ok "MONGODB_DOMAINS: integrations is retired and ignored" ;; *) err "MONGODB_DOMAINS: unknown domain $d" ;; esac
  done
elif [ -n "${MONGODB_DOMAINS:-}" ]; then
  err "MONGODB_DOMAINS needs MONGODB_URI"
else
  ok "MongoDB not used (every table in SQLite)"
fi

# Orbit 2.0 accounts (docs/ORBIT_2_ARCHITECTURE §9). The server itself refuses the worst combinations at start.
case "${APP_ENV:-development}" in
  production|staging) ok "APP_ENV = ${APP_ENV}" ;;
  development) warn "APP_ENV = development on a deployment: set production (or staging)" ;;
  *) err "APP_ENV must be development, staging or production (is ${APP_ENV})" ;;
esac
case "${MAIL_TRANSPORT:-none}" in
  none) warn "MAIL_TRANSPORT = none: Orbit 2.0 sign-up and password reset answer 503 until email is set up" ;;
  file) if [ "${APP_ENV:-development}" = "production" ]; then err "MAIL_TRANSPORT=file writes codes to disk: not allowed in production"; else warn "MAIL_TRANSPORT = file: codes are written to disk (development only)"; fi ;;
  ses) if [ -z "${MAIL_FROM:-}" ]; then err "MAIL_TRANSPORT=ses needs MAIL_FROM (an SES-verified sender)"; else ok "account emails sent with Amazon SES from ${MAIL_FROM}"; fi ;;
  smtp)
    if [ -z "${MAIL_FROM:-}${MAIL_FROM_ADDRESS:-}" ]; then err "MAIL_TRANSPORT=smtp needs MAIL_FROM or MAIL_FROM_ADDRESS"; fi
    if [ -z "${SMTP_HOST:-}" ]; then err "MAIL_TRANSPORT=smtp needs SMTP_HOST"; fi
    if [ -n "${SMTP_USER:-}" ] && [ -z "${SMTP_PASS:-}" ]; then err "SMTP_USER is set without SMTP_PASS"; fi
    if [ -n "${SMTP_HOST:-}" ]; then ok "account emails sent over SMTP via ${SMTP_HOST}:${SMTP_PORT:-465} (TLS required)"; fi ;;
  *) err "MAIL_TRANSPORT must be none, file, ses or smtp (is ${MAIL_TRANSPORT})" ;;
esac
for v in LEGACY_REGISTRATION LEGACY_LOGIN LEGACY_MIGRATION; do
  eval "val=\${$v:-on}"
  case "$val" in on|off|true|false) ok "$v = $val" ;; *) err "$v must be on or off (is $val)" ;; esac
done
case "${LEGACY_MIGRATION_REQUIRED:-off}" in
  on|true)
    case "${LEGACY_MIGRATION:-on}" in off|false) err "LEGACY_MIGRATION_REQUIRED=on needs LEGACY_MIGRATION=on" ;; esac
    case "${MAIL_TRANSPORT:-none}" in ses|smtp|file) ok "LEGACY_MIGRATION_REQUIRED = on: updated apps must move before opening" ;;
      *) err "LEGACY_MIGRATION_REQUIRED=on needs account email (MAIL_TRANSPORT=ses or smtp): the move ends with an emailed code" ;; esac ;;
  off|false) ok "LEGACY_MIGRATION_REQUIRED = off" ;;
  *) err "LEGACY_MIGRATION_REQUIRED must be on or off (is ${LEGACY_MIGRATION_REQUIRED})" ;;
esac

if [ -n "${PUSH_UNIFIEDPUSH_HOSTS:-}" ]; then
  for h in $(echo "$PUSH_UNIFIEDPUSH_HOSTS" | tr ',' ' '); do
    case "$h" in
      *://*|*/*) err "PUSH_UNIFIEDPUSH_HOSTS takes host names such as ntfy.example.net, not URLs: $h" ;;
      *example.com*|*example.org*) err "PUSH_UNIFIEDPUSH_HOSTS is still the example value ($h)" ;;
      *:443) err "PUSH_UNIFIEDPUSH_HOSTS: leave out :443 ($h)" ;;
      *) ok "push wake-ups go to https://$h only (payload-free; docs/BACKGROUND_DELIVERY.md)" ;;
    esac
  done
else
  ok "push wake-ups off (PUSH_UNIFIEDPUSH_HOSTS empty)"
fi

# Firebase wake-ups (round 6, docs/PUSH_FCM.md): both settings or neither; the key file is checked when the API starts.
if [ -n "${FCM_PROJECT_ID:-}${FCM_SERVICE_ACCOUNT_FILE:-}" ]; then
  if [ -z "${FCM_PROJECT_ID:-}" ] || [ -z "${FCM_SERVICE_ACCOUNT_FILE:-}" ]; then err "FCM needs both FCM_PROJECT_ID and FCM_SERVICE_ACCOUNT_FILE"
  else ok "Firebase wake-ups on for project ${FCM_PROJECT_ID}"; fi
else
  ok "Firebase wake-ups off (FCM_PROJECT_ID empty)"
fi

# GIF search (docs/GIFS.md): both settings or neither; the provider is tenor or giphy.
if [ -n "${GIF_PROVIDER:-}${GIF_API_KEY:-}" ]; then
  if [ -z "${GIF_PROVIDER:-}" ] || [ -z "${GIF_API_KEY:-}" ]; then
    err "GIF search needs GIF_PROVIDER and GIF_API_KEY together"
  else
    case "$GIF_PROVIDER" in
      tenor|giphy) ok "GIF search on ($GIF_PROVIDER)" ;;
      *) err "GIF_PROVIDER must be tenor or giphy" ;;
    esac
  fi
else
  ok "GIF search off (no GIF_PROVIDER / GIF_API_KEY)"
fi

# Discord import (docs/DISCORD_IMPORT.md): all four settings or none; the redirect must be Meldiq Web's /discord/callback.
if [ -n "${DISCORD_CLIENT_ID:-}${DISCORD_CLIENT_SECRET:-}${DISCORD_BOT_TOKEN:-}${DISCORD_REDIRECT_URI:-}" ]; then
  if [ -z "${DISCORD_CLIENT_ID:-}" ] || [ -z "${DISCORD_CLIENT_SECRET:-}" ] || [ -z "${DISCORD_BOT_TOKEN:-}" ] || [ -z "${DISCORD_REDIRECT_URI:-}" ]; then
    err "Discord import needs DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN and DISCORD_REDIRECT_URI together"
  else
    case "$DISCORD_REDIRECT_URI" in
      https://*/discord/callback) ok "Discord import on (application ${DISCORD_CLIENT_ID})" ;;
      *) err "DISCORD_REDIRECT_URI must be https://<Meldiq Web>/discord/callback" ;;
    esac
  fi
else
  ok "Discord import off (DISCORD_CLIENT_ID empty)"
fi

# compose.yaml mounts ntfy/server.yml into the ntfy service; without it Docker would mount an empty directory instead.
NT="$DIR/ntfy/server.yml"
if [ ! -f "$NT" ]; then
  err "ntfy/server.yml is missing: copy deploy/ntfy/server.yml next to compose.yaml (scripts/bundle.sh does)"
else
  base=$(sed -n 's/^base-url:[[:space:]]*"\{0,1\}\([^"#[:space:]]*\)"\{0,1\}.*/\1/p' "$NT" | head -1)
  ntfy_host="${base#https://}"; ntfy_host="${ntfy_host%/}"
  case "$base" in
    https://*) ok "ntfy/server.yml base-url = $base" ;;
    *) err "ntfy/server.yml base-url must be the push server's public https:// address (is '${base}')" ;;
  esac
  if [ -n "${PUSH_UNIFIEDPUSH_HOSTS:-}" ]; then
    case ",$(echo "$PUSH_UNIFIEDPUSH_HOSTS" | tr -d ' ' | tr 'A-Z' 'a-z')," in
      *",$ntfy_host,"*) ok "PUSH_UNIFIEDPUSH_HOSTS includes this deployment's ntfy ($ntfy_host)" ;;
      *) warn "PUSH_UNIFIEDPUSH_HOSTS doesn't include $ntfy_host (ntfy/server.yml base-url): wake-ups to it would be refused" ;;
    esac
  fi
fi

LK="$DIR/livekit/livekit.yaml"
if [ ! -f "$LK" ]; then
  err "livekit/livekit.yaml is missing: run scripts/gen-config.sh to render it"
else
  if grep -q '__[A-Z_]*__' "$LK"; then err "livekit/livekit.yaml still has template placeholders: run scripts/gen-config.sh"; fi
  if [ -n "${LIVEKIT_API_KEY:-}" ] && ! grep -q "^  ${LIVEKIT_API_KEY}:" "$LK"; then
    err "livekit/livekit.yaml was rendered with a different API key than .env: run scripts/gen-config.sh again"
  else
    ok "livekit/livekit.yaml matches .env"
  fi
  grep -q "tcp_port: ${LIVEKIT_RTC_TCP_PORT:-7881}$" "$LK" || err "livekit.yaml tcp_port doesn't match LIVEKIT_RTC_TCP_PORT: re-run gen-config.sh"
  grep -q "udp_port: ${LIVEKIT_RTC_UDP_PORT:-7882}$" "$LK" || err "livekit.yaml udp_port doesn't match LIVEKIT_RTC_UDP_PORT: re-run gen-config.sh"
fi

echo "---"
echo "$errors error(s), $warnings warning(s)"
[ "$errors" -eq 0 ]
