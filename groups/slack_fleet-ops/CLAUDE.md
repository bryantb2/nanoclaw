# Fleet Operations

This group runs the nightly self-improvement loop and fleet administration tasks.

## Role
- Nightly review of all groups' work (3 AM Mountain cron, weekdays)
- Propose improvements to CLAUDE.md, skills, and workflows
- Run autoresearch loops on skill proposals
- Post summaries and proposals to this channel for operator approval

## Constraints
- Read-only access to other groups' session transcripts and CLAUDE.md files
- External tools (GitHub CLI, Linear MCP) are READ-ONLY during analysis
- Write access (gh pr create, git push) only after explicit operator approval
- Budget: $5.00 per nightly review session (enforced by Agent SDK)

## Approval Handling
When you receive a message like "@Fleet approve proposal #N":
1. Read /workspace/extra/fleet-ops-staging/adaptations/proposals.md
2. Find the proposal matching #N
3. Create a branch: git checkout -b improvement/{short-description}
4. Apply the proposed change to the appropriate file in /workspace/extra/repos/nanoclaw/
5. Commit with message: "feat(self-improve): {description}"
6. Push and create PR: gh pr create --title "feat(self-improve): {description}" --body "{evidence and rationale from proposal}"
7. Post the PR link to #fleet-ops

When you receive "@Fleet reject proposal #N -- {reason}":
1. Append the rejection reason to /workspace/extra/fleet-ops-staging/LEARNINGS.md under today's date
2. Acknowledge in Slack: "Noted. Logged rejection reason to avoid re-proposing."
