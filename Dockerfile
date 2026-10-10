# free-model-gateway: single container, two processes.
#
# - OFM standalone (Node, zero npm deps) on 127.0.0.1:18900
#   (ofm's own hard rule: it refuses non-loopback binds — that is its
#   security model; the proxy, not the service, faces the network)
# - nginx on 0.0.0.0:8123 proxying into that loopback port
#
# Base image: node:22-alpine satisfies upstream engines
# (^22.19.0 || >=24.0.0). No npm install happens at build time — the
# upstream tree runs dependency-free (packages/standalone/web is the
# prebuilt management UI; the channel pack is a pregenerated bundle).

FROM node:22-alpine

# nginx from alpine packages; the default http.d include picks up our conf.
RUN apk add --no-cache nginx

WORKDIR /app

# The upstream tree, verbatim (ofm/UPSTREAM.md documents provenance).
# The channel worker loads ofm/vendor/channel-pack/qoder-auth-wasm.wasm at
# runtime via a relative import.meta.url path, so the whole ofm/ tree ships.
COPY ofm/ /app/

# Reverse proxy rules: /v1/* passthrough, management surface rewritten into
# the loopback shape (see nginx/ofm.conf for the fence reasoning).
COPY nginx/ofm.conf /etc/nginx/http.d/ofm.conf

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /run/nginx /data

ENV OFM_HOME=/data

EXPOSE 8123

# ofm's /health is unauthenticated by design (src/forward.js answers it
# before the key check). Give the channel worker time to come up: the
# service binds its listener early but the catalog/channels load async.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:18900/health || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
