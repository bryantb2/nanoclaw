---
name: engineering
description: Use when writing production code, implementing features, or fixing bugs
---

# Engineering Skill

## When to Use
- Any coding task: new features, bug fixes, refactors

## Process
1. Read existing code to understand patterns and conventions
2. Create git worktree: git worktree add /workspace/{project}/task-{id} -b feature/{id}
3. Commit: initial worktree structure (chore: scaffold feature/{id})
4. Implement the change — commit after each logical unit (function, module, component)
5. Write tests alongside implementation — commit after tests are added
6. Run the test suite
7. Fix any failures — commit after tests pass
8. Report: files changed, test results, branch name

## Commit Checkpointing
Commit after every completed sub-step, not just at the end. If the container is
restarted or killed mid-task, the next session picks up from the last commit.
Each commit should be a meaningful checkpoint that could be resumed from.
Use conventional commit messages: feat:, fix:, chore:, test:, refactor:.

## Standards
- Follow existing code patterns in the project
- Type safety where the language supports it
- Error handling on all external calls
- No TODO comments without a ticket reference
