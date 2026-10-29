#!/usr/bin/env bash
# The server half of deploy/scripts/stripe-setup.sh (run by it over SSH; the Stripe key arrives on standard input).
# Options: --live (a live key: real charges; needs APP_ENV=production), --replace-webhook.
# Never prints a secret. Backs .env up first and restores it if anything fails before plans are published.
set -euo pipefail
cd "${MELDIQ_DIR:-$(dirname "$0")/..}"
compose=(docker compose -p griip-internal-messaging -f compose.yaml)
web_return="${MELDIQ_WEB_RETURN_URL:-https://web.meldiq.app/settings/mojo}"

live=false
replace=""
for arg in "$@"; do
  case "$arg" in
    --live) live=true ;;
    --replace-webhook) replace="--replace-webhook" ;;
    *) echo "Unknown option $arg; nothing changed." >&2; exit 1 ;;
  esac
done

IFS= read -r key || true
if $live; then
  case "$key" in sk_live_*|rk_live_*) ;; *) echo "No Stripe live key received; nothing changed." >&2; exit 1 ;; esac
  # Unset means development (and the API refuses a live key there); anything other than production is refused here.
  if grep -q '^APP_ENV=' .env && ! grep -q '^APP_ENV=production$' .env; then
    echo "APP_ENV in .env isn't production: live billing is refused; nothing changed." >&2
    exit 1
  fi
else
  case "$key" in sk_test_*|rk_test_*) ;; *) echo "No Stripe test key received; nothing changed." >&2; exit 1 ;; esac
fi

version=$(curl -fsS http://127.0.0.1:18080/healthz | sed -E 's/.*"version":"([0-9.]+)".*/\1/')
case "$version" in 0.[0-4]*|0.5[0-2].*) echo "The API is $version: deploy 0.53.0 or later first; nothing changed." >&2; exit 1 ;; esac
# Before 0.61.1 the setup put Go and Plus on one product, which Stripe's portal refuses (docs/BILLING.md › Going live).
if $live; then
  case "$version" in 0.[0-5]*|0.60.*|0.61.0) echo "The API is $version: live setup needs 0.61.1 or later; nothing changed." >&2; exit 1 ;; esac
fi

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
live_flag=""
if $live; then
  # The API refuses a live key without both (billing/config.ts). APP_ENV=production also makes the API insist on
  # MongoDB over TLS, real mail and full-strength password hashing; if it doesn't start, the backup is restored.
  BILLING_ALLOW_LIVE=true
  set_env BILLING_ALLOW_LIVE BILLING_ALLOW_LIVE
  APP_ENV=production
  set_env APP_ENV APP_ENV
  live_flag="--live"
fi
# Checkouts started in the web app come back to its Mojo page (?checkout=success|canceled), unless already set.
grep -q '^BILLING_WEB_RETURN_URL=' .env || set_env BILLING_WEB_RETURN_URL web_return

echo "Setting up Stripe ($(if $live; then echo LIVE; else echo test; fi) mode)…"
# shellcheck disable=SC2086
out=$("${compose[@]}" run --rm --no-deps -T api node dist/admin.js stripe-setup --emit-env $live_flag $replace < /dev/null) || { restore; exit 1; }
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
# API 0.60.0 and earlier report only the Go and Plus prices; billing-mojo-plans needs Spark's too. Running the setup
# again finds everything it just made (never --replace-webhook here: that would invalidate the secret just stored).
if [ "$(wc -w <<< "$prices")" -eq 2 ]; then
  # shellcheck disable=SC2086
  spark=$("${compose[@]}" run --rm --no-deps -T api node dist/admin.js stripe-setup $live_flag < /dev/null 2> /dev/null | grep -oE '"spark": "price_[A-Za-z0-9]+"' | grep -oE 'price_[A-Za-z0-9]+' || true)
  [ -n "$spark" ] && prices="$prices $spark"
fi
[ "$(wc -w <<< "$prices")" -eq 3 ] || { restore; echo "Stripe setup didn't report the Go, Plus and Spark prices." >&2; exit 1; }

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
"${compose[@]}" exec -T api node dist/admin.js billing-mojo-plans $prices < /dev/null || { restore; exit 1; }
echo
echo "Public price list (what meldiq.app shows):"
curl -fsS http://127.0.0.1:18080/v2/billing/plans
echo
echo "Done. Backup of the previous settings: $backup"
