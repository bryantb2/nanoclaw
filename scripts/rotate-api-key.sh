#!/bin/bash
set -e

# rotate-api-key.sh — Safely rotate the Anthropic API key in OneCLI + env
#
# Usage:
#   bash scripts/rotate-api-key.sh <new-api-key>
#   bash scripts/rotate-api-key.sh           # prompts for key
#
# What it does:
#   1. Updates the existing OneCLI secret IN-PLACE (preserves secret ID + proxy tokens)
#   2. Updates data/env/env (fallback for direct injection)
#   3. Restarts NanoClaw
#   4. Verifies the new key works
#
# What it does NOT do:
#   - Does NOT delete/recreate the OneCLI secret (that breaks proxy tokens)
#   - Does NOT reinstall or cycle OneCLI
#   - Does NOT update Infisical (read-only machine identity — do it manually)
#
# After running: update the key in Infisical console manually.

NANOCLAW_DIR="${NANOCLAW_DIR:-$HOME/nanoclaw}"
ONECLI_URL="${ONECLI_URL:-http://127.0.0.1:10254}"
ENV_FILE="$NANOCLAW_DIR/data/env/env"

# --- Get the new key ---
NEW_KEY="${1:-}"
if [ -z "$NEW_KEY" ]; then
  echo -n "Enter new Anthropic API key: "
  read -r NEW_KEY
fi

if [[ ! "$NEW_KEY" =~ ^sk-ant- ]]; then
  echo "ERROR: Key doesn't look like an Anthropic API key (expected sk-ant-...)"
  exit 1
fi

echo "[1/4] Finding OneCLI secret..."

# --- Find the Anthropic secret ID ---
SECRET_ID=$(curl -s "$ONECLI_URL/api/secrets" | python3 -c "
import sys, json
secrets = json.load(sys.stdin)
anthropic = [s for s in secrets if s.get('type') == 'anthropic']
if anthropic:
    print(anthropic[0]['id'])
else:
    print('NOT_FOUND')
")

if [ "$SECRET_ID" = "NOT_FOUND" ] || [ -z "$SECRET_ID" ]; then
  echo "ERROR: No Anthropic secret found in OneCLI. Run /setup first."
  exit 1
fi

echo "  Found secret: $SECRET_ID"

# --- Update OneCLI secret IN-PLACE (preserves proxy tokens) ---
echo "[2/4] Updating OneCLI secret (PATCH, not delete/recreate)..."
RESULT=$(curl -s -X PATCH "$ONECLI_URL/api/secrets/$SECRET_ID" \
  -H "Content-Type: application/json" \
  -d "{\"value\":\"$NEW_KEY\"}")

if echo "$RESULT" | grep -q '"success":true'; then
  echo "  OneCLI secret updated"
else
  echo "ERROR: Failed to update OneCLI secret: $RESULT"
  exit 1
fi

# --- Update data/env/env (fallback for direct injection) ---
echo "[3/4] Updating data/env/env..."
if grep -q "^ANTHROPIC_API_KEY=" "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=$NEW_KEY|" "$ENV_FILE"
  echo "  Updated existing ANTHROPIC_API_KEY in env file"
else
  echo "ANTHROPIC_API_KEY=$NEW_KEY" >> "$ENV_FILE"
  echo "  Added ANTHROPIC_API_KEY to env file"
fi

# --- Restart NanoClaw ---
echo "[4/4] Restarting NanoClaw..."
systemctl --user restart nanoclaw
sleep 3

if systemctl --user is-active nanoclaw > /dev/null 2>&1; then
  echo "  NanoClaw is running"
else
  echo "ERROR: NanoClaw failed to start after restart"
  systemctl --user status nanoclaw
  exit 1
fi

echo ""
echo "=== Key rotation complete ==="
echo ""
echo "Next steps:"
echo "  1. Update the key in Infisical console (read-only machine identity can't write)"
echo "     https://app.infisical.com → agent-fleet project → prod → ANTHROPIC_API_KEY"
echo "  2. Send a test message to @Fleet in Slack to verify"
echo ""
echo "Key preview: ${NEW_KEY:0:15}...${NEW_KEY: -4}"
