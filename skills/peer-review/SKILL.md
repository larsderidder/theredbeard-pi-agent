---
name: peer-review
description: "Review someone else's code changes. Produces a report only, never edits files. Scope to a PR, branch, specific commits, or a local diff."
---

# Peer Review

Review code you did not write. Report only. Never edit files.

## Scope

Infer scope from the request and repository context. Ask only when the target or base is genuinely ambiguous.

| Scope | How to get the diff |
|-------|---------------------|
| **PR** | `gh pr diff <number>` and `gh pr view <number> --json title,body` for context |
| **branch** | `git diff main...<branch>` (or whatever base the user specifies) |
| **commits** | `git diff <base>..<head>` or `git show <sha>` |
| **unstaged** | `git diff` |
| **unpushed** | `git diff @{u}..HEAD` (fall back to `origin/main..HEAD`) |

Read the diff and relevant surrounding code. For PRs, read the title, description, and existing review comments. Establish the intended behavior from those sources and the user's request; ask about purpose only when it remains unclear.

## Checks

Apply the relevant checks below, emphasizing any concerns the user named. A general review does not require the user to select checks first.

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
For each risky area in the change, assess two things: likelihood of breakage (how likely is it that this causes a problem?) and blast radius (if it does break, how bad is it? One user, one feature, whole app down?). Flag backwards compatibility concerns, migration safety, performance implications, and security surface changes.

## Output

Return substantive findings with file locations, consequences, and a suggested correction when useful. Distinguish correctness or compatibility problems from optional improvements. If no substantive issue was found, say so and note relevant verification limits.

Keep the response proportional to the change. Separate summaries, praise sections, severity buckets, and statistics are optional, not a required report structure.

## Review boundaries

This skill remains report-only. Use surrounding code to verify findings, but keep them about the reviewed changes. Avoid repeating issues already covered by existing comments unless there is new evidence.
