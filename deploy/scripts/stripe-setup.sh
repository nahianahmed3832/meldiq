#!/usr/bin/env bash
# Connects Meldiq Mojo to Stripe in one go, without anyone seeing a secret (docs/BILLING.md › Stripe setup). Run it
# yourself, on your Mac, from the meldiq_android folder:
#
#   bash deploy/scripts/stripe-setup.sh            # test mode
#   bash deploy/scripts/stripe-setup.sh --live     # live mode: real charges (docs/BILLING.md › Going live)
#
# 1. asks for your Stripe secret key (Stripe Dashboard › Developers › API keys: sk_test_… in test mode, sk_live_… with
#    --live; or a restricted rk_… key with write access to Products, Prices, Customers, Checkout Sessions,
#    Subscriptions, Customer portal and Webhook endpoints, and read access to Account). Typed hidden; sent to the
#    server over SSH's standard input only;
# 2. on the server: backs .env up, stores the key, then runs `admin.js stripe-setup` in a one-off container from the
#    running image, which creates (or finds again) the Meldiq Mojo product, its $0.99 and $3.99 monthly prices, the
#    Meldiq Spark price, the webhook endpoint and the customer portal, and writes the webhook's signing secret, the
#    portal and the return pages into .env, never printing them;
# 3. turns billing on (BILLING_PROVIDER=stripe), restarts only the API, and publishes Mojo Go, Mojo Plus and Spark;
# 4. shows the public price list as the website sees it.
#
# With --live it first shows which Stripe account the key belongs to and refuses one that can't take payments yet,
# then asks you to type "go live", and copies the server half of this script to the server before running it.
# Running it again is safe. Undo: copy the .env backup it names back and restart the API (or set BILLING_PROVIDER=none).
set -euo pipefail
host="${MELDIQ_VPS:-root@72.60.107.88}"
dir="${MELDIQ_DIR:-/opt/griip-internal-messaging}"
here="$(cd "$(dirname "$0")" && pwd)"

live=false
replace=""
for arg in "$@"; do
  case "$arg" in
    --live) live=true ;;
    --replace-webhook) replace="--replace-webhook" ;;
    *) echo "Unknown option $arg (known: --live, --replace-webhook); nothing changed." >&2; exit 1 ;;
  esac
done

if $live; then
  read -rsp "Stripe LIVE secret key (sk_live_… or rk_live_…, hidden): " key
else
  read -rsp "Stripe test secret key (sk_test_… or rk_test_…, hidden): " key
fi
echo
case "$key" in
  sk_test_*|rk_test_*) if $live; then echo "That's a test key, and --live needs a live one; nothing changed." >&2; exit 1; fi ;;
  sk_live_*|rk_live_*) if ! $live; then echo "That's a live key. Without --live this script sets up test mode only; nothing changed." >&2; exit 1; fi ;;
  *) echo "That doesn't look like a Stripe secret key; nothing changed." >&2; exit 1 ;;
esac

if $live; then
  # Which account this key belongs to, and whether Stripe lets it take payments. The key goes to curl on standard
  # input (a config line), never as an argument.
  account=$(printf 'user = "%s:"\n' "$key" | curl -sS --config - https://api.stripe.com/v1/account) || { echo "Couldn't reach Stripe; nothing changed." >&2; exit 1; }
  summary=$(printf '%s' "$account" | python3 -c '
import json, sys
a = json.load(sys.stdin)
if "error" in a:
    print("ERROR " + a["error"].get("message", "unknown error")); sys.exit()
name = (a.get("business_profile") or {}).get("name") or ((a.get("settings") or {}).get("dashboard") or {}).get("display_name") or "(no name)"
print("ACCOUNT %s · %s · %s" % (a.get("id"), name, a.get("country")))
print("CHARGES %s" % str(bool(a.get("charges_enabled"))).lower())
print("PAYOUTS %s" % str(bool(a.get("payouts_enabled"))).lower())
print("DETAILS %s" % str(bool(a.get("details_submitted"))).lower())
')
  unset account
  case "$summary" in ERROR*) echo "Stripe refused the key: ${summary#ERROR }. Nothing changed." >&2; exit 1 ;; esac
  echo "Stripe account: $(sed -n 's/^ACCOUNT //p' <<< "$summary")"
  echo "  can take payments: $(sed -n 's/^CHARGES //p' <<< "$summary") · payouts: $(sed -n 's/^PAYOUTS //p' <<< "$summary") · details submitted: $(sed -n 's/^DETAILS //p' <<< "$summary")"
  if ! grep -q '^CHARGES true$' <<< "$summary"; then
    echo "Stripe doesn't let this account take payments yet: finish activating it in the Stripe Dashboard; nothing changed." >&2
    exit 1
  fi
  grep -q '^PAYOUTS true$' <<< "$summary" || echo "Warning: payouts aren't enabled yet, so money will wait at Stripe until you add a bank account."
  echo
  echo "This turns on REAL payments at https://msg.meldiq.app: anyone can then buy Mojo Go (\$0.99/month), Mojo Plus"
  echo "(\$3.99/month), Meldiq Spark (\$0.99/month each) and gifts, charged to real cards, on meldiq.app and web.meldiq.app."
  read -rp 'Type "go live" to continue: ' confirm
  [ "$confirm" = "go live" ] || { echo "Nothing changed."; exit 1; }
  # The server runs its own copy of the server half: bring it up to date with this one.
  scp -q "$here/stripe-setup-remote.sh" "$host:$dir/scripts/stripe-setup-remote.sh"
fi

mode=""
if $live; then mode="--live"; fi
# The key travels on SSH's standard input, never as an argument (arguments show up in process lists).
printf '%s\n' "$key" | ssh "$host" "bash '$dir/scripts/stripe-setup-remote.sh' $mode $replace"
unset key
