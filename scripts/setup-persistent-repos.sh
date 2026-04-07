#!/usr/bin/env bash
# setup-persistent-repos.sh — Create per-group persistent repo clones
#
# Run on the production server as the agentfleet user.
# Each group gets its own clone so containers can mount repos read-write
# without cross-container conflicts. Agent Teams worktrees stay within
# a single container's session, so no locking issues.
#
# Usage: bash scripts/setup-persistent-repos.sh

set -euo pipefail

REPOS_BASE="/home/agentfleet/repos"

# Groups that need repo access
GROUPS=("dev-team" "qa-sentinel")

# Repos to clone per group (org/repo format)
REPOS=(
  "Krewtrack/forcify"
  "bryantb2/Chaos-Audit"
  "bryantb2/predictabilityparadigm"
  "bryantb2/the-clarity-broadcast"
  "bryantb2/cri-demo"
  "bryantb2/krewtrack-demo"
)

echo "=== Setting up persistent per-group repos ==="
echo "Base: $REPOS_BASE"
echo ""

for group in "${GROUPS[@]}"; do
  GROUP_DIR="$REPOS_BASE/$group"
  echo "--- Group: $group ---"
  mkdir -p "$GROUP_DIR"

  for repo in "${REPOS[@]}"; do
    REPO_NAME=$(basename "$repo")
    REPO_DIR="$GROUP_DIR/$REPO_NAME"

    if [ -d "$REPO_DIR/.git" ]; then
      echo "  $REPO_NAME: exists, fetching latest..."
      cd "$REPO_DIR" && git fetch origin && cd - > /dev/null
    else
      echo "  $REPO_NAME: cloning..."
      gh repo clone "$repo" "$REPO_DIR" -- --depth=1
    fi
  done

  echo ""
done

echo "=== Done ==="
echo ""
echo "Next steps:"
echo "1. Update ~/.config/nanoclaw/mount-allowlist.json to include:"
echo '   { "path": "~/repos", "allowReadWrite": true, "description": "Per-group persistent repo clones" }'
echo ""
echo "2. Re-register groups with additionalMounts via the main group IPC."
echo "   Each group needs mounts like:"
echo '   { "hostPath": "~/repos/dev-team/forcify", "containerPath": "repos/forcify", "readonly": false }'
echo ""
echo "3. Restart NanoClaw: systemctl --user restart nanoclaw"
