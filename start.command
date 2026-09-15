#!/usr/bin/env bash
# Double-click this on macOS, or run ./start.command on Linux.
#
# Everything below is here so that starting Pose Board is one action rather
# than a terminal session: it finds Node, makes a password the first time,
# starts the server and opens the browser.

cd "$(dirname "$0")" || exit 1

printf '\n  Pose Board\n  ----------\n\n'

if ! command -v node >/dev/null 2>&1; then
  printf '  Node.js is not installed, and Pose Board needs it to run.\n\n'
  printf '  Install it from https://nodejs.org (take the LTS version),\n'
  printf '  then double-click this file again.\n\n'
  read -r -p '  Press return to close. '
  exit 1
fi

# Node 18.17 is the floor; anything older will fail in confusing ways later.
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 18 ]; then
  printf '  Node.js %s is too old — Pose Board needs 18.17 or newer.\n' "$(node -v)"
  printf '  Update it from https://nodejs.org and try again.\n\n'
  read -r -p '  Press return to close. '
  exit 1
fi

mkdir -p data
PASSWORD_FILE="data/studio-password.txt"

if [ ! -f "$PASSWORD_FILE" ]; then
  # Generated rather than asked for, so a first run cannot end up on
  # "password". Edit the file to change it.
  node -e 'process.stdout.write(require("crypto").randomBytes(9).toString("base64url"))' > "$PASSWORD_FILE"
  chmod 600 "$PASSWORD_FILE"
  printf '  A studio password has been made for you:\n\n'
  printf '      %s\n\n' "$(cat "$PASSWORD_FILE")"
  printf '  It is saved in %s — edit that file to change it.\n\n' "$PASSWORD_FILE"
fi

ADMIN_PASSWORD="$(cat "$PASSWORD_FILE")"
export ADMIN_PASSWORD

printf '  Starting on http://localhost:4000\n'
printf '  Sign in with the password in %s\n' "$PASSWORD_FILE"
printf '  Close this window to stop.\n\n'

# Give the server a moment to bind before the browser asks for the page.
( sleep 2
  if command -v open >/dev/null 2>&1; then open http://localhost:4000
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open http://localhost:4000
  fi ) >/dev/null 2>&1 &

exec node server.js
