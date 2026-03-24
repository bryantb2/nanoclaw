#!/bin/bash
set -e
cd ~/nanoclaw
git fetch origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ]; then echo "[deploy] Up to date."; exit 0; fi
echo "[deploy] Deploying $(git rev-parse --short origin/main)..."
git merge origin/main && npm run build && ./container/build.sh
systemctl --user restart nanoclaw
echo "[deploy] Done at $(date). HEAD: $(git rev-parse --short HEAD)"
