#!/bin/sh
# Mounted volumes arrive owned by root. If we start as root, hand the data
# directory to the unprivileged `node` user and drop privileges; if the host
# already runs us as someone else, just start.
set -e

DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"
fi

exec "$@"
