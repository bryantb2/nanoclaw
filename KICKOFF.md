# Agent Fleet Kickoff

Execute each step below in order. Report progress after each step.
Ask the operator if anything is unclear. Do not skip steps.

## Step 1: Infisical Integration
Update the systemd service file to start NanoClaw via the Infisical CLI:
- ExecStart should be: `infisical run --env=production --path=/ -- npm start`
- Remove EnvironmentFile from the service file — secrets come from Infisical, not .env.
- The Infisical CLI is already authenticated on this server via machine identity.

## Step 2: Container Memory Limits
Set a memory limit of 3 GB per spawned agent container (`--memory=3g --memory-swap=3g`).
Modify the container spawn logic in container-runner.ts (or equivalent).

## Step 3: Queue Acknowledgment
When a message arrives for a group that already has a running container,
immediately send a Slack reply: "Queued — I'm working on something else
in this channel. You're next." This should happen at the NanoClaw level
(index.ts or group-queue.ts), not inside the agent container.

## Step 4: GitHub CLI in Container
Add the GitHub CLI (gh) to the container Dockerfile using the official apt repository.
Rebuild the container image after modifying the Dockerfile.

## Step 5: Linear MCP Server
Add the Linear MCP server to the container's agent runner MCP config.
Use `npx -y @anthropic-ai/linear-mcp-server` with LINEAR_API_KEY from env.

## Step 6: Credential Pass-Through
Ensure ANTHROPIC_API_KEY and LINEAR_API_KEY from the NanoClaw process environment
are passed into spawned containers.

## Step 7: Git Identity in Containers
Add to the container Dockerfile or entrypoint:
```
git config --global user.name "Agent Fleet"
git config --global user.email "fleet@your-domain.com"
```

## Step 8: File Upload IPC
Add an "uploadFile" IPC action to ipc.ts. When the agent writes a JSON message
with action "uploadFile", NanoClaw should read the file from the container's
mounted output directory and upload it to Slack via files.getUploadURLExternal →
POST → files.completeUploadExternal. Support threading via thread_ts.

The IPC message format:
```json
{
  "action": "uploadFile",
  "filePath": "/workspace/output/report.pdf",
  "channelId": "C_CHANNEL_ID",
  "threadTs": "optional",
  "title": "Report title",
  "comment": "Brief summary"
}
```

Add /workspace/output/ mount to every container (host: ~/nanoclaw/data/{group}/output/).

## Step 9: Fleet-Ops Group
Create the fleet-ops group for the nightly self-improvement loop:
- Mount ~/nanoclaw/data/fleet-ops-staging/ as /workspace/ (read-write, persistent)
- Mount groups/ and data/sessions/ as read-only for cross-group analysis
- Tool restrictions are in the nightly-review SKILL.md, not infrastructure

## Step 10: Nightly Review Cron
Create a scheduled task: every weekday at 6 PM Pacific, run nightly-review skill
in fleet-ops group. Isolated session, max_budget_usd=5.00.

When spawning the fleet-ops nightly review container, pass max_budget_usd=5.00
to the Agent SDK session options.

## Step 11: Interrupted Task Notification
Add in_flight_tasks table to the SQLite database with columns:
- id (auto-increment)
- group_folder (text)
- channel_id (text)
- thread_ts (text)
- original_message (text)

When a container is spawned for a group, insert a row.
When the container exits cleanly, delete the row.

On startup (after Slack connection is established), query in_flight_tasks
for any remaining rows. For each row:
  - Post to the original Slack thread: "I was restarted while working on
    this. My progress is saved in the worktree — check git log on the
    feature branch to see what was committed. Reply @Fleet continue to
    resume, or re-send your original request."
  - Delete the row.
