---
name: peer-review
description: "Review someone else's code changes. Produces a report only, never edits files. Scope to a PR, branch, specific commits, or a local diff."
---

# Peer Review

Review code you did not write. Report only. Never edit files.

## Scope

Parse the user's request for what to review. Ask if unclear.

| Scope | How to get the diff |
|-------|---------------------|
| **PR** | `gh pr diff <number>` and `gh pr view <number> --json title,body` for context |
| **branch** | `git diff main...<branch>` (or whatever base the user specifies) |
| **commits** | `git diff <base>..<head>` or `git show <sha>` |
| **unstaged** | `git diff` |
| **unpushed** | `git diff @{u}..HEAD` (fall back to `origin/main..HEAD`) |

Always read the full diff first. For PRs, also read the title, description, and any existing review comments. Then ask the user what the purpose of the changes is. Use their answer as the primary lens for the review.

## Checks

After determining scope, present the list of checks and let the user pick which ones to run. If the user already specified checks in their request, use those without asking.

### 1. Correctness
Logic errors, off-by-one mistakes, race conditions, null/undefined hazards, unhandled error paths, broken edge cases. Trace the code paths mentally; do not assume it works because it looks plausible.

### 2. Intent vs Implementation
Does the code do what the PR/commit description claims? Are there requirements from the description that are missing from the diff? Is there scope creep (changes unrelated to the stated purpose)?

### 3. Duplication
New code that duplicates existing logic elsewhere in the codebase. Same pattern introduced in multiple places within the diff itself.

### 4. Typing and Type Safety
New `any` usage, unsafe assertions, missing annotations on public API surfaces, types that do not match the data they describe. Check that new types are consistent with existing ones and that validation schemas stay in sync.

### 5. Structure and Complexity
Functions or components that are too large or do too many things. Missing extractions. Deeply nested logic. High parameter counts. Changes that make an existing god component worse.

### 6. Risk Assessment
What could break in production? Backwards compatibility concerns. Migration safety. Performance implications. Security surface changes.

## Output

```
# Peer Review: [PR title / branch / commit description]

**Scope**: [what was reviewed]
**Files changed**: [count]
**Findings**: [count by severity]

## Summary
[2-3 sentences: what this change does, overall impression, biggest concerns]

## Findings

### Critical
[file:line, description, why it matters]

### High
[file:line, description, why it matters]

### Medium
[file:line, description, suggested improvement]

### Low
[file:line, description]

## What Looks Good
[Briefly note things done well. Keeps the review balanced.]

## Stats
| Check | Findings |
|-------|----------|
| ... | ... |
```

## Principles

- **Never edit files.** This is a report. Propose fixes in prose or small inline snippets within the report.
- Every finding references a specific file and line.
- Use absolute counts, not percentages.
- Distinguish between "must fix" (critical/high) and "consider" (medium/low). Do not treat everything as blocking.
- If existing review comments already cover an issue, do not repeat it. Note agreement briefly and move on.
- Check the full codebase for context when needed (e.g., verifying something is actually duplicated, or that a type exists elsewhere), but only report on the changed files.
