#!/bin/bash
set -e
cd /home/agentfleet/nanoclaw

# Acquire a fresh Infisical access token using stored machine identity credentials
if [ -n "$INFISICAL_CLIENT_ID" ] && [ -n "$INFISICAL_CLIENT_SECRET" ]; then
  INFISICAL_TOKEN=$(infisical login --method=universal-auth \
    --client-id="$INFISICAL_CLIENT_ID" \
    --client-secret="$INFISICAL_CLIENT_SECRET" \
    --plain --silent 2>/dev/null) || true
fi

if [ -n "$INFISICAL_TOKEN" ] && timeout 10 infisical run --env=prod --path=/ --projectId=8cb8a2d4-3877-40da-8088-ee7d93f0f77d --token="$INFISICAL_TOKEN" -- true 2>/dev/null; then
  exec infisical run --env=prod --path=/ --projectId=8cb8a2d4-3877-40da-8088-ee7d93f0f77d --token="$INFISICAL_TOKEN" -- npm start
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
