---
phase: 02-core-agent
plan: "01"
subsystem: infra
tags: [slack, docker, linear, github, sqlite, ipc, cron, systemd]

requires:
  - phase: 01-setup
    provides: NanoClaw installed on server with Slack skill enabled

provides:
  - All 11 KICKOFF steps implemented on production server
  - Container memory limits (3 GB), queue ack, GitHub CLI, Linear MCP
  - Credential pass-through for ANTHROPIC_API_KEY, LINEAR_API_KEY, GITHUB_TOKEN
  - Git identity in containers, uploadFile IPC action, fleet-ops group
  - Nightly review cron (weekdays 6 PM Pacific), in_flight_tasks SQLite table
  - Fleet PM persona (replacing default Andy), markdown-to-mrkdwn conversion

affects: [03-integration-testing, linear-skill, github-mcp, fleet-ops]

tech-stack:
  added: [gh CLI, @anthropic-ai/linear-mcp-server, Slack files API (uploadFile)]
  patterns:
    - IPC action pattern for container-to-host file uploads
    - EnvironmentFile + wrapper script for systemd secret injection
    - GITHUB_TOKEN via JWT from GITHUB_APP_PRIVATE_KEY at container spawn time

key-files:
  created:
    - groups/global/CLAUDE.md (Fleet PM persona)
    - groups/fleet-ops/ (fleet-ops group directory)
  modified:
    - src/container-runner.ts (memory limits, credential pass-through, fleet-ops mounts)
    - src/ipc.ts (uploadFile IPC action)
    - src/index.ts (queue ack, in_flight_tasks, interrupted task notification)
    - src/db.ts (in_flight_tasks table)
    - src/task-scheduler.ts (nightly review cron)
    - src/router.ts (markdown-to-mrkdwn conversion)
    - container/Dockerfile (gh CLI install)
    - container/mcp-config.json (Linear MCP server)

key-decisions:
  - "Replaced Andy persona with Fleet PM — groups/global/CLAUDE.md rewritten to Fleet identity"
  - "LINEAR_API_KEY injected via EnvironmentFile + wrapper script (not passed directly in Dockerfile)"
  - "GITHUB_TOKEN generated at container spawn time via JWT from GITHUB_APP_PRIVATE_KEY"
  - "uploadFile IPC mounts /workspace/output/ on host at ~/nanoclaw/data/{group}/output/"
  - "Queue ack happens at NanoClaw level (index.ts), not inside agent container"

patterns-established:
  - "IPC actions: agent writes JSON to ipc.json, NanoClaw reads and dispatches"
  - "Credential injection: secrets from EnvironmentFile on host, passed as --env to docker run"
  - "Fleet-ops group: persistent /workspace/, read-only groups/ and data/sessions/ mounts"

requirements-completed: []

duration: 120min
completed: 2026-03-25
---

# Phase 02 Plan 01: KICKOFF Execution Summary

**All 11 KICKOFF steps implemented: container infra hardening, Linear/GitHub credential pass-through, uploadFile IPC, fleet-ops group, nightly cron, and interrupted task recovery — with Fleet PM persona and Slack mrkdwn conversion as post-KICKOFF fixes**

## Performance

- **Duration:** ~2 hours
- **Started:** 2026-03-25 (interactive session)
- **Completed:** 2026-03-25
- **Tasks:** 3 (+ post-KICKOFF fixes)
- **Files modified:** ~10

## Accomplishments

- NanoClaw deployed and running on production server with all Slack channels registered (main DM, dev-team, fleet-ops) and sender allowlist configured
- All 11 KICKOFF steps executed by Claude Code on server: memory limits, queue ack, gh CLI, Linear HTTP MCP, credential pass-through, git identity, uploadFile IPC, fleet-ops group, nightly cron, in_flight_tasks table
- Post-KICKOFF fixes applied: Fleet PM persona, Slack mrkdwn conversion, LINEAR_API_KEY systemd injection, stale session ID fix, GITHUB_APP_PRIVATE_KEY loader

## Task Commits

1. **Task 1: Initial Setup** - setup + add-slack skill execution (no commit, operational steps)
2. **Task 2: KICKOFF Steps 2-11** - `d1f09e3` (feat: execute KICKOFF steps 2-11)
3. **Task 3: Finalize and Commit** - service restarted, changes pushed

**Post-KICKOFF fix commits:**
- `d8f8c05` (fix: replace default Andy persona with Fleet PM instructions)
- `33a4553` (fix: convert GitHub markdown to Slack mrkdwn in outbound messages)

## Files Created/Modified

- `groups/global/CLAUDE.md` - Fleet PM system prompt (replaced Andy persona)
- `src/container-runner.ts` - Memory limits (3g), credential pass-through, fleet-ops mounts, output volume
- `src/ipc.ts` - uploadFile IPC action using Slack files.getUploadURLExternal + completeUploadExternal
- `src/index.ts` - Queue ack message, in_flight_tasks insert/delete on spawn/exit
- `src/db.ts` - in_flight_tasks table schema (id, group_folder, channel_id, thread_ts, original_message)
- `src/task-scheduler.ts` - Nightly review cron, weekdays 6 PM Pacific, fleet-ops group, max_budget_usd=5.00
- `src/router.ts` - GitHub markdown to Slack mrkdwn conversion (bold, code blocks, links)
- `container/Dockerfile` - gh CLI via official apt repository
- `container/mcp-config.json` - Linear MCP server (`npx -y @anthropic-ai/linear-mcp-server`)

## Decisions Made

- Fleet PM persona replaced the default Andy persona in groups/global/CLAUDE.md to match the agent fleet brand
- LINEAR_API_KEY required EnvironmentFile + wrapper script approach because systemd doesn't pass process.env secrets to child processes directly
- GITHUB_TOKEN is generated at container spawn time via JWT (Node.js, no external library) from GITHUB_APP_PRIVATE_KEY to avoid long-lived tokens
- Queue acknowledgment implemented at NanoClaw orchestrator level so users get immediate feedback without waiting for container startup
- Stale session IDs after session clear were fixed by regenerating session context on each container spawn

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed stale session IDs after session clear**
- **Found during:** Task 3 (post-KICKOFF testing)
- **Issue:** After clearing a session, the next container spawn reused the stale session ID, causing context bleed
- **Fix:** Session ID regenerated on each container spawn
- **Files modified:** src/container-runner.ts
- **Verification:** Tested via Slack — new session starts clean
- **Committed in:** d1f09e3

**2. [Rule 2 - Missing Critical] Added GITHUB_APP_PRIVATE_KEY loading via wrapper script**
- **Found during:** Task 3 (GitHub credential testing)
- **Issue:** GITHUB_APP_PRIVATE_KEY was not being loaded into the container spawn environment
- **Fix:** Wrapper script reads key from disk and injects into container --env at spawn time
- **Files modified:** src/container-runner.ts, start.sh
- **Verification:** GitHub token generation tested successfully
- **Committed in:** d1f09e3

---

**Total deviations:** 2 auto-fixed (1 bug, 1 missing critical)
**Impact on plan:** Both fixes required for correct credential handling. No scope creep.

## Issues Encountered

- LINEAR_API_KEY not in process.env due to systemd service not sourcing EnvironmentFile into child processes — resolved with wrapper script pattern
- Default Andy persona conflicted with Fleet branding — replaced with Fleet PM instructions in groups/global/CLAUDE.md

## Next Phase Readiness

- NanoClaw fully deployed with all KICKOFF features active
- Ready for T1-T13 validation in Plan 02-02
- File upload IPC implemented but needs real-world trigger test (deferred to T19 in Phase 3)

---
*Phase: 02-core-agent*
*Completed: 2026-03-25*
