#!/usr/bin/env bash
# Connects Meldiq Mojo to Stripe in one go, without anyone seeing a secret (docs/BILLING.md › Stripe setup). Run it
# yourself, on your Mac, from the meldiq_android folder:
#
#   bash deploy/scripts/stripe-setup.sh
#
# 1. asks for your Stripe *test* secret key (Stripe Dashboard › Developers › API keys, test mode: sk_test_…; or a
#    restricted rk_test_… key with write access to Products, Prices, Customers, Checkout Sessions, Subscriptions,
#    Customer portal and Webhook endpoints). Typed hidden; sent to the server over SSH's standard input only;
# 2. on the server: backs .env up, stores the key, then runs `admin.js stripe-setup` in a one-off container from the
#    running image, which creates (or finds again) the Meldiq Mojo product, its $0.99 and $3.99 monthly prices, the
#    webhook endpoint and the customer portal, and writes the webhook's signing secret, the portal and the return page
#    into .env, never printing them;
# 3. turns billing on (BILLING_PROVIDER=stripe), restarts only the API, and publishes Mojo Go and Mojo Plus;
# 4. shows the public price list as the website sees it.
#
# Test keys only: a live key is refused (going live is a separate, deliberate step). Running it again is safe.
# Undo: copy the .env backup it names back and restart the API (BILLING_PROVIDER back to none).
set -euo pipefail
host="${MELDIQ_VPS:-root@72.60.107.88}"
dir="${MELDIQ_DIR:-/opt/griip-internal-messaging}"

read -rsp "Stripe test secret key (sk_test_… or rk_test_…, hidden): " key
echo
case "$key" in
  sk_test_*|rk_test_*) ;;
  sk_live_*|rk_live_*) echo "That's a live key. This script sets up test mode only; nothing changed." >&2; exit 1 ;;
  *) echo "That doesn't look like a Stripe secret key; nothing changed." >&2; exit 1 ;;
esac

replace=""
[ "${1:-}" = "--replace-webhook" ] && replace="--replace-webhook"
# The key travels on SSH's standard input, never as an argument (arguments show up in process lists).
printf '%s\n' "$key" | ssh "$host" "bash '$dir/scripts/stripe-setup-remote.sh' $replace"
unset key
