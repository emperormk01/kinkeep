#!/bin/sh
# KinKeep: stop any running instance, then start fresh in open (dev) mode.
cd "$(dirname "$0")" || exit 1
if [ -f .kinkeep.pid ]; then
  OLD=$(cat .kinkeep.pid)
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    kill "$OLD" 2>/dev/null
    sleep 2
  fi
  rm -f .kinkeep.pid
fi
setsid node ./node_modules/tsx/dist/cli.mjs src/server.ts "$@" > /tmp/kinkeep-run.log 2>&1 < /dev/null &
echo $! > .kinkeep.pid
sleep 5
cat /tmp/kinkeep-run.log
