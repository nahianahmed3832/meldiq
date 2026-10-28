#!/usr/bin/env bash
# The server half of deploy/scripts/stripe-setup.sh (run by it over SSH; the Stripe test key arrives on standard input).
# Never prints a secret. Backs .env up first and restores it if the API doesn't come back healthy.
set -euo pipefail
cd "$(dirname "$0")/.."
compose=(docker compose -p griip-internal-messaging -f compose.yaml)
IFS= read -r key || true
case "$key" in sk_test_*|rk_test_*) ;; *) echo "No Stripe test key received; nothing changed." >&2; exit 1 ;; esac

version=$(curl -fsS http://127.0.0.1:18080/healthz | sed -E 's/.*"version":"([0-9.]+)".*/\1/')
case "$version" in 0.[0-4]*|0.5[0-2].*) echo "The API is $version: deploy 0.53.0 or later first; nothing changed." >&2; exit 1 ;; esac

backup=".env.before-stripe-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p .env "$backup" && chmod 600 "$backup"

# Sets [name]=<value of the variable named [var]> in .env (the value never appears in a command line).
set_env() {
  local name="$1" var="$2" tmp
  tmp=$(mktemp .env.XXXXXX) && chmod 600 "$tmp"
  grep -v "^${name}=" .env > "$tmp" || true
  printf '%s=%s\n' "$name" "${!var}" >> "$tmp"
  mv "$tmp" .env
}
restore() {
  cp -p "$backup" .env
  "${compose[@]}" up -d --no-deps --no-build --force-recreate api > /dev/null 2>&1 || true
  echo "Restored .env from $backup and restarted the API. Nothing is on sale." >&2
}

STRIPE_SECRET_KEY="$key"
unset key
set_env STRIPE_SECRET_KEY STRIPE_SECRET_KEY

echo "Setting up Stripe (test mode)…"
out=$("${compose[@]}" run --rm --no-deps -T api node dist/admin.js stripe-setup --emit-env "$@" < /dev/null) || { restore; exit 1; }
prices=""
while IFS= read -r line; do
  case "$line" in
    "ENV "*) kv="${line#ENV }"; name="${kv%%=*}"; value="${kv#*=}"
      case "$name" in BILLING_RETURN_URL|STRIPE_PORTAL_CONFIGURATION|STRIPE_WEBHOOK_SECRET) set_env "$name" value ;; esac ;;
    "PRICES "*) prices="${line#PRICES }" ;;
  esac
done <<< "$out"
unset out value kv
if ! grep -q '^STRIPE_WEBHOOK_SECRET=whsec_' .env; then
  restore
  echo "The webhook endpoint already exists in Stripe but its signing secret isn't in .env: run the script again with --replace-webhook." >&2
  exit 1
fi
[ -n "$prices" ] || { restore; echo "Stripe setup didn't report the prices." >&2; exit 1; }

BILLING_PROVIDER=stripe
set_env BILLING_PROVIDER BILLING_PROVIDER
echo "Restarting the API with billing on…"
"${compose[@]}" up -d --no-deps --no-build --force-recreate api > /dev/null
for _ in $(seq 1 45); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' griip-internal-messaging-api-1 2>/dev/null)" = healthy ] && break
  sleep 2
done
if [ "$(docker inspect -f '{{.State.Health.Status}}' griip-internal-messaging-api-1)" != healthy ]; then
  "${compose[@]}" logs --tail 20 api | grep -iE 'error|BILLING|STRIPE' | sed -E 's/(sk|rk)_(test|live)_[A-Za-z0-9]+/<key>/g; s/whsec_[A-Za-z0-9]+/<secret>/g' >&2 || true
  restore
  exit 1
fi

# shellcheck disable=SC2086
"${compose[@]}" exec -T api node dist/admin.js billing-mojo-plans $prices < /dev/null
echo
echo "Public price list (what meldiq.app shows):"
curl -fsS http://127.0.0.1:18080/v2/billing/plans
echo
echo "Done. Backup of the previous settings: $backup"
