#!/bin/bash
set -e

# --- Git + gh credential setup for multi-installation GitHub App ---
# GITHUB_INSTALLATION_TOKENS is a JSON array: [{"account":"org","token":"ghs_..."},...]
# Sets up:
#   1. A git credential helper that routes by repo owner (for git push)
#   2. Per-account GITHUB_TOKEN_<ACCOUNT> env vars (for gh CLI per-repo)
#   3. GITHUB_TOKEN stays as-is (org token, primary for gh CLI)
if [ -n "$GITHUB_INSTALLATION_TOKENS" ]; then

  # --- Git credential helper: routes token by repo owner ---
  HELPER="$HOME/.git-credential-helper.sh"
  cat > "$HELPER" << 'HELPEREOF'
#!/bin/bash
if [ "$1" != "get" ]; then exit 0; fi

declare -A TOKENS
eval "$(echo "$GITHUB_INSTALLATION_TOKENS" | node -e "
  const tokens = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  tokens.forEach(t => console.log('TOKENS[\"' + t.account.toLowerCase() + '\"]=\"' + t.token + '\"'));
")"

REPO_PATH=""
while IFS='=' read -r key value; do
  [ -z "$key" ] && break
  [ "$key" = "path" ] && REPO_PATH="$value"
done

OWNER=$(echo "$REPO_PATH" | cut -d'/' -f1 | tr '[:upper:]' '[:lower:]')

TOKEN="${TOKENS[$OWNER]}"
if [ -z "$TOKEN" ]; then
  TOKEN=$(echo "$GITHUB_INSTALLATION_TOKENS" | node -e "
    const t = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log(t[0].token);
  ")
fi

echo "protocol=https"
echo "host=github.com"
echo "username=x-access-token"
echo "password=$TOKEN"
echo ""
HELPEREOF
  chmod +x "$HELPER"

  git config --global credential.helper "$HELPER"
  git config --global credential.useHttpPath true

  # --- Export per-account tokens as env vars ---
  # e.g., GITHUB_TOKEN_BRYANTB2=ghs_xxx, GITHUB_TOKEN_KREWTRACK=ghs_yyy
  # Agent can use: GH_TOKEN=$GITHUB_TOKEN_BRYANTB2 gh pr create ...
  eval "$(echo "$GITHUB_INSTALLATION_TOKENS" | node -e "
    const tokens = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    tokens.forEach(t => {
      const name = 'GITHUB_TOKEN_' + t.account.toUpperCase().replace(/[^A-Z0-9]/g, '_');
      console.log('export ' + name + '=\"' + t.token + '\"');
    });
  ")"
fi

# --- Build TypeScript agent runner ---
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# --- Run agent ---
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
