#!/bin/bash
set -e

# --- Git credential setup for multi-installation GitHub App ---
# GITHUB_INSTALLATION_TOKENS is a JSON array: [{"account":"org","token":"ghs_..."},...]
# Each entry gets a line in git credential store so the agent can push to all repos.
if [ -n "$GITHUB_INSTALLATION_TOKENS" ]; then
  CRED_FILE="$HOME/.git-credentials"
  : > "$CRED_FILE"
  chmod 600 "$CRED_FILE"

  # Parse JSON array and write credential entries
  echo "$GITHUB_INSTALLATION_TOKENS" | node -e "
    const tokens = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    tokens.forEach(t => console.log('https://x-access-token:' + t.token + '@github.com'));
  " >> "$CRED_FILE"

  git config --global credential.helper "store --file=$CRED_FILE"
fi

# --- Build TypeScript agent runner ---
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# --- Run agent ---
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
