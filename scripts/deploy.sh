#!/bin/bash
# free-model-gateway — idempotent server-side deploy script.
#
# What it does:
#   1. installs Docker if missing (get.docker.com, mirrors-aware)
#   2. docker compose up -d --build
#   3. waits for /health on the gateway (up to ~3 min), prints logs on failure
#
# Safe to re-run: every step is a no-op when already in the desired state.

set -euo pipefail
cd "$(dirname "$0")/.."

PORT=8123

echo "== free-model-gateway deploy =="

# --- Docker -------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found — installing (get.docker.com) ..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker 2>/dev/null || service docker start 2>/dev/null || true
else
  echo "docker: $(docker --version | head -c 60)"
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: docker compose plugin not available" >&2
  exit 1
fi

# --- Build & start ------------------------------------------------------
echo "building + starting (port ${PORT}) ..."
docker compose up -d --build

# --- Wait for health ----------------------------------------------------
echo "waiting for /health ..."
ok=0
for attempt in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 3
done

if [ "$ok" != 1 ]; then
  echo "ERROR: gateway did not become healthy in time; recent logs:" >&2
  docker compose logs --tail 60 gateway >&2 || true
  exit 1
fi

echo ""
echo "== deployed =="
echo "  API     : http://<this-host>:${PORT}/v1"
echo "  Admin UI: http://<this-host>:${PORT}/"
echo "  API key : docker compose exec gateway cat /data/settings.json   (\"forwardKey\")"
echo "  One-time login link (10 min): docker compose logs gateway | grep login"
echo ""
echo "Next: open TCP ${PORT} in your cloud firewall (Lighthouse console -> Firewall)."
