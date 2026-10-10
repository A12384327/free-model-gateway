#!/bin/sh
# free-model-gateway container entrypoint.
#
# Runs two processes in one container, on purpose: the OFM standalone service
# binds 127.0.0.1 only (its own hard security rule), and nginx is the single
# network-facing door that proxies 0.0.0.0:8123 -> 127.0.0.1:18900. Sharing
# the network namespace is what makes the loopback hop legitimate.
#
# Process model: simple pid-1 shell. `init: true` in docker-compose.yml adds
# Docker's own init as pid 1, so this script only has to:
#   - clear a stale service.lock (a killed container leaves it behind; the
#     pid recorded in it is gone by definition — see ofm standalone README),
#   - start nginx and node,
#   - forward TERM/INT to both, and
#   - exit when either process dies (restart: unless-stopped re-pulls both).

set -eu

DATA_DIR=/data
APP_DIR=/app

mkdir -p "$DATA_DIR"

# A previous container instance may have been SIGKILLed mid-run, leaving
# <dataDir>/service.lock. The pid inside belongs to a dead container; remove
# the lock so the service can start. (fs.openSync 'wx' would EEXIST on it.)
rm -f "$DATA_DIR/service.lock"

echo "[entrypoint] starting ofm standalone on 127.0.0.1:18900 ..."
cd "$APP_DIR"
node packages/standalone/cli.mjs --port 18900 --data-dir "$DATA_DIR" &
OFM_PID=$!

echo "[entrypoint] starting nginx on 0.0.0.0:8123 ..."
nginx -g 'daemon off;' &
NGINX_PID=$!

shutdown() {
    echo "[entrypoint] signal received, stopping ..."
    kill -TERM "$OFM_PID" "$NGINX_PID" 2>/dev/null || true
    wait "$OFM_PID" 2>/dev/null || true
    wait "$NGINX_PID" 2>/dev/null || true
    exit 0
}
trap shutdown TERM INT

# Reap whichever process exits first; the container should not outlive
# either half. (POSIX sh has no `wait -n`; poll with kill -0.)
while :; do
    if ! kill -0 "$OFM_PID" 2>/dev/null; then
        echo "[entrypoint] ofm exited unexpectedly" >&2
        wait "$OFM_PID" 2>/dev/null || true
        kill -TERM "$NGINX_PID" 2>/dev/null || true
        wait "$NGINX_PID" 2>/dev/null || true
        exit 1
    fi
    if ! kill -0 "$NGINX_PID" 2>/dev/null; then
        echo "[entrypoint] nginx exited unexpectedly" >&2
        wait "$NGINX_PID" 2>/dev/null || true
        kill -TERM "$OFM_PID" 2>/dev/null || true
        wait "$OFM_PID" 2>/dev/null || true
        exit 1
    fi
    sleep 1
done
