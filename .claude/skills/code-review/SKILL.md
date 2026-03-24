---
name: code-review
description: Use when reviewing code for quality, security, and correctness
---

# Code Review Skill

## When to Use
- User asks for code review or QA
- After implementation, before PR creation

## Process
1. Read the changed files
2. Check for: missing error handling, security issues, edge cases
3. Verify test coverage
4. Check naming conventions and code style
5. Report: issue, severity (critical/high/medium/low), recommendation

## Quality Bar
- All public functions have error handling
- No hardcoded secrets or credentials
- Tests cover happy path + at least one error case
- No console.log/print statements in production code
