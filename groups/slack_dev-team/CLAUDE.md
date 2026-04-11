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
git checkout master && git pull origin master  # use main if that's the repo's default branch
```
Do this for whichever repo you're about to work on. Use the repo's default branch (`master` or `main`). If a prior session left uncommitted changes, stash or commit them first.

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

### Pre-Push Safety Check (MANDATORY before every `git push`)

Dev-team and qa-sentinel both have write access to overlapping forcify clones. If both agents push to the same branch, you get force-push races and lost commits. Before every push to an existing branch, run this check:

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)
git fetch origin "$BRANCH" 2>/dev/null || true

# If the branch exists on origin, verify local is a fast-forward over remote.
REMOTE_REF="origin/$BRANCH"
if git rev-parse --verify "$REMOTE_REF" >/dev/null 2>&1; then
  REMOTE_HEAD=$(git rev-parse "$REMOTE_REF")
  LOCAL_HEAD=$(git rev-parse HEAD)
  if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ] && ! git merge-base --is-ancestor "$REMOTE_HEAD" HEAD; then
    echo "[BLOCK] remote $BRANCH has moved since last fetch and local is NOT ahead"
    echo "Another agent (likely qa-sentinel or a previous dev-team session) pushed to this branch"
    echo "Either rebase on top or report collision to dispatch — do NOT force-push"
    # Inspect the remote commits you're missing
    git log --oneline "$LOCAL_HEAD..$REMOTE_HEAD"
    exit 1
  fi
fi
```

**If the check blocks:**
1. Read the remote commits (`git log $LOCAL_HEAD..$REMOTE_HEAD`). If they already solve your problem, skip the push and exit — your work is redundant.
2. If they don't solve your problem, `git pull --rebase origin $BRANCH` and resolve conflicts. Re-run the full test suite locally before retrying the push.
3. If you can't rebase cleanly (conflicting semantics, not just textual), write a `branch_collision` signal to the completion record and stop. Do NOT force-push to resolve it.

**Never use `git push --force` without human authorization.** Force-push rewrites history and erases another agent's work silently.

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
If CI fails, fix the issue and push. Then **re-run this polling loop from the beginning** to verify the fix. Do NOT leave a PR open with failing CI. Do NOT declare the task done until CI is green.

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

### 4. QA routing
Do NOT send IPC messages directly to QA. Dispatch handles all QA routing via its build loop — it reads your `pr_ready_for_review` signal from the completion record and routes to QA automatically. Set `has_ui_changes: true` in the signal payload so dispatch knows to request screenshots.

### 5. Post work summary to Slack (MANDATORY)

After ALL PRs are opened and CI is confirmed green, post a summary to #dev-team so operators can see what was done. This is not optional — without it, humans have no visibility into completed work.

**For dispatch-routed tasks:** Reply in the thread where the `[DISPATCH-ROUTED]` message arrived. Use `send_message` with the thread_ts of the dispatch message.

**For human-triggered tasks:** Reply in the thread where the human asked for the work.

**Format:**
```
Done. {N} PR(s) opened:

• KRE-{ID}: {title} — PR #{N} ({URL}) — CI: passing, {X} tests
• KRE-{ID}: {title} — PR #{N} ({URL}) — CI: passing, {X} tests

Completion record written. Dispatch build loop will route to QA.
```

**Never exit silently after completing work.** The completion record is for machines (dispatch reads it). The Slack summary is for humans (operators read it). Both are required.

## Noise Control

- **High-value messages (always post):** Work completed summary (step 5 above), blockers encountered, questions for operators, CI failure details
- **Low-value messages (suppress):** "Starting work...", "Reading codebase...", "Running tests...", intermediate progress updates. Do NOT post these to #dev-team. If you need an audit trail, write to `/workspace/output/` — operators don't need play-by-play.
- **Thread discipline:** Always reply in the thread that triggered your work. Never post channel-level messages for dispatch-routed tasks — the dispatch message IS your thread.

## Learned Context
(Fleet adds entries here as it learns about your codebase)
