# Dev Team Context

## Projects

### Forcify
- Repo: /workspace/extra/repos/forcify
- Stack: AdonisJS 6 + Inertia.js + React (monolith, not separate backend/frontend)
- Testing: Japa v4 (@japa/runner) with @testing-library/react, sinon, global-jsdom
- CI: GitHub Actions (.github/workflows/ci.yml) — lint, typecheck, Japa unit tests with c8 coverage

### Chaos-Audit
- Repo: /workspace/extra/repos/Chaos-Audit
- Stack: [Blake fills in]
- Testing: [Blake fills in]

### predictabilityparadigm
- Repo: /workspace/extra/repos/predictabilityparadigm
- Stack: [Blake fills in]
- Testing: [Blake fills in]

### the-clarity-broadcast
- Repo: /workspace/extra/repos/the-clarity-broadcast
- Stack: [Blake fills in]
- Testing: [Blake fills in]

### cri-demo
- Repo: /workspace/extra/repos/cri-demo
- Stack: [Blake fills in]
- Testing: [Blake fills in]

### krewtrack-demo
- Repo: /workspace/extra/repos/krewtrack-demo
- Stack: [Blake fills in]
- Testing: [Blake fills in]

## Pre-PR Verification

Before opening a PR, run the project's test suite locally to catch issues early — this saves a round-trip through QA and avoids back-and-forth on fixable problems.

**Forcify (AdonisJS):**
```bash
source /app/start-postgres.sh
cd /workspace/extra/repos/forcify
npm ci --prefer-offline
node ace migration:run --env=test
node ace db:seed --env=test
node ace test --reporter=spec
```

If tests fail, fix them before pushing. If a test failure is pre-existing (not caused by your changes), note it in the PR description.

## Session Startup (Persistent Repos)

Repos are mounted from the host and persist across sessions. Before starting any work, sync to latest:
```bash
cd /workspace/extra/repos/forcify
git fetch origin
git checkout master && git pull origin master
```
Do this for whichever repo you're about to work on. If a prior session left uncommitted changes, stash or commit them first.

## Conventions
- All PRs require test coverage for new logic
- Commit style: conventional commits (feat/fix/chore/refactor/test/docs)
- PR description must include: what changed, why, how to test
- Branch naming: feature/LINEAR-{id} when from Linear tickets
- Never commit directly to main — always use a branch and PR
- **PR targeting:** Always target the repo's default branch (master/main). Never target a sibling feature branch.

## Git Workflow
- Repos are in /workspace/extra/repos/{name}
- Use git credential helper at ~/github-credential-helper.sh for GitHub auth (generates fresh GitHub App tokens)
- Push branches and open PRs via GitHub API or gh CLI

## Post-PR Protocol (MANDATORY)

After opening ANY PR with `gh pr create`, you MUST complete ALL of the following before declaring the task done. A PR is NOT done until CI passes.

### 1. Verify CI passes
```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)
for i in $(seq 1 30); do
  STATUS=$(gh run list --branch "$BRANCH" --limit 1 --json status,conclusion --jq '.[0].status' 2>/dev/null)
  if [ "$STATUS" = "completed" ]; then
    CONCLUSION=$(gh run list --branch "$BRANCH" --limit 1 --json conclusion --jq '.[0].conclusion' 2>/dev/null)
    if [ "$CONCLUSION" = "success" ]; then
      echo "CI passed"; break
    else
      echo "CI failed — investigate and fix"
      # Fix failures, push, restart poll
      break
    fi
  fi
  sleep 20
done
```
If CI fails, fix the issue and push. Do NOT leave a PR open with failing CI.

### 2. Post Linear PR comment
If working on a Linear ticket, post a comment to the ticket after the PR is open and CI is green:
```
Fleet opened PR #{N}: {PR_URL}
Branch: {BRANCH}
CI: passing
Tests: {X}/{Y} passed
```
Use the bot persona style (third-person, no emoji) per global CLAUDE.md Linear rules.

### 3. Write completion record
Write to `/workspace/output/latest.json` per the global CLAUDE.md schema. Include:
- `outputs[].type: "github_pr"` with the PR URL
- `cross_loop_signals` with `pr_ready_for_review` signal:
```json
{
  "cross_loop_signals": [{
    "signal_type": "pr_ready_for_review",
    "payload": {
      "pr_url": "{PR_URL}",
      "pr_number": {N},
      "branch": "{BRANCH}",
      "linear_ticket_id": "{TICKET_ID}",
      "ci_status": "passed",
      "has_ui_changes": true
    },
    "target_group": "dispatch"
  }]
}
```

### 4. QA handoff (UI PRs only)
For PRs with UI changes, write an IPC message to trigger QA:
```json
{
  "type": "message",
  "chatJid": "{QA_SENTINEL_CHANNEL_JID}",
  "text": "[DISPATCH-ROUTED] QA gate requested for PR #{N} ({PR_URL}). Branch: {BRANCH}. Linear: {TICKET_ID}. Validate UI changes, take screenshots, and post as PR comments with embedded images."
}
```
Write to `/workspace/ipc/messages/qa-handoff-{TIMESTAMP}.json` using the Write tool (NOT echo/bash).

## Learned Context
(Fleet adds entries here as it learns about your codebase)
