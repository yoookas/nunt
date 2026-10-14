#!/bin/sh
# Container entrypoint: make sure the data volume is writable by the runtime
# user and drop root privileges before starting the service.
set -eu

DATA_DIR="${DATA_DIR:-/data}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null || true
  exec su-exec "$PUID:$PGID" "$@"
fi

exec "$@"
