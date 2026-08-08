#!/usr/bin/env bash
#
# Deploy Logbook to your own Fly.io account.
#
#   ./install.sh                          # asks for what it needs
#   ./install.sh --app my-logbook --yes   # no prompts
#
# Safe to re-run: an existing app, volume or secret is reused rather than
# replaced, so running this again deploys the current code and leaves the data
# alone.

set -euo pipefail

APP=""
REGION="lhr"
PASSCODE=""
DOMAIN=""
VOLUME_SIZE=1
ASSUME_YES=0

die() { printf '\nError: %s\n' "$1" >&2; exit 1; }
say() { printf '%s\n' "$1"; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

usage() {
  cat <<'USAGE'
Deploy Logbook to Fly.io.

Options:
  --app NAME        Fly app name. Must be unique across all of Fly.
                    Becomes https://NAME.fly.dev
  --region CODE     Fly region (default: lhr). See `fly platform regions`.
  --passcode TEXT   Sign-in passcode. Generated if omitted.
  --domain HOST     Also set up a custom domain, e.g. logbook.example.com.
                    Prints the DNS record you need to add.
  --volume-size GB  Persistent disk size in GB (default: 1).
  --yes             Do not prompt. Requires --app.
  --help            Show this.

Needs: flyctl, signed in (`fly auth login`), and a Fly account with a payment
method. Logbook is small — expect a low single-digit monthly cost.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="${2:-}"; shift 2 ;;
    --region) REGION="${2:-}"; shift 2 ;;
    --passcode) PASSCODE="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --volume-size) VOLUME_SIZE="${2:-}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage; die "unknown option: $1" ;;
  esac
done

cd "$(dirname "$0")"

# --- Preflight -------------------------------------------------------------

step "Checking prerequisites"

FLY="$(command -v flyctl || command -v fly || true)"
[ -n "$FLY" ] || FLY="$HOME/.fly/bin/flyctl"
[ -x "$FLY" ] || die "flyctl not found. Install it with:
  curl -L https://fly.io/install.sh | sh
then run: fly auth login"

ACCOUNT="$("$FLY" auth whoami 2>/dev/null || true)"
[ -n "$ACCOUNT" ] || die "not signed in to Fly. Run: fly auth login"
say "  flyctl ready, signed in as $ACCOUNT"

[ -f fly.toml.template ] || die "run this from the Logbook checkout (fly.toml.template is missing)"

# --- Settings --------------------------------------------------------------

if [ -z "$APP" ]; then
  [ "$ASSUME_YES" -eq 1 ] && die "--yes requires --app"
  printf '\nApp name (becomes https://NAME.fly.dev): '
  read -r APP
fi
[ -n "$APP" ] || die "an app name is required"
case "$APP" in
  *[!a-z0-9-]*|-*|*-) die "app name must be lowercase letters, numbers and dashes, and cannot start or end with a dash" ;;
esac

# A memorable passcode beats a strong one nobody will type at 3am. The server
# locks out after 10 wrong attempts in 15 minutes, which is what actually makes
# guessing impractical.
if [ -z "$PASSCODE" ]; then
  WORDS=(amber anchor birch bramble cedar cinder clover cobalt copper coral
         cotton crimson damson delta ember fable fern flint garnet ginger
         granite harbor hazel heather indigo ivory jasper juniper kestrel
         lantern larch laurel linen maple marble meadow mineral nectar nickel
         nutmeg olive onyx opal pebble pewter pine quarry quartz raven ripple
         rowan saffron sage slate sorrel spruce sterling teak thistle timber
         umber velvet willow yarrow zephyr)
  rand_below() {
    local n
    n="$(od -An -N4 -tu4 < /dev/urandom | tr -d ' ')"
    printf '%s' "$(( n % $1 ))"
  }
  PASSCODE="$(for _ in 1 2 3 4; do printf '%s-' "${WORDS[$(rand_below ${#WORDS[@]})]}"; done)$(rand_below 90 | awk '{print $1+10}')"
fi

VOLUME="logbook_data"

say ""
say "  app      $APP  ->  https://$APP.fly.dev"
say "  region   $REGION"
say "  volume   $VOLUME (${VOLUME_SIZE}GB)"
say "  passcode $PASSCODE"
[ -n "$DOMAIN" ] && say "  domain   $DOMAIN"

if [ "$ASSUME_YES" -eq 0 ]; then
  printf '\nDeploy with these settings? [y/N] '
  read -r reply
  case "$reply" in y|Y|yes|YES) ;; *) die "cancelled" ;; esac
fi

# --- Create ----------------------------------------------------------------

step "Creating the app"
if "$FLY" apps list 2>/dev/null | awk '{print $1}' | grep -qx "$APP"; then
  say "  $APP already exists, reusing it"
else
  "$FLY" apps create "$APP" >/dev/null \
    || die "could not create '$APP'. Fly app names are global, so it may be taken. Try another --app."
  say "  created $APP"
fi

step "Creating the volume"
if "$FLY" volumes list --app "$APP" 2>/dev/null | grep -q "[[:space:]]$VOLUME[[:space:]]"; then
  say "  $VOLUME already exists, leaving it and its data alone"
else
  "$FLY" volumes create "$VOLUME" --size "$VOLUME_SIZE" --region "$REGION" --app "$APP" --yes >/dev/null \
    || die "could not create the volume"
  say "  created $VOLUME (${VOLUME_SIZE}GB, encrypted, daily snapshots)"
fi

step "Setting the passcode"
"$FLY" secrets set "LOGBOOK_PASSCODE=$PASSCODE" --app "$APP" --stage >/dev/null \
  || die "could not set the passcode"
say "  stored as a Fly secret, not in this repo"

step "Writing fly.toml"
sed -e "s|__APP__|$APP|" -e "s|__REGION__|$REGION|" -e "s|__VOLUME__|$VOLUME|" \
  fly.toml.template > fly.toml
say "  fly.toml written (gitignored — it names this one deployment)"

step "Deploying"
"$FLY" deploy --remote-only --app "$APP" --yes || die "deploy failed. Check: fly logs --app $APP"

# --- Verify ----------------------------------------------------------------

step "Verifying"
URL="https://$APP.fly.dev"
HEALTH=""
for _ in 1 2 3 4 5 6 7 8; do
  HEALTH="$(curl -fsS -m 20 "$URL/health" 2>/dev/null || true)"
  [ -n "$HEALTH" ] && break
  sleep 5
done
[ -n "$HEALTH" ] || die "deployed, but $URL/health did not answer. Check: fly logs --app $APP"
say "  health: $HEALTH"

case "$HEALTH" in
  *'"auth":true'*) say "  the passcode is being enforced" ;;
  *) die "the app is up but running WITHOUT a passcode. Do not expose it until this is fixed." ;;
esac

if [ -n "$DOMAIN" ]; then
  step "Setting up $DOMAIN"
  "$FLY" certs add "$DOMAIN" --app "$APP" >/dev/null 2>&1 || true
  say "  add this DNS record at your provider, then the certificate issues on its own:"
  say ""
  "$FLY" certs setup "$DOMAIN" --app "$APP" 2>/dev/null | sed -n '/CNAME Record/,+2p' | sed 's/^/    /'
  say ""
  say "  check progress with: fly certs check $DOMAIN --app $APP"
fi

# --- Done ------------------------------------------------------------------

cat <<DONE

Logbook is live.

  $URL
  passcode: $PASSCODE

Save that passcode — it is not stored anywhere you can read it back. To change
it later:

  fly secrets set LOGBOOK_PASSCODE='new-passcode' --app $APP

On your phone, open the URL, sign in, then use the browser's share menu to add
it to the Home Screen. To deploy changes later, run this script again — your
data is on the volume and is not touched.
DONE
