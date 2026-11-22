#!/bin/sh
# Starts JM Selects as an ordinary (non-root) user.
#
# Which user? In this order:
#   1. PUID / PGID from .env, if set
#   2. the owner of the projects folder (/projects): so copied RAWs belong to the same
#      NAS user who owns that folder and can be opened from the studio PC
#   3. the owner of the data folder (/data)
#   4. 1000:1000
# The app's own data folder is then handed to that user. Photos are never touched
# (they are mounted read-only).
set -e

pick() { # owner uid:gid of a folder, unless it is root
  [ -d "$1" ] || return 1
  o="$(stat -c '%u:%g' "$1")"
  [ "${o%%:*}" != "0" ] || return 1
  echo "$o"
}

if [ "$(id -u)" = "0" ]; then
  if [ -n "$PUID" ]; then
    RUN="$PUID:${PGID:-$PUID}"
  else
    RUN="$(pick /projects || pick /data || echo 1000:1000)"
  fi
  RUN_UID="${RUN%%:*}"
  RUN_GID="${RUN##*:}"
  if [ "$RUN_UID" = "0" ]; then
    echo "Refusing to run as root (PUID=0). Set PUID to a normal NAS user id." >&2
    exit 1
  fi

  mkdir -p /data
  if [ "$(stat -c '%u' /data)" != "$RUN_UID" ]; then
    echo "Giving the app's data folder to user id $RUN_UID"
    chown -R "$RUN_UID:$RUN_GID" /data
  fi

  echo "Running as user id $RUN_UID (group $RUN_GID)"
  umask 002
  exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups --inh-caps=-all \
    node dist/server/index.js
fi

exec node dist/server/index.js
