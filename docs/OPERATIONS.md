# Operations Playbook

Reference for both human operators and Claude Code agents performing fleet DevOps tasks.
Terse and copy-paste-first. "Why" explained only where non-obvious.

---

## 1. Deploy Pipeline

### 5 AM Daily Cron

```bash
crontab -l
# 0 5 * * * /home/agentfleet/nanoclaw/deploy.sh >> /home/agentfleet/nanoclaw/logs/deploy.log 2>&1
```

The cron runs `deploy.sh` which:
1. Fetches origin/main and checks for new commits
2. If commits exist: pulls, runs `npm install` (if `package-lock.json` changed), runs `npm run build`
3. Rebuilds the agent container only if `container/` directory changed (Dockerfile, agent-runner, skills)
4. Restarts the nanoclaw systemd service

### Manual Deploy

```bash
cd ~/nanoclaw
git pull
npm run build
systemctl --user restart nanoclaw
```

### Container Rebuild vs Service Restart

Restart the service only (fast, ~2s):
- Config changes (`groups/`, `data/env/`, `.infisical.json`)
- TypeScript source changes (`src/`)
- Dependency changes (`package.json`)

Rebuild the container (slow, ~60s) — only needed if `container/` changed:
- `container/Dockerfile`
- `container/agent-runner` or `container/entrypoint.sh`
- `container/skills/` (skills loaded inside agent containers)

### Container Rebuild Command

```bash
cd ~/nanoclaw
./container/build.sh
systemctl --user restart nanoclaw
```

---

## 2. Credential Rotation

### Rotate Anthropic API Key

```bash
cd ~/nanoclaw
bash scripts/rotate-api-key.sh sk-ant-api03-YOUR-NEW-KEY-HERE
```

The script:
1. **PATCHes** the existing OneCLI secret (preserves secret ID + proxy tokens)
2. Updates `data/env/env` (fallback for direct injection)
3. Restarts NanoClaw
4. Verifies the service is running

After running: update the key in [Infisical console](https://app.infisical.com) manually (read-only machine identity can't write).

**CRITICAL: Never delete + recreate the OneCLI secret.** This invalidates the proxy access tokens (`aoc_...`) that NanoClaw uses to authenticate containers against OneCLI. PATCH updates the value while keeping the secret ID and all proxy tokens intact.

### Rotate Linear API Key

Linear uses direct injection (not OneCLI). Update in two places:

```bash
# 1. Update on server
sed -i 's|^LINEAR_API_KEY=.*|LINEAR_API_KEY=lin_api_NEW_KEY|' ~/nanoclaw/data/env/env
systemctl --user restart nanoclaw

# 2. Update in Infisical console
# https://app.infisical.com → agent-fleet → prod → LINEAR_API_KEY
```

### Rotate GitHub App Private Key

```bash
# 1. Download new .pem from GitHub App settings
# 2. SCP to server
scp -i ~/.ssh/id_ed25519_hetzner new-key.pem agentfleet@100.104.163.53:~/github-app-key.pem

# 3. Fix permissions and restart
ssh agentfleet@100.104.163.53 'chmod 600 ~/github-app-key.pem && systemctl --user restart nanoclaw'
```

### OneCLI Troubleshooting

If containers show "Invalid API key" after rotation:

```bash
# Verify OneCLI is running
docker ps --filter name=onecli

# Check the secret exists and has the right preview
curl -s http://localhost:10254/api/secrets | python3 -m json.tool

# Test the proxy directly
curl -s -x "http://127.0.0.1:10255" https://api.anthropic.com/v1/messages \
  -H "x-api-key: placeholder" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-sonnet-4-20250514","max_tokens":5,"messages":[{"role":"user","content":"hi"}]}'
```

If OneCLI was accidentally deleted/reinstalled: the proxy tokens are invalid. Fix:
```bash
# Reinstall OneCLI (generates new proxy infrastructure)
curl -fsSL onecli.sh/install | sh

# Recreate the secret
onecli secrets create --name Anthropic --type anthropic \
  --host-pattern=api.anthropic.com \
  --value="$(grep ANTHROPIC_API_KEY ~/nanoclaw/data/env/env | cut -d= -f2)"

# Restart NanoClaw (gets fresh proxy tokens from new OneCLI)
systemctl --user restart nanoclaw
```

---

## 3. Recovery Procedures

### Rollback a Bad Deploy

```bash
cd ~/nanoclaw
git log --oneline -5          # find last good commit hash
git revert HEAD               # creates a revert commit (safe)
# or for emergency hard reset:
git reset --hard <sha>
npm run build
systemctl --user restart nanoclaw
```

Prefer `git revert` over `git reset --hard` — it preserves history.

### `/update-nanoclaw` Merge Conflicts

If `git merge upstream/main` conflicts:

```bash
git merge --abort             # undo the merge entirely
git fetch upstream
git merge upstream/main       # retry after reviewing what changed
```

**Files to protect (keep our version during conflicts):**

| Path | Reason |
|------|--------|
| `groups/` | KICKOFF customization — Fleet persona, Slack channel configs |
| `container/skills/` | Custom skills loaded in agent containers |
| `deploy.sh` | Customized deploy logic |
| `data/env/env` | Our secrets/env config |
| `.claude/skills/` | Claude Code operator skills |
| `KICKOFF.md` | Our setup record |

For conflicts in these files: `git checkout --ours <path>`
For all other files: `git checkout --theirs <path>` (accept upstream)

After resolving:
```bash
git add .
git commit -m "chore: merge upstream/main"
```

### Broken Container

```bash
docker ps -a                           # check container status
docker logs <container-id>             # inspect error output
./container/build.sh --no-cache        # clean rebuild (bypasses build cache)
systemctl --user restart nanoclaw
```

If `--no-cache` still fails, prune buildkit cache first:
```bash
docker builder prune -f
./container/build.sh
```

### Restore from Scratch

1. SSH to server
2. `rm -rf ~/nanoclaw`
3. `git clone git@github.com:bryantb2/nanoclaw.git ~/nanoclaw`
4. Copy `groups/` config from backup or re-run KICKOFF setup (see `KICKOFF.md`)
5. `npm install && npm run build`
6. `./container/build.sh`
7. `systemctl --user start nanoclaw`

---

## 4. Fork Reconciliation

### Pull Upstream NanoClaw Updates

```bash
cd ~/nanoclaw
git fetch upstream
git merge upstream/main
```

Upstream remote: `https://github.com/nicepkg/nanoclaw` (set once during KICKOFF).

Check it's set:
```bash
git remote -v
# upstream  https://github.com/nicepkg/nanoclaw (fetch)
# origin    git@github.com:bryantb2/nanoclaw.git (push)
```

### Protected Customization Files

See table in Recovery Procedures above. These files diverge intentionally from upstream.
When `git merge` conflicts on them: `git checkout --ours <path>`.

### Testing After Merge

```bash
npm run build        # TypeScript must compile clean
npm test             # all tests must pass
systemctl --user restart nanoclaw
```

Then send a test message in Slack to verify Fleet responds.

If tests fail after merge: check upstream changelog for breaking API changes in `src/`.

---

## 5. Server Admin

### SSH Access

```bash
ssh -i ~/.ssh/id_ed25519_hetzner agentfleet@100.104.163.53
```

100.104.163.53 is the Tailscale IP (stable, survives server reboots). Use this over the public IP for day-to-day access.

From Windows:
```bash
ssh -i C:/Users/Blake/.ssh/id_ed25519_hetzner agentfleet@100.104.163.53
```

### Tailscale

```bash
tailscale status          # check connectivity and peer IPs
tailscale ip              # show this machine's Tailscale IP
```

Key expiry is disabled on this device — no 90-day lockout. If connectivity drops, check `tailscale status` from another device first.

### Infisical Secrets

```bash
# Verify secrets are injecting correctly
infisical run --env=prod --path=/ -- printenv | grep -E "SLACK|ANTHROPIC|LINEAR"

# Check token generation (token is generated at runtime, not stored)
cat ~/.bashrc | grep INFISICAL
```

Infisical project: `agent-fleet-mg-jq`, env: `prod`.
If `infisical run` fails with auth error: regenerate service token in Infisical console and update `INFISICAL_CLIENT_ID`/`INFISICAL_CLIENT_SECRET` in `~/.bashrc`.

### Disk Space

```bash
df -h                       # overall disk usage
docker system df            # Docker-specific usage
docker system prune -f      # remove stopped containers, unused images, dangling layers
```

Log rotation runs via cron (Sunday 3 AM). Manual cleanup if needed:
```bash
truncate -s 0 ~/nanoclaw/logs/deploy.log
```

### Logs

```bash
# nanoclaw service logs (live)
journalctl --user -u nanoclaw -f

# nanoclaw service logs (last 100 lines)
journalctl --user -u nanoclaw -n 100

# Per-group container logs
ls ~/nanoclaw/groups/*/logs/
cat ~/nanoclaw/groups/slack_*/logs/latest.log
```

### Systemd Service

```bash
systemctl --user status nanoclaw      # check if running
systemctl --user restart nanoclaw     # restart
systemctl --user stop nanoclaw        # stop
systemctl --user start nanoclaw       # start

# Verify linger is enabled (required for service to run without login session)
loginctl show-user agentfleet | grep Linger
# Linger=yes  <-- required
```

If linger is disabled: `loginctl enable-linger agentfleet`

### Container Inspection

```bash
docker ps                   # running containers (agent tasks)
docker stats                # live resource usage per container
docker logs <container-id>  # output from a specific agent run
```

Agent containers are ephemeral — they start per-task and exit when done. A stuck container (running >10 min) is likely hung; `docker kill <container-id>` is safe.
