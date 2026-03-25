#!/bin/bash
# Load env file
set -a
source /home/agentfleet/nanoclaw/data/env/env
set +a

# Load multiline PEM key
export GITHUB_APP_PRIVATE_KEY=$(cat /home/agentfleet/github-app-key.pem)

exec /usr/bin/node /home/agentfleet/nanoclaw/dist/index.js
