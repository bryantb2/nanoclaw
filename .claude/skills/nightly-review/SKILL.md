---
name: nightly-review
description: End-of-day review of all groups' work. Identifies improvements and proposes changes.
---

# Nightly Review Skill

## When to Use
- Triggered by the nightly scheduled task (3 AM Mountain Time, weekdays)
- Can also be triggered manually: "@Fleet run your nightly review"

## Budget
This session runs with max_budget_usd=$5.00 (set on the Agent SDK session, not in these instructions).
Plan your work within this budget:
- Phase 1 (Observe) + Phase 2 (Analyze): ~$0.50-1.00 (reading transcripts, comparing patterns)
- Phase 3 (Propose): ~$0.50 per CLAUDE.md patch, ~$1.50-2.00 per skill with autoresearch loop
- Phase 4 (Report): ~$0.25
- Budget for 1-2 autoresearch loops per night, not 3. Save the third proposal slot for low-cost patches.
- If you're running low on budget, skip autoresearch on lower-priority proposals and propose them as untested drafts — note this in the Slack report.
- The SDK will terminate this session if the budget is exceeded. Prioritize high-value proposals and run autoresearch only on the most impactful skills.

## Scope
- Read-only access to ALL groups' completed sessions from today
- Read the global CLAUDE.md and all group CLAUDE.md files
- Read all active skills

## Process

### Phase 1: Observe
1. Read today's session transcripts across all groups
2. Note: tasks that took unusually long, repeated patterns, failures, questions asked
3. Note: things that went well — fast completions, clean test runs, good delegation
4. Append observations to /workspace/extra/fleet-ops-staging/LEARNINGS.md with today's date

### Phase 2: Analyze
1. Compare today's patterns against LEARNINGS.md history
2. Identify recurring inefficiencies (same mistake twice = worth fixing)
3. Identify missing skills (if you keep doing X manually, write a skill for it)
4. Identify CLAUDE.md gaps (instructions that would have prevented mistakes)

### Phase 3: Propose (max 3 improvements per night)
For each proposal:
1. Write a clear description of the problem observed
2. Write the proposed fix (skill draft, CLAUDE.md amendment, or workflow change)
3. If it's a skill: write it to /workspace/extra/fleet-ops-staging/skills/staging/{name}/SKILL.md
4. If it's a CLAUDE.md patch: write it to /workspace/extra/fleet-ops-staging/adaptations/claude-patch.md
5. If it's a workflow change: write it to /workspace/extra/fleet-ops-staging/adaptations/proposals.md

### Phase 3b: Autoresearch Loop (for skill proposals only)
When a proposal is a new or modified skill, run the Karpathy autoresearch loop on it
before presenting it to the operator. This is based on github.com/karpathy/autoresearch
and github.com/olelehmann100kMRR/autoresearch-skill.

The core pattern: Modify → Evaluate → Keep or Discard → Repeat.

1. Define 3-5 binary eval criteria for the skill (pass/fail, not scores)
   Example for a code-review skill:
   - Does the output identify at least one real issue? (yes/no)
   - Does it avoid false positives on clean code? (yes/no)
   - Is the output under 500 words? (yes/no)
   - Does it categorize by severity? (yes/no)
2. Run the staged skill 5 times against representative test inputs
3. Score each run against the eval criteria → calculate baseline pass rate
4. Enter the loop (max 10 iterations per skill, max 30 minutes):
   a. Analyze which evals are failing most — read actual outputs that failed
   b. Form a hypothesis — ONE thing to change in SKILL.md
   c. Make the change (atomic — one mutation per iteration)
   d. Run the skill again against the same test inputs
   e. Score → compare to baseline
   f. If improved or equal: KEEP as new baseline, log the change
   g. If worse: DISCARD, revert SKILL.md to previous version
5. Write results to /workspace/extra/fleet-ops-staging/autoresearch/{skill-name}/results.jsonl
6. Include in the Slack report: starting pass rate, ending pass rate,
   changelog of mutations kept, and the final SKILL.md diff

Critical constraints:
- The agent CANNOT modify its own eval criteria during the loop
- The eval file is read-only once defined — this prevents gaming the metric
- One hypothesis per iteration — never change multiple things at once
- Git commits inside the container track each experiment for rollback

### Phase 4: Report
Post to Slack #fleet-ops:
- Summary of today's work across all groups (2-3 sentences)
- Key observations (what went well, what didn't)
- Proposed improvements with diffs
- For each proposal: what it fixes, expected impact, risk level (low/medium)
- For skill proposals: autoresearch results — starting pass rate → ending pass rate,
  number of iterations run, changelog of kept mutations

### Proposal Persistence
Before posting your report, save ALL proposal details to /workspace/extra/fleet-ops-staging/adaptations/proposals.md in a structured format:
- Number each proposal (Proposal #1, #2, #3)
- Include the full diff or content for each
- Include the type (skill, CLAUDE.md patch, workflow change)
- Include the target file path

This is CRITICAL: when the operator approves a proposal (e.g. "@Fleet approve proposal #1"), a NEW container spawns to handle it. That container reads proposals.md to know what to apply. If proposals.md is empty or missing, the approval cannot be fulfilled.

### Phase 5: Wait for Approval
- Do NOT apply changes until the operator approves in Slack
- On approval: create branch, promote changes, gh pr create, post PR link
- On rejection: note the rejection reason in /workspace/extra/fleet-ops-staging/LEARNINGS.md to avoid re-proposing

## Hard Boundaries
- NEVER modify NanoClaw source code (src/, container/, package.json)
- NEVER modify container configuration, mounts, or networking
- NEVER install external packages or download remote skills
- NEVER alter credentials, Infisical secrets, or authentication config
- NEVER apply changes without explicit operator approval
- NEVER write to external tools (GitHub, Linear) during analysis mode
  - GitHub CLI: read-only (gh pr list, gh pr view, gh issue list — no creates/edits)
  - Linear MCP: read-only (read tickets, list issues — no status updates/creates)
  - Exception: gh pr create + git push ONLY after explicit operator approval in Slack
- NEVER modify eval criteria during an autoresearch loop — evals are read-only once set
- Session budget is $5.00 (enforced by SDK). Plan work to fit within budget.
- Scope is limited to: CLAUDE.md content, skills/ files, workflow proposals
- Maximum 3 proposals per nightly run (avoid noise)
