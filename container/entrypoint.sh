#!/bin/bash
set -e

# --- Git + gh credential setup for multi-installation GitHub App ---
# GITHUB_APP_PRIVATE_KEY + GITHUB_APP_ID are passed from the host.
# Tokens are generated lazily by github-token.cjs (cached ~55 min).
if [ -n "$GITHUB_APP_PRIVATE_KEY" ] && [ -n "$GITHUB_APP_ID" ]; then

  # --- Git credential helper: generates fresh token on demand ---
  HELPER="$HOME/.git-credential-helper.sh"
  cat > "$HELPER" << 'HELPEREOF'
#!/bin/bash
if [ "$1" != "get" ]; then exit 0; fi

REPO_PATH=""
while IFS='=' read -r key value; do
  [ -z "$key" ] && break
  [ "$key" = "path" ] && REPO_PATH="$value"
done

OWNER=$(echo "$REPO_PATH" | cut -d'/' -f1 | tr '[:upper:]' '[:lower:]')
[ -z "$OWNER" ] && OWNER="default"

if ! TOKEN=$(node /app/github-token.cjs "$OWNER"); then
  exit 1
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

  # --- gh CLI wrapper: generates fresh token per invocation ---
  cat > /usr/bin/gh << 'GHEOF'
#!/bin/bash
OWNER=""

# Check -R / --repo flag
ARGS="$*"
if [[ "$ARGS" =~ -R[[:space:]]+([^/[:space:]]+)/ ]]; then
  OWNER="${BASH_REMATCH[1]}"
elif [[ "$ARGS" =~ --repo[[:space:]]+([^/[:space:]]+)/ ]]; then
  OWNER="${BASH_REMATCH[1]}"
fi

# Check positional args for owner/repo pattern (e.g., gh repo view owner/repo)
if [ -z "$OWNER" ]; then
  for arg in "$@"; do
    if [[ "$arg" =~ ^([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$ ]]; then
      OWNER="${BASH_REMATCH[1]}"
      break
    fi
  done
fi

# Fall back to git remote origin in cwd
if [ -z "$OWNER" ] && git rev-parse --git-dir >/dev/null 2>&1; then
  REMOTE_URL=$(git remote get-url origin 2>/dev/null || true)
  if [[ "$REMOTE_URL" =~ github\.com[:/]([^/]+)/ ]]; then
    OWNER="${BASH_REMATCH[1]}"
  fi
fi

OWNER=$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')
[ -z "$OWNER" ] && OWNER="default"

TOKEN=$(node /app/github-token.cjs "$OWNER" 2>/dev/null)
if [ -n "$TOKEN" ]; then
  export GH_TOKEN="$TOKEN"
fi

exec /usr/bin/gh.real "$@"
GHEOF
  chmod +x /usr/bin/gh

  # Unset GITHUB_TOKEN so gh uses GH_TOKEN from wrapper
  unset GITHUB_TOKEN
fi

# --- Secret scanning pre-commit hook (SEC-17, ASEC-03) ---
HOOKS_DIR="$HOME/.git-hooks"
mkdir -p "$HOOKS_DIR"
cat > "$HOOKS_DIR/pre-commit" << 'HOOKEOF'
#!/bin/bash
# Block commits containing credential patterns
# Patterns: API keys, tokens, PEM blocks, base64 JSON keys

PATTERNS=(
  'sk-ant-api[0-9]'
  'sk-[a-zA-Z0-9]{20,}'
  'ghp_[A-Za-z0-9]{36}'
  'ghs_[A-Za-z0-9]{36}'
  'ghu_[A-Za-z0-9]{36}'
  'lin_api_[A-Za-z0-9]+'
  'xoxb-[0-9]{11,}'
  'xoxp-[0-9]{11,}'
  'AKIA[A-Z0-9]{16}'
  '-----BEGIN (RSA |EC )?PRIVATE KEY-----'
  '-----BEGIN CERTIFICATE-----'
  'eyJ[A-Za-z0-9+/=]{50,}'
)

STAGED=$(git diff --cached --name-only --diff-filter=ACM)
if [ -z "$STAGED" ]; then exit 0; fi

FOUND=0
for pattern in "${PATTERNS[@]}"; do
  MATCHES=$(git diff --cached -U0 -- $STAGED | grep -E "^\+" | grep -v "^+++" | grep -E "$pattern" || true)
  if [ -n "$MATCHES" ]; then
    echo "ERROR: Potential secret found matching pattern: $pattern"
    echo "$MATCHES" | head -5
    echo ""
    FOUND=1
  fi
done

if [ "$FOUND" -eq 1 ]; then
  echo "BLOCKED: Remove secrets from staged changes before committing."
  echo "If this is a false positive, use: git commit --no-verify"
  exit 1
fi
exit 0
HOOKEOF
chmod +x "$HOOKS_DIR/pre-commit"
git config --global core.hooksPath "$HOOKS_DIR"

# --- Build TypeScript agent runner ---
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# --- Run agent ---
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
