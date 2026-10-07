#!/bin/sh
# KinKeep launcher — run from the repo dir regardless of caller cwd
cd "$(dirname "$0")" || exit 1
exec node ./node_modules/tsx/dist/cli.mjs src/server.ts "$@"
