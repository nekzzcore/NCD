#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
# Prepare the matching version metadata and OTA ZIP before publishing static assets.
node bin/prepare-update.cjs "${1:-}" https://goaltracker-pro.nekzzcore.workers.dev
npx wrangler deploy
echo 'NCD опубликован: https://goaltracker-pro.nekzzcore.workers.dev'
