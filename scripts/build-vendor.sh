#!/usr/bin/env bash
# Bundles React for the browser harness (the desktop app provides React to the real plugin).
# Uses a hermes-agent checkout's esbuild + react, so the harness matches the host's versions.
#   HERMES_AGENT_DIR=<checkout> scripts/build-vendor.sh [outdir]
set -euo pipefail
cd "$(dirname "$0")/.."
HERMES_AGENT_DIR="${HERMES_AGENT_DIR:-$HOME/projects/nous/hermes-agent-system-metrics}"
NODE_PATH="$HERMES_AGENT_DIR/node_modules" "$HERMES_AGENT_DIR/node_modules/.bin/esbuild" \
  vendor/src/react.js vendor/src/jsx-runtime.js vendor/src/react-dom-client.js \
  --bundle --splitting --format=esm --outdir="${1:-vendor}"
