#!/bin/bash
set -e
cd /home/agentfleet/nanoclaw

if timeout 10 infisical run --env=production --path=/ -- true 2>/dev/null; then
  exec infisical run --env=production --path=/ -- npm start
else
  echo "[start.sh] Infisical unavailable - using .env.emergency fallback" >&2
  if [ -f /home/agentfleet/nanoclaw/.env.emergency ]; then
    set -a; source /home/agentfleet/nanoclaw/.env.emergency; set +a
    exec npm start
  else
    echo "[start.sh] FATAL: No .env.emergency found. Cannot start." >&2
    exit 1
  fi
fi
