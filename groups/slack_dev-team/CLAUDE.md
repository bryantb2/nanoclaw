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
node ace test --reporter=spec
```

If tests fail, fix them before pushing. If a test failure is pre-existing (not caused by your changes), note it in the PR description.

## Conventions
- All PRs require test coverage for new logic
- Commit style: conventional commits (feat/fix/chore/refactor/test/docs)
- PR description must include: what changed, why, how to test
- Branch naming: feature/LINEAR-{id} when from Linear tickets
- Never commit directly to main — always use a branch and PR

## Git Workflow
- Repos are in /workspace/extra/repos/{name}
- Use git credential helper at ~/github-credential-helper.sh for GitHub auth (generates fresh GitHub App tokens)
- Push branches and open PRs via GitHub API or gh CLI

## Learned Context
(Fleet adds entries here as it learns about your codebase)
