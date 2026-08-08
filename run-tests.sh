#!/usr/bin/env bash
#
# Run the whole test suite.
#
#   ./run-tests.sh            # API tests, then browser tests
#   ./run-tests.sh --api      # API tests only (fast)
#   ./run-tests.sh --browser  # browser tests only
#
# Everything runs in containers, so the only requirement is Docker. Nothing is
# installed on the host and nothing touches a real deployment: the app under
# test runs on a throwaway container with its database in memory.

set -euo pipefail
cd "$(dirname "$0")"

RUN_API=1
RUN_BROWSER=1
case "${1:-}" in
  --api) RUN_BROWSER=0 ;;
  --browser) RUN_API=0 ;;
  --help|-h) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "unknown option: $1" >&2; exit 2 ;;
esac

command -v docker >/dev/null || { echo "Docker is required" >&2; exit 1; }

PYTHON_IMAGE="python:3.12-slim"
PUPPETEER_IMAGE="ghcr.io/puppeteer/puppeteer:latest"
APP_IMAGE="logbook-test:latest"
NET="logbook-test-net-$$"
APP_CONTAINER="logbook-test-app-$$"
PASSCODE="test-passcode-do-not-use"
FAILED=0

step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

cleanup() {
  docker rm -f "$APP_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- API tests -------------------------------------------------------------

if [ "$RUN_API" -eq 1 ]; then
  step "API tests"
  docker run --rm -v "$PWD:/app:ro" -w /app "$PYTHON_IMAGE" sh -c '
    pip install --quiet --root-user-action=ignore -r requirements.txt -r requirements-dev.txt &&
    python -m pytest tests -q --no-header -p no:cacheprovider
  ' || FAILED=1
fi

# --- Browser tests ---------------------------------------------------------

if [ "$RUN_BROWSER" -eq 1 ]; then
  step "Building the app image"
  docker build -q -t "$APP_IMAGE" . >/dev/null

  step "Starting a throwaway instance"
  docker network create "$NET" >/dev/null
  # tmpfs, so the database exists only for this run and no real data is at risk.
  docker run -d --name "$APP_CONTAINER" --network "$NET" \
    --tmpfs /data -e DATA_DIR=/data -e LOGBOOK_PASSCODE="$PASSCODE" \
    "$APP_IMAGE" >/dev/null

  for _ in $(seq 1 20); do
    docker run --rm --network "$NET" "$PUPPETEER_IMAGE" \
      node -e "fetch('http://$APP_CONTAINER:8080/health').then(()=>process.exit(0)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1 && break
    sleep 1
  done

  step "Browser tests"
  # Mounted under the puppeteer home directory so `import puppeteer` resolves:
  # ES modules ignore NODE_PATH, so the suite has to sit beside node_modules.
  docker run --rm --network "$NET" \
    -v "$PWD/tests/browser:/home/pptruser/suite:ro" \
    -w /home/pptruser \
    -e BASE="http://$APP_CONTAINER:8080" -e PASSCODE="$PASSCODE" \
    --entrypoint node "$PUPPETEER_IMAGE" suite/run.mjs || FAILED=1

  if [ "$FAILED" -ne 0 ]; then
    step "App logs from the failing run"
    docker logs --tail 30 "$APP_CONTAINER" 2>&1 | sed 's/^/  /'
  fi
fi

step "$([ "$FAILED" -eq 0 ] && echo 'All tests passed' || echo 'Tests FAILED')"
exit "$FAILED"
