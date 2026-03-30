#!/bin/bash
# deploy.sh — Nightly autodeploy for NanoClaw fleet.
# Called by cron: 0 5 * * * /home/agentfleet/nanoclaw/deploy.sh
# Only restarts if new code is available on origin/main.
# Delegates all restart logic to restart-fleet.sh to avoid code drift.
set -e

cd ~/nanoclaw
git fetch origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "$LOCAL" = "$REMOTE" ]; then
  echo "[deploy] Up to date at $(git rev-parse --short HEAD). No restart needed."
  exit 0
fi

echo "[deploy] New code detected: $(git rev-parse --short HEAD) -> $(git rev-parse --short origin/main)"
echo "[deploy] Delegating to restart-fleet.sh..."
/home/agentfleet/restart-fleet.sh
echo "[deploy] Deploy complete at $(date)."
