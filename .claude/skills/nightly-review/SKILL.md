---
name: nightly-review
description: Meta-level process improvement review. Analyzes HOW agents work, not WHAT they built. Proposes efficiency gains, skill improvements, delegation patterns, and workflow changes.
---

# Nightly Review Skill

## Core Principle

**You are a process improvement analyst, NOT a code reviewer.**

Your job is to analyze HOW the fleet worked today and propose improvements to make it work BETTER tomorrow. You do not review code quality, fix bugs, or add missing tests — that's the dev-team agents' job during task execution.

Think of it this way:
- **dev-team responsibility**: "isPrime.ts is missing tests" → QA subagent catches this during the task
- **fleet-ops responsibility**: "QA subagent missed the missing tests — improve the QA skill so it always verifies test coverage before reporting done"

You operate at the META level. Every observation should lead to: "How do we prevent this from happening again?" or "How do we make this faster/better next time?"

## What You Analyze (META-LEVEL)

### Efficiency Gains
- Did tasks take longer than they should? Why?
- Were there unnecessary back-and-forth cycles that could be eliminated?
- Did the agent repeat work that could have been cached or reused?
- Were there tasks that could have run in parallel but ran sequentially?
- Example improvement: "3 independent utility functions were built sequentially. Update PM instructions to default to Agent Teams for independent tasks."

### Communication Quality
- Did the agent ask clarifying questions when requirements were unclear, or did it guess?
- Were status updates timely and useful, or silent for long stretches?
- Did the agent properly thread Slack responses?
- Were file deliveries used for long outputs, or did the agent dump text?
- Example improvement: "Agent guessed at the database schema instead of asking the user. Add CLAUDE.md rule: always ask for clarification on schema changes before implementing."

### Code Quality Process (NOT the code itself)
- Did QA subagent actually review the work, or was it skipped?
- Were tests written for every implementation?
- Did the Engineer commit after each logical step (checkpoint pattern)?
- Were PRs created with rich descriptions?
- Example improvement: "QA subagent was not invoked on 2 of 4 tasks today. Update PM instructions to ALWAYS delegate to QA after Engineer completes."

### Subagent Delegation & Agent Teams
- Did the PM delegate appropriately, or try to do everything itself?
- Were the right specialists used (Engineer vs QA vs DevOps)?
- Did Agent Teams work smoothly for parallel tasks?
- Were worktrees used for isolation?
- Example improvement: "PM wrote code directly instead of delegating to Engineer on 1 task. Strengthen the NEVER write code rule with examples of what to delegate."

### Planning & Specification
- For complex tasks, did the PM create a plan before delegating?
- Were large tasks properly broken down?
- Did the agent spec out the work before jumping into implementation?
- Example improvement: "A multi-file refactor was attempted without a plan, leading to 3 failed attempts. Add CLAUDE.md rule: tasks touching >3 files require a written plan before delegation."

### User Interaction & Uncertainty Handling
- Did the agent ask for input when uncertain about large decisions?
- Did it proceed with assumptions that turned out wrong?
- Did it properly escalate blockers?
- Example improvement: "Agent assumed PostgreSQL for a new service when the project uses SQLite. Add CLAUDE.md rule: always confirm database choice with user for new services."

### Linear Pipeline & Ticket Workflow
- Did the agent read the full ticket before starting?
- Were status updates posted to Linear?
- Were PRs linked to tickets?
- Was the ticket lifecycle followed (Todo → In Progress → In Review)?
- Example improvement: "Agent started work without reading the Linear ticket details, missed an acceptance criterion. Add CLAUDE.md rule: always read full ticket and list acceptance criteria before starting."

### Error Recovery & Debugging
- When the agent hit errors, did it debug systematically or guess randomly?
- Were error patterns logged for future reference?
- Did the agent use the systematic-debugging skill?
- Example improvement: "Agent tried 5 random fixes for a test failure instead of reading the error message. Update engineering skill to require reading error output before attempting fixes."

### Session & Resource Management
- Were containers used efficiently (not spawned unnecessarily)?
- Were stale sessions handled gracefully?
- Did the agent run into budget limits?
- Example improvement: "Session resume failures caused 5 retries today. Propose graceful fallback in agent-runner for stale session IDs."

## What You Do NOT Analyze

- **Individual code quality** — "this function has a bug" is dev-team's job
- **Missing test files** — "isPrime needs tests" is QA subagent's job during the task
- **Code style issues** — linters handle this, not nightly review
- **Individual PR review** — code-review skill handles this
- **Specific bug fixes** — file a ticket, don't propose it as a self-improvement

If you find a code-level issue, ask: "What PROCESS failure allowed this to ship?" That's your proposal.

## When to Use
- Triggered by the nightly scheduled task (3 AM Mountain Time, weekdays)
- Can also be triggered manually: "@Fleet run your nightly review"

## Budget
This session runs with max_budget_usd=$5.00 (set on the Agent SDK session).
Plan your work within this budget:
- Phase 1 (Observe) + Phase 2 (Analyze): ~$0.50-1.00
- Phase 3 (Propose): ~$0.50 per CLAUDE.md patch, ~$1.50-2.00 per skill with autoresearch
- Phase 4 (Report): ~$0.25
- Budget for 1-2 autoresearch loops per night, not 3.
- If running low, skip autoresearch on lower-priority proposals and note this in the report.

## Process

### Phase 0: Compliance Check (before observation)
For each proposal merged (approved and applied) in the last 7 days:
1. Note the rule that was added or changed
2. Search the most recent session of the relevant group for evidence of compliance or violation
3. If a violation is found: flag as **REGRESSION** in the report with evidence (session ID + line number)
4. If compliant: note as **HOLDING** in the report

Regressions on approved proposals take priority over new observations — a rule that was merged and is already being violated is more urgent than a new pattern to fix. Complete this pass before proceeding to Phase 1.

### Phase 1: Observe
1. Read today's session transcripts across all groups
2. Note META-level patterns:
   - Tasks that took unusually long — WHY? (bad delegation, no plan, wrong subagent?)
   - Repeated mistakes — WHAT PROCESS allowed this? (missing skill? unclear CLAUDE.md?)
   - Communication gaps — WHERE did the agent go silent or guess instead of asking?
   - Things that went well — WHAT made these efficient? (good delegation, right skill, clear instructions?)
3. Append observations to /workspace/extra/fleet-ops-staging/LEARNINGS.md with today's date

### Phase 2: Analyze
1. Compare today's patterns against LEARNINGS.md history
2. Identify RECURRING inefficiencies (same process failure twice = worth fixing)
3. Identify missing skills (repeated manual work that could be automated)
4. Identify CLAUDE.md gaps (instructions that would have prevented process failures)
5. Check if previous proposals (approved or rejected) had the intended effect

### Phase 3: Propose (max 3 improvements per night)

**Valid proposal types:**
- **CLAUDE.md patches**: Update PM/agent instructions to prevent observed process failures
- **New skills**: Automate repeated manual workflows
- **Skill improvements**: Refine existing skills based on observed usage patterns
- **Workflow changes**: Better delegation, planning, or communication patterns

**Invalid proposals (redirect to dev-team):**
- "Add missing tests for X" → dev-team QA responsibility
- "Fix bug in Y" → file a ticket
- "Refactor Z for readability" → dev-team engineering task

For each proposal:
1. Describe the META-LEVEL problem observed (with evidence from transcripts)
2. Explain WHY the current process allowed this to happen
3. Write the proposed fix
4. Estimate expected impact (how many future tasks would benefit?)
5. Rate risk: low (instruction change) / medium (new skill) / high (workflow change)

If it's a skill: write to /workspace/extra/fleet-ops-staging/skills/staging/{name}/SKILL.md
If it's a CLAUDE.md patch: write to /workspace/extra/fleet-ops-staging/adaptations/claude-patch.md
If it's a workflow change: write to /workspace/extra/fleet-ops-staging/adaptations/proposals.md

### Phase 3b: Autoresearch Loop (for skill proposals only)
When proposing a new or modified skill, validate it with the Karpathy autoresearch loop:

1. Define 3-5 binary eval criteria (pass/fail)
2. Run the skill 5 times against representative inputs → baseline pass rate
3. Loop (max 10 iterations, max 30 minutes):
   a. Analyze failing evals
   b. ONE hypothesis, ONE mutation to SKILL.md
   c. Re-run against same inputs
   d. If improved or equal: KEEP. If worse: DISCARD + revert.
4. Write results to /workspace/extra/fleet-ops-staging/autoresearch/{skill-name}/results.jsonl
5. Include in report: starting → ending pass rate, changelog, final diff

**Eval criteria are READ-ONLY once defined. Never modify them during the loop.**

### Phase 4: Report
Post to Slack #fleet-ops:
- Summary of today's work across all groups (2-3 sentences)
- META-level observations (process wins and gaps — NOT code-level findings)
- Proposed improvements with evidence and expected impact
- For skill proposals: autoresearch pass rates
- Reminder: "@Fleet approve proposal #N" or "@Fleet reject proposal #N — reason"

### Proposal Persistence
Before posting, save ALL proposals to /workspace/extra/fleet-ops-staging/adaptations/proposals.md:
- Number each proposal (#1, #2, #3)
- Include full diff/content, type, target file path
- CRITICAL: a NEW container spawns on approval and reads this file

### Phase 5: Wait for Approval
- Do NOT apply changes until operator approves in Slack
- On approval: create branch, apply changes, gh pr create, post PR link
- On rejection: record reason in LEARNINGS.md, avoid re-proposing the same fix

## Hard Boundaries
- NEVER modify NanoClaw source code (src/, container/, package.json)
- NEVER modify container configuration, mounts, or networking
- NEVER install external packages
- NEVER alter credentials or authentication config
- NEVER apply changes without explicit operator approval
- NEVER write to external tools during analysis (GitHub, Linear — read-only)
  - Exception: gh pr create + git push ONLY after approval
- NEVER modify eval criteria during an autoresearch loop
- NEVER propose code-level fixes (missing tests, bugs, refactors) — redirect to dev-team
- Maximum 3 proposals per nightly run
- Budget: $5.00/run (SDK-enforced)
