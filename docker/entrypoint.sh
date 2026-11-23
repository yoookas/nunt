#!/bin/sh
# Container entrypoint: make sure the data volume is writable by the runtime
# user and drop root privileges before starting the service.
#
# The image starts as root for one reason only: PUID/PGID let the operator
# match the uid/gid that owns the bind mounted data directory on the host
# (common on NAS devices). The service itself is always exec'ed as the
# unprivileged user, so it never runs as root.
set -eu

DATA_DIR="${DATA_DIR:-/data}"
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

case "$PUID$PGID" in
  *[!0-9]*)
    echo "entrypoint: PUID and PGID must be numeric (got '$PUID'/'$PGID')" >&2
    exit 64
    ;;
esac

mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  # A recursive chown is metadata only and repairs a data directory that was
  # restored by root; it is cheap enough to run on every start.
  owner="$(stat -c '%u:%g' "$DATA_DIR" 2>/dev/null || true)"
  if [ "$owner" != "$PUID:$PGID" ]; then
    echo "entrypoint: chown -R $PUID:$PGID $DATA_DIR"
    chown -R "$PUID:$PGID" "$DATA_DIR" 2>/dev/null \
      || echo "entrypoint: warning: chown failed (read-only or network volume?)" >&2
  fi

  # Fail fast with a useful message instead of letting the service die later
  # with "permission denied" while writing config.json.
  if ! su-exec "$PUID:$PGID" sh -c 'test -w "$1"' sh "$DATA_DIR"; then
    echo "entrypoint: $DATA_DIR is not writable by $PUID:$PGID" >&2
    echo "entrypoint: check the volume mount and set PUID/PGID to the owner of the host directory" >&2
    exit 73
  fi

  if [ "$PUID" = "0" ] || [ "$PGID" = "0" ]; then
    echo "entrypoint: warning: PUID/PGID 0 means the service runs as root" >&2
  fi

  exec su-exec "$PUID:$PGID" "$@"
fi

# Already started as a non-root user (docker run --user, rootless Docker,
# Podman). Nothing to drop; only check the volume is usable.
if [ ! -w "$DATA_DIR" ]; then
  echo "entrypoint: $DATA_DIR is not writable by uid $(id -u)" >&2
  echo "entrypoint: fix the volume ownership or start with --user 0 to let PUID/PGID apply" >&2
  exit 73
fi

exec "$@"
