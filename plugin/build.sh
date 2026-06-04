#!/usr/bin/env bash
# Optional: rebuild dist/bundle.js from src/index.tsx.
# You do NOT need this to use the plugin — dist/bundle.js already works as-is.
# Requires Node + npx (network access for the one-time esbuild download).
set -euo pipefail
cd "$(dirname "$0")"

npx --yes esbuild src/index.tsx \
  --bundle \
  --format=iife \
  --global-name=__HS_PLUGIN__ \
  --jsx=automatic \
  --external:react \
  --external:react-dom \
  --outfile=dist/bundle.js

echo "Built dist/bundle.js"
